# telegram_bot.py
# Bot automático: busca produtos via Shopee Affiliate (GraphQL) e envia para Telegram
# - Testa listType 0,1,2
# - DEFAULT_LIMIT = 10
# - Fallback para API pública de busca se afiliada não trouxer ofertas
# - Envia alertas para ALERT_CHAT_ID (se definido) ou TELEGRAM_CHAT_ID
# Autor: ChatGPT (ajuste para Karolyna)

import os
import time
import json
import hashlib
import requests
from typing import List, Dict, Tuple

# -------- Configs (strip) --------
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
# TELEGRAM_CHAT_ID: destino principal (normalmente o grupo)
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
# ALERT_CHAT_ID: onde serão enviados alertas; se vazio, alertas vão para TELEGRAM_CHAT_ID
ALERT_CHAT_ID = os.getenv("ALERT_CHAT_ID", "").strip() or TELEGRAM_CHAT_ID

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

SHOPEE_APP_ID = os.getenv("SHOPEE_APP_ID", "").strip()
SHOPEE_APP_SECRET = os.getenv("SHOPEE_APP_SECRET", "").strip()
SHOPEE_KEYWORDS = os.getenv("SHOPEE_KEYWORDS", "celular;fones;tv").strip()
SHOPEE_AFFILIATE_URL = os.getenv("SHOPEE_AFFILIATE_URL", "https://open-api.affiliate.shopee.com.br/graphql").strip()
SHOPEE_MATCH_ID = os.getenv("SHOPEE_MATCH_ID", "").strip()

SENT_STORE = "sent_offers.json"

# sanity checks
if not BOT_TOKEN or not TELEGRAM_CHAT_ID:
    raise SystemExit("ERRO: Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nos Secrets do repositório.")
if not SHOPEE_APP_ID or not SHOPEE_APP_SECRET:
    raise SystemExit("ERRO: Defina SHOPEE_APP_ID e SHOPEE_APP_SECRET nos Secrets do repositório.")

# -------- Helpers de arquivo (histórico) --------
def load_sent_ids() -> set:
    try:
        with open(SENT_STORE, "r", encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:
        return set()

def save_sent_ids(ids: set):
    try:
        with open(SENT_STORE, "w", encoding="utf-8") as f:
            json.dump(list(ids), f, ensure_ascii=False, indent=2)
    except Exception:
        pass

# -------- Telegram helpers --------
def send_photo(chat_id: str, photo_url: str, caption: str) -> Dict:
    url = f"{TELEGRAM_API}/sendPhoto"
    data = {"chat_id": chat_id, "photo": photo_url, "caption": caption, "parse_mode": "HTML"}
    try:
        r = requests.post(url, data=data, timeout=20)
        try:
            return r.json()
        except Exception:
            return {"ok": False, "error": "invalid-json-response", "status_code": r.status_code, "text": r.text}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def send_message(chat_id: str, text: str) -> Dict:
    url = f"{TELEGRAM_API}/sendMessage"
    data = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": False}
    try:
        r = requests.post(url, data=data, timeout=20)
        try:
            return r.json()
        except Exception:
            return {"ok": False, "error": "invalid-json-response", "status_code": r.status_code, "text": r.text}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def format_caption(offer: Dict) -> str:
    title = offer.get("title", "") or ""
    price = offer.get("price", "") or ""
    url = offer.get("url", "") or ""
    return f"<b>{title}</b>\n{price}\n<a href=\"{url}\">Ver oferta</a>"

# -------- GraphQL query (compatible) --------
GRAPHQL_QUERY = """
query productOfferV2Query($keyword: String, $limit: Int, $listType: Int, $matchId: Int64, $sortType: Int, $page: Int) {
  productOfferV2(keyword: $keyword, limit: $limit, listType: $listType, matchId: $matchId, sortType: $sortType, page: $page) {
    nodes {
      itemId
      productName
      productLink
      imageUrl
      shopId
      productCatIds
    }
    pageInfo { hasNextPage }
  }
}
"""

# -------- assinatura / envio com timestamps candidatos --------
def build_signature(app_id: str, app_secret: str, payload_bytes: bytes, ts: str) -> str:
    to_sign = app_id.encode("utf-8") + ts.encode("utf-8") + payload_bytes + app_secret.encode("utf-8")
    return hashlib.sha256(to_sign).hexdigest()

def post_graphql_signed_with_timestamp_candidates(url: str, payload: dict, app_id: str, app_secret: str, offsets = [-3, -2, -1, 0, 1, 2, 3]) -> requests.Response:
    payload_str = json.dumps(payload, separators=(',', ':'), ensure_ascii=False)
    payload_bytes = payload_str.encode("utf-8")
    base_ts_int = int(time.time())
    last_exception = None
    for off in offsets:
        ts = str(base_ts_int + int(off))
        signature = build_signature(app_id, app_secret, payload_bytes, ts)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"SHA256 Credential={app_id}, Timestamp={ts}, Signature={signature}"
        }
        print(f"DEBUG: POST GraphQL attempt ts={ts} (offset={off}), payload bytes={len(payload_bytes)}, sig-prefix={signature[:6]}")
        try:
            resp = requests.post(url, headers=headers, data=payload_bytes, timeout=30)
            return resp
        except Exception as e:
            print("DEBUG: exception sending request with ts", ts, e)
            last_exception = e
            continue
    if last_exception:
        raise last_exception
    return None

# -------- Fallback: public search endpoint --------
def fetch_from_shopee_public(keywords: List[str], max_per_kw: int = 10) -> List[Dict]:
    offers = []
    headers = {"User-Agent": "Mozilla/5.0"}
    for kw in keywords:
        try:
            kw_encoded = requests.utils.requote_uri(kw)
            url = f"https://shopee.com.br/api/v4/search/search_items?by=sales&keyword={kw_encoded}&limit={max_per_kw}&order=desc&page_type=search"
            resp = requests.get(url, headers=headers, timeout=15)
            data = resp.json() if resp is not None else {}
            items = data.get("items", []) if isinstance(data, dict) else []
            print(f"DEBUG fallback: found {len(items)} public items for '{kw}'")
            for it in items:
                b = it.get("item_basic", {})
                shopid = b.get("shopid")
                itemid = b.get("itemid")
                name = b.get("name","")
                image = b.get("image")
                price = None
                try:
                    price = int(b.get("price", 0)) / 100000
                except Exception:
                    price = 0
                url_item = f"https://shopee.com.br/product/{shopid}/{itemid}" if shopid and itemid else ""
                img_url = f"https://down-br.img.susercontent.com/file/{image}" if image else ""
                offers.append({
                    "id": f"pub-{shopid}-{itemid}",
                    "title": name,
                    "price": f"R$ {price:.2f}",
                    "url": url_item,
                    "image_url": img_url
                })
        except Exception as e:
            print("DEBUG: fallback public search error for", kw, e)
        time.sleep(0.6)
    return offers

# -------- Busca via GraphQL com listType testing e melhorias --------
def fetch_from_shopee_affiliate(keywords: List[str]) -> Tuple[List[Dict], List[Dict]]:
    offers = []
    details = []

    DEFAULT_LIMIT = 10
    DEFAULT_LISTTYPES = [0, 1, 2]
    DEFAULT_SORT = 2
    MAX_KEYWORDS = 3

    keywords_to_test = [k.strip() for k in keywords if k.strip()][:MAX_KEYWORDS]
    print("DEBUG: keywords_to_test =", keywords_to_test)

    for kw in keywords_to_test:
        for list_type in DEFAULT_LISTTYPES:
            detail = {"keyword": kw, "listType": list_type, "nodes_count": 0, "errors": None, "resp_text_preview": ""}
            try:
                variables = {
                    "keyword": kw,
                    "limit": DEFAULT_LIMIT,
                    "listType": list_type,
                    "sortType": DEFAULT_SORT,
                    "page": 1
                }
                if SHOPEE_MATCH_ID and SHOPEE_MATCH_ID.isdigit():
                    variables["matchId"] = int(SHOPEE_MATCH_ID)

                payload = {"query": GRAPHQL_QUERY, "variables": variables}
                print("DEBUG: enviando GraphQL para:", SHOPEE_AFFILIATE_URL)
                print("DEBUG: variables (preview):", variables)

                resp_raw = post_graphql_signed_with_timestamp_candidates(SHOPEE_AFFILIATE_URL, payload, str(SHOPEE_APP_ID), str(SHOPEE_APP_SECRET))
                print("DEBUG Shopee afiliada status:", resp_raw.status_code)

                try:
                    resp = resp_raw.json()
                except Exception as e:
                    detail["errors"] = f"invalid-json: {e}"
                    detail["resp_text_preview"] = resp_raw.text[:4000]
                    print("DEBUG: resposta não é JSON:", e)
                    print("DEBUG text (first 4000 chars):", resp_raw.text[:4000])
                    details.append(detail)
                    continue

                if isinstance(resp, dict) and resp.get("errors"):
                    detail["errors"] = resp.get("errors")
                    detail["resp_text_preview"] = resp_raw.text[:4000]
                    print("DEBUG GraphQL errors:", resp.get("errors"))
                    print("DEBUG resp text (first 4000 chars):", resp_raw.text[:4000])
                    details.append(detail)
                    continue

                nodes = []
                try:
                    data = resp.get("data", {}) if isinstance(resp, dict) else {}
                    pov = data.get("productOfferV2")
                    if pov and isinstance(pov, dict) and isinstance(pov.get("nodes"), list):
                        nodes = pov.get("nodes")
                    else:
                        for v in (data.values() if isinstance(data, dict) else []):
                            if isinstance(v, list):
                                nodes = v
                                break
                except Exception as e:
                    print("DEBUG erro ao localizar nodes:", e)

                print(f"DEBUG: encontrados {len(nodes)} nodes para keyword '{kw}' listType={list_type}")
                detail["nodes_count"] = len(nodes)
                detail["resp_text_preview"] = json.dumps(resp, ensure_ascii=False)[:4000] if isinstance(resp, dict) else str(resp)[:4000]

                if not nodes:
                    print("DEBUG resp JSON (no nodes):", detail["resp_text_preview"])

                for item in nodes:
                    try:
                        pid = item.get("itemId") or item.get("productId") or item.get("id") or str(item.get("itemId", ""))
                        title = item.get("productName") or item.get("product_name") or item.get("name") or ""
                        url_item = item.get("productLink") or item.get("product_link") or item.get("productUrl") or ""
                        img = (
                            item.get("imageUrl") or
                            item.get("image_url") or
                            item.get("image") or
                            (item.get("thumbnail") if isinstance(item.get("thumbnail"), str) else "")
                        )
                        price_str = "R$ 0,00"
                        if isinstance(item.get("price"), (int, float)):
                            price_str = f"R$ {float(item.get('price')):.2f}"
                        elif isinstance(item.get("min_price"), (int, float)):
                            price_str = f"R$ {float(item.get('min_price')):.2f}"
                        elif isinstance(item.get("price"), dict):
                            price_str = item["price"].get("price_text") or item["price"].get("price_str") or price_str

                        offers.append({
                            "id": str(pid),
                            "title": title,
                            "price": price_str,
                            "url": url_item,
                            "image_url": img
                        })
                    except Exception as e:
                        print("DEBUG: falha ao mapear item:", e)

                details.append(detail)
                time.sleep(0.6)

            except Exception as e:
                detail["errors"] = str(e)
                details.append(detail)
                print("Erro ao buscar produtos (exc):", e)

    return offers, details

# -------- Alerta se falha generalizada (usa ALERT_CHAT_ID) --------
def send_failure_alert(details: List[Dict], alert_chat_id: str = ALERT_CHAT_ID):
    any_nodes = any(d.get("nodes_count", 0) > 0 for d in details)
    if any_nodes:
        return

    ts = int(time.time())
    summary_lines = []
    for d in details:
        summary_lines.append(f"{d.get('keyword')} (listType={d.get('listType')}): nodes={d.get('nodes_count',0)}, errors={'sim' if d.get('errors') else 'não'}")
    text = "<b>⚠️ Alerta do bot de ofertas</b>\n"
    text += f"Todas as combinações testadas retornaram 0 ou erros.\nTimestamp: {ts}\n\nResumo:\n"
    text += "\n".join(summary_lines)
    last_preview = ""
    for d in reversed(details):
        if d.get("resp_text_preview"):
            last_preview = d["resp_text_preview"]
            break
    if last_preview:
        text += "\n\nÚltima resposta (preview):\n"
        text += (last_preview[:3500] + "...") if len(last_preview) > 3500 else last_preview

    try:
        resp = send_message(alert_chat_id, text)
        print("DEBUG: alerta enviado, resp:", resp)
    except Exception as e:
        print("DEBUG: falha ao enviar alerta:", e)

# -------- Execução principal --------
def main():
    sent = load_sent_ids()
    new_sent = set(sent)
    keywords = [k.strip() for k in SHOPEE_KEYWORDS.split(";") if k.strip()]
    print("DEBUG: keywords (all) =", keywords)

    offers, details = fetch_from_shopee_affiliate(keywords)

    # if affiliate returned nothing, try fallback public search
    if not offers:
        print("DEBUG: afiliada não trouxe ofertas — tentando fallback público...")
        fallback_offers = fetch_from_shopee_public(keywords, max_per_kw=10)
        if fallback_offers:
            offers = fallback_offers
            print("DEBUG: fallback público trouxe", len(offers), "ofertas")
        else:
            print("DEBUG: fallback público não trouxe ofertas")

    # if still nothing useful, send alert (private)
    send_failure_alert(details, alert_chat_id=ALERT_CHAT_ID)

    sent_this_run = []
    if not offers:
        print("DEBUG: Nenhuma oferta retornada (afiliada + fallback).")

    for offer in offers:
        oid = offer.get("id")
        if not oid:
            continue
        if oid in sent:
            continue

        caption = format_caption(offer)

        resp = send_photo(TELEGRAM_CHAT_ID, offer.get("image_url") or "", caption)
        if resp.get("ok"):
            print("✅ Enviado (foto):", offer.get("title"))
            new_sent.add(oid)
            sent_this_run.append(offer)
            time.sleep(1.5)
            continue

        print("❌ Falha ao enviar foto:", resp)
        fallback_text = f"{offer.get('title')}\n{offer.get('price')}\n{offer.get('url')}\n\n(Imagem não enviada — link acima)"
        resp_msg = send_message(TELEGRAM_CHAT_ID, fallback_text)
        if resp_msg.get("ok"):
            print("✅ Enviado (fallback texto):", offer.get("title"))
            new_sent.add(oid)
            sent_this_run.append(offer)
        else:
            print("❌ Falha ao enviar fallback texto:", resp_msg)

        time.sleep(1.5)

    save_sent_ids(new_sent)

    try:
        with open("new_offers.json", "w", encoding="utf-8") as f:
            json.dump(sent_this_run, f, ensure_ascii=False, indent=2)
        print("Arquivo new_offers.json criado com", len(sent_this_run), "ofertas.")
    except Exception as e:
        print("Erro ao gravar new_offers.json:", e)

if __name__ == "__main__":
    main()
