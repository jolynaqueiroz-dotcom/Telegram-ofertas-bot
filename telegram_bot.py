# telegram_bot.py
# Versão com retry de timestamp para evitar Invalid Signature/System Error
import os
import time
import json
import hashlib
import requests
from typing import List, Dict

# Configs (strip)
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

SHOPEE_APP_ID = os.getenv("SHOPEE_APP_ID", "").strip()
SHOPEE_APP_SECRET = os.getenv("SHOPEE_APP_SECRET", "").strip()
SHOPEE_KEYWORDS = os.getenv("SHOPEE_KEYWORDS", "celular").strip()
SHOPEE_AFFILIATE_URL = os.getenv("SHOPEE_AFFILIATE_URL", "https://open-api.affiliate.shopee.com.br/graphql").strip()
SHOPEE_MATCH_ID = os.getenv("SHOPEE_MATCH_ID", "").strip()

SENT_STORE = "sent_offers.json"

if not BOT_TOKEN or not CHAT_ID:
    raise SystemExit("ERRO: Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nas Secrets.")
if not SHOPEE_APP_ID or not SHOPEE_APP_SECRET:
    raise SystemExit("ERRO: Defina SHOPEE_APP_ID e SHOPEE_APP_SECRET nas Secrets.")

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

# Minimal productOfferV2 query (fields that are safe)
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

def build_signature(app_id: str, app_secret: str, payload_bytes: bytes, ts: str) -> str:
    to_sign = app_id.encode("utf-8") + ts.encode("utf-8") + payload_bytes + app_secret.encode("utf-8")
    return hashlib.sha256(to_sign).hexdigest()

def post_graphql_signed_with_timestamp_candidates(url: str, payload: dict, app_id: str, app_secret: str, offsets = [-3, -2, -1, 0, 1, 2, 3]) -> requests.Response:
    """
    Tenta enviar o mesmo payload com timestamps deslocados pela lista offsets (segundos).
    Retorna a primeira resposta HTTP que não seja erro de conexão.
    """
    # compact payload string and bytes (must be same used for signing and sending)
    payload_str = json.dumps(payload, separators=(',', ':'), ensure_ascii=False)
    payload_bytes = payload_str.encode("utf-8")

    # current base timestamp
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
            # always return the response object to inspect status and body
            return resp
        except Exception as e:
            print("DEBUG: exception sending request with ts", ts, e)
            last_exception = e
            continue
    # if all attempts failed at network level, raise the last exception
    if last_exception:
        raise last_exception
    # fallback (shouldn't reach here)
    return None

def fetch_from_shopee_affiliate(keywords: List[str]) -> List[Dict]:
    offers = []
    DEFAULT_LIMIT = 1   # start tiny to reduce server load and test
    DEFAULT_LISTTYPE = 0
    DEFAULT_SORT = 2

    for kw in keywords:
        try:
            variables = {
                "keyword": kw,
                "limit": DEFAULT_LIMIT,
                "listType": DEFAULT_LISTTYPE,
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
            # try parse json
            try:
                resp = resp_raw.json()
            except Exception as e:
                print("DEBUG: resposta não é JSON:", e)
                print("DEBUG text (first 1200 chars):", resp_raw.text[:1200])
                continue

            # if GraphQL errors exist, print full errors and full text (first 1200 chars)
            if isinstance(resp, dict) and resp.get("errors"):
                print("DEBUG GraphQL errors:", resp.get("errors"))
                print("DEBUG resp text (first 1200 chars):", resp_raw.text[:1200])
                # if system error, try with different listType or later
                # continue to next keyword
                continue

            # parse nodes
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

            print(f"DEBUG: encontrados {len(nodes)} nodes para keyword '{kw}'")

            for item in nodes:
                try:
                    pid = item.get("itemId") or item.get("productId") or str(item.get("itemId", ""))
                    title = item.get("productName") or item.get("product_name") or item.get("name") or ""
                    url_item = item.get("productLink") or item.get("product_link") or item.get("productUrl") or ""
                    img = item.get("imageUrl") or item.get("image_url") or item.get("image") or ""
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

            time.sleep(0.6)

        except Exception as e:
            print("Erro ao buscar produtos (exc):", e)

    return offers

def main():
    sent = load_sent_ids()
    new_sent = set(sent)
    keywords = [k.strip() for k in SHOPEE_KEYWORDS.split(";") if k.strip()]
    print("DEBUG: keywords =", keywords)

    offers = fetch_from_shopee_affiliate(keywords)
    sent_this_run = []

    if not offers:
        print("DEBUG: Nenhuma oferta retornada pela API de afiliada.")

    for offer in offers:
        oid = offer.get("id")
        if not oid:
            continue
        if oid in sent:
            continue
        caption = format_caption(offer)
        resp = send_photo(CHAT_ID, offer.get("image_url") or "", caption)
        if resp.get("ok"):
            print("✅ Enviado (foto):", offer.get("title"))
            new_sent.add(oid)
            sent_this_run.append(offer)
            time.sleep(1.5)
            continue
        print("❌ Falha ao enviar foto:", resp)
        fallback_text = f"{offer.get('title')}\n{offer.get('price')}\n{offer.get('url')}\n\n(Imagem não enviada — link acima)"
        resp_msg = send_message(CHAT_ID, fallback_text)
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
