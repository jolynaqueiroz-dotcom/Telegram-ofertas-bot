# telegram_bot.py
# Bot automático: busca produtos via Shopee Affiliate (GraphQL) e envia para Telegram
# Corrigido: remove app_id da query, usa matchId Int64, campos corretos, assinatura SHA256
# Autor: ChatGPT (ajuste para Karolyna)

import os
import time
import json
import hashlib
import requests
from typing import List, Dict

# -------- Configs (lidas de Secrets) - strip() para evitar espaços extras --------
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
    raise SystemExit("ERRO: Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nas Secrets do repositório.")
if not SHOPEE_APP_ID or not SHOPEE_APP_SECRET:
    raise SystemExit("ERRO: Defina SHOPEE_APP_ID e SHOPEE_APP_SECRET nas Secrets do repositório.")

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

# -------- Telegram helpers (robustos) --------
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

# -------- GraphQL query (productOfferV2) - corrected fields and matchId Int64 --------
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
      # if price object exists it will be handled in parser
    }
    pageInfo {
      hasNextPage
    }
  }
}
"""

# -------- Função para enviar GraphQL assinada (assina e envia o mesmo payload bytes) --------
def post_graphql_signed(url: str, payload: dict, app_id: str, app_secret: str) -> requests.Response:
    # compact JSON string (no spaces) — important for signature consistency
    payload_str = json.dumps(payload, separators=(',', ':'), ensure_ascii=False)
    payload_bytes = payload_str.encode("utf-8")

    timestamp = str(int(time.time()))
    to_sign = app_id.encode("utf-8") + timestamp.encode("utf-8") + payload_bytes + app_secret.encode("utf-8")
    signature = hashlib.sha256(to_sign).hexdigest()

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"SHA256 Credential={app_id}, Timestamp={timestamp}, Signature={signature}"
    }

    # debug
    print(f"DEBUG: POST GraphQL to {url}")
    print("DEBUG: timestamp:", timestamp)
    print("DEBUG: payload length (bytes):", len(payload_bytes))
    print("DEBUG: signature (prefix):", signature[:6])

    resp = requests.post(url, headers=headers, data=payload_bytes, timeout=30)
    return resp

# -------- Busca via GraphQL (tolerante) --------
def fetch_from_shopee_affiliate(keywords: List[str]) -> List[Dict]:
    offers = []

    DEFAULT_LIMIT = 20
    DEFAULT_LISTTYPE = 0   # ALL
    DEFAULT_SORT = 2       # ITEM_SOLD_DESC

    for kw in keywords:
        try:
            # NOTE: app_id removed from GraphQL variables (server expects no app_id arg)
            variables = {
                "keyword": kw,
                "limit": DEFAULT_LIMIT,
                "listType": DEFAULT_LISTTYPE,
                "sortType": DEFAULT_SORT,
                "page": 1
            }
            # add matchId if provided (must be Int64 type on server)
            if SHOPEE_MATCH_ID and SHOPEE_MATCH_ID.isdigit():
                # GraphQL expects Int64 — send as integer (Python int is fine)
                variables["matchId"] = int(SHOPEE_MATCH_ID)

            payload = {"query": GRAPHQL_QUERY, "variables": variables}
            print("DEBUG: enviando GraphQL para:", SHOPEE_AFFILIATE_URL)
            print("DEBUG: variables (preview):", variables)

            resp_raw = post_graphql_signed(SHOPEE_AFFILIATE_URL, payload, str(SHOPEE_APP_ID), str(SHOPEE_APP_SECRET))

            print("DEBUG Shopee afiliada status:", resp_raw.status_code)
            try:
                resp = resp_raw.json()
            except Exception as e:
                print("DEBUG: resposta não é JSON:", e)
                print("DEBUG texto:", resp_raw.text[:800])
                continue

            # show GraphQL errors if any
            if isinstance(resp, dict) and resp.get("errors"):
                print("DEBUG GraphQL errors:", resp.get("errors"))
                # don't raise; try next keyword
                continue

            # extract nodes tolerant to structure variants
            nodes = []
            try:
                data = resp.get("data", {}) if isinstance(resp, dict) else {}
                pov = data.get("productOfferV2") if isinstance(data, dict) else None
                if pov and isinstance(pov, dict) and isinstance(pov.get("nodes"), list):
                    nodes = pov.get("nodes")
                elif isinstance(data.get("nodes"), list):
                    nodes = data.get("nodes")
                else:
                    # search for any list inside data
                    for v in (data.values() if isinstance(data, dict) else []):
                        if isinstance(v, list):
                            nodes = v
                            break
            except Exception as e:
                print("DEBUG erro ao localizar nodes:", e)

            print(f"DEBUG: encontrados {len(nodes)} nodes para keyword '{kw}'")

            for item in nodes:
                try:
                    # map common fields with the names the API suggests
                    pid = item.get("itemId") or item.get("productId") or item.get("id") or str(item.get("itemId", ""))
                    title = item.get("productName") or item.get("name") or item.get("title") or ""
                    url_item = item.get("productLink") or item.get("product_link") or item.get("productUrl") or ""
                    img = (
                        item.get("imageUrl") or
                        item.get("image_url") or
                        item.get("image") or
                        (item.get("thumbnail") if isinstance(item.get("thumbnail"), str) else "")
                    )

                    # price mapping (tolerant)
                    price_str = "R$ 0,00"
                    if isinstance(item.get("price"), (int, float)):
                        price_str = f"R$ {float(item.get('price')):.2f}"
                    elif isinstance(item.get("min_price"), (int, float)):
                        price_str = f"R$ {float(item.get('min_price')):.2f}"
                    elif isinstance(item.get("price"), dict):
                        # try to find a display string inside price object
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

            # small delay per keyword to avoid rate limiting
            time.sleep(0.6)

        except Exception as e:
            print("Erro ao buscar produtos (exc):", e)

    return offers

# -------- Execução principal --------
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

        # tenta enviar a foto; se falhar, envia fallback em texto com link
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

    # grava new_offers.json com as ofertas enviadas nesta execução
    try:
        with open("new_offers.json", "w", encoding="utf-8") as f:
            json.dump(sent_this_run, f, ensure_ascii=False, indent=2)
        print("Arquivo new_offers.json criado com", len(sent_this_run), "ofertas.")
    except Exception as e:
        print("Erro ao gravar new_offers.json:", e)

if __name__ == "__main__":
    main()
