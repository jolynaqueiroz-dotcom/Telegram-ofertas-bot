import os
import json
import time
import requests
from datetime import datetime
import schedule

# Variáveis de ambiente
SHOPEE_API_URL = os.getenv("SHOPEE_AFILIATE_URL")  # Certifique-se que é o correto
SHOPEE_APP_ID = os.getenv("SHOPEE_APP_ID")
SHOPEE_APP_SECRET = os.getenv("SHOPEE_APP_SECRET")
SHOPEE_API_KEY = os.getenv("SHOPEE_API_KEY")
SHOPEE_KEYWORDS = os.getenv("SHOPEE_KEYWORDS", "").split(",")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

NEW_OFFERS_FILE = "new_offers.json"


def load_sent_offers():
    if os.path.exists(NEW_OFFERS_FILE):
        with open(NEW_OFFERS_FILE, "r") as f:
            return json.load(f)
    return []


def save_sent_offers(sent_offers):
    with open(NEW_OFFERS_FILE, "w") as f:
        json.dump(sent_offers, f)


def shopee_affiliate_query(keyword, limit=20, listType=0, sortType=2, page=1):
    headers = {
        "Authorization": f"Bearer {SHOPEE_API_KEY}",
        "Content-Type": "application/json"
    }

    query = """
    query ($keyword: String!, $limit: Int!, $listType: Int!, $sortType: Int!, $page: Int!) {
      productOfferV2(
        keyword: $keyword,
        limit: $limit,
        listType: $listType,
        sortType: $sortType,
        page: $page
      ) {
        nodes {
          itemId
          productName
          imageUrl
          productLink
          priceMin
          priceMax
          commissionRate
          shopId
          shopName
        }
        pageInfo {
          hasNextPage
        }
      }
    }
    """

    variables = {
        "keyword": keyword,
        "limit": limit,
        "listType": listType,
        "sortType": sortType,
        "page": page
    }

    response = requests.post(
        SHOPEE_API_URL,
        json={"query": query, "variables": variables},
        headers=headers
    )

    if response.status_code == 200:
        return response.json()
    else:
        print(f"Erro Shopee: {response.status_code} - {response.text}")
        return None


def get_new_offers():
    sent_offers = load_sent_offers()
    new_offers = []

    for keyword in SHOPEE_KEYWORDS:
        for listType in [0, 1, 2]:
            resp = shopee_affiliate_query(keyword, listType=listType)
            if resp and "data" in resp and "productOfferV2" in resp["data"]:
                nodes = resp["data"]["productOfferV2"]["nodes"]
                for offer in nodes:
                    offer_id = str(offer["itemId"])
                    if offer_id not in sent_offers:
                        new_offers.append(offer)
                        sent_offers.append(offer_id)

    save_sent_offers(sent_offers)
    return new_offers


def send_telegram_message(text):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "Markdown"
    }
    requests.post(url, data=payload)


def send_offers():
    offers = get_new_offers()
    if not offers:
        send_telegram_message("⚠️ Nenhuma nova oferta encontrada no momento.")
        return

    for offer in offers:
        text = (
            f"*{offer['productName']}*\n"
            f"Preço atual: {offer['priceMin']} - {offer['priceMax']}\n"
            f"Loja: {offer['shopName']}\n"
            f"[Link do produto]({offer['productLink']})"
        )
        send_telegram_message(text)
        time.sleep(1)  # evitar rate limit do Telegram


# Agendamento nos horários: 09:00, 13:00, 16:00, 20:00
schedule.every().day.at("09:00").do(send_offers)
schedule.every().day.at("13:00").do(send_offers)
schedule.every().day.at("16:00").do(send_offers)
schedule.every().day.at("20:00").do(send_offers)

print("Bot de ofertas iniciado. Aguardando horários...")

while True:
    schedule.run_pending()
    time.sleep(30)
