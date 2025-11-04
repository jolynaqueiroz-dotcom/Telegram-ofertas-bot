# telegram_bot.py
# Bot automático que busca produtos mais vendidos da Shopee Brasil e envia para um canal do Telegram
# Feito para rodar via GitHub Actions 4x por dia
# Autor: ChatGPT (ajuste para Karolyna)

import os
import time
import json
import requests
from typing import List, Dict

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

if not BOT_TOKEN or not CHAT_ID:
    raise SystemExit("ERRO: Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID nas Secrets do repositório.")

# Shopee configs
SHOPEE_KEYWORDS = os.getenv("SHOPEE_KEYWORDS", "brinquedos;moda feminina;casa;eletronicos")
SENT_STORE = "sent_offers.json"

def load_sent_ids() -> set:
    try:
        with open(SENT_STORE, "r", encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:
        return set()

def save_sent_ids(ids:set):
    try:
        with open(SENT_STORE, "w", encoding="utf-8") as f:
            json.dump(list(ids), f, ensure_ascii=False, indent=2)
    except Exception:
        pass

# -------- Telegram helpers --------
def send_photo(chat_id: str, photo_url: str, caption: str):
    url = f"{TELEGRAM_API}/sendPhoto"
    data = {"chat_id": chat_id, "photo": photo_url, "caption": caption, "parse_mode": "HTML"}
    r = requests.post(url, data=data, timeout=20)
    try:
        return r.json()
    except Exception:
        return {"ok": False, "error": "invalid-json-response"}

def send_message(chat_id: str, text: str):
    url = f"{TELEGRAM_API}/sendMessage"
    data = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    r = requests.post(url, data=data, timeout=20)
    try:
        return r.json()
    except Exception:
        return {"ok": False, "error": "invalid-json-response"}

def format_caption(offer: Dict) -> str:
    title = offer.get("title", "")
    price = offer.get("price", "")
    url = offer.get("url", "")
    return f"<b>{title}</b>\n{price}\n<a href=\"{url}\">Ver oferta</a>"

# -------- Shopee Brasil scraping --------
def fetch_from_shopee_br(keywords: List[str]) -> List[Dict]:
    offers = []
    headers = {"User-Agent": "Mozilla/5.0"}

    for kw in keywords:
        try:
            kw_encoded = requests.utils.requote_uri(kw)
            url = f"https://shopee.com.br/api/v4/search/search_items?by=sales&keyword={kw_encoded}&limit=20&order=desc&page_type=search"
            resp = requests.get(url, headers=headers, timeout=15).json()
            items = resp.get("items", [])
            for it in items:
                data = it.get("item_basic", {})
                itemid = data.get("itemid")
                shopid = data.get("shopid")
                name = data.get("name", "")
                image = data.get("image")
                try:
                    price = int(data.get("price", 0)) / 100000
                except Exception:
                    price = 0
                url_item = f"https://shopee.com.br/product/{shopid}/{itemid}"

                offers.append({
                    "id": f"{shopid}-{itemid}",
                    "title": name,
                    "price": f"R$ {price:.2f}",
                    "url": url_item,
                    "image_url": f"https://down-br.img.susercontent.com/file/{image}"
                })
            time.sleep(0.8)
        except Exception as e:
            print("Erro ao buscar produtos:", e)
    return offers

# -------- Execução principal --------
def main():
    sent = load_sent_ids()
    new_sent = set(sent)
    keywords = [k.strip() for k in SHOPEE_KEYWORDS.split(";") if k.strip()]
    offers = fetch_from_shopee_br(keywords)

    # lista para gravar só as ofertas enviadas com sucesso nesta execução
    sent_this_run = []

    for offer in offers:
        oid = offer["id"]
        if oid in sent:
            continue
        caption = format_caption(offer)
        try:
            resp = send_photo(CHAT_ID, offer["image_url"], caption)
            if resp.get("ok"):
                print("✅ Enviado:", offer["title"])
                new_sent.add(oid)
                sent_this_run.append(offer)
            else:
                print("❌ Falha ao enviar:", offer["title"], "->", resp)
            time.sleep(1.5)
        except Exception as e:
            print("Erro ao enviar para Telegram:", e)

    save_sent_ids(new_sent)

    # grava new_offers.json com as ofertas enviadas nesta execução
    try:
        with open("new_offers.json", "w", encoding="utf-8") as f:
            json.dump(sent_this_run, f, ensure_ascii=False, indent=2)
        print("Arquivo new_offers.json criado com", len(sent_this_run), "ofertas.")
    except Exception as e:
        print("Erro ao gravar new_offers.json:", e)

# Teste rápido: enviar mensagem para o grupo
send_message(CHAT_ID, "✅ Teste do bot funcionando!")
if __name__ == "__main__":
    main()
