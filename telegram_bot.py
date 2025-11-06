import os
import requests
from telegram import Bot
from PIL import Image
from io import BytesIO
import schedule
import time

# -------------------------------
# Configurações
# -------------------------------
TELEGRAM_BOT_TOKEN = os.environ['TELEGRAM_BOT_TOKEN']
TELEGRAM_CHAT_ID = os.environ['TELEGRAM_CHAT_ID']
SHOPEE_API_KEY = os.environ['SHOPEE_API_KEY']
SHOPEE_APP_ID = os.environ['SHOPEE_APP_ID']
SHOPEE_APP_SECRET = os.environ['SHOPEE_APP_SECRET']
SHOPEE_AFFILIATE_URL = os.environ['SHOPEE_AFFILIATE_URL']
SHOPEE_AFILIATE_URL = os.environ['SHOPEE_AFILIATE_URL']
SHOPEE_KEYWORDS = os.environ['SHOPEE_KEYWORDS'].split(',')

bot = Bot(token=TELEGRAM_BOT_TOKEN)

# -------------------------------
# Funções
# -------------------------------
def fetch_offers(keyword, limit=10):
    """Busca ofertas na Shopee usando a API de afiliados"""
    url = SHOPEE_AFILIATE_URL
    headers = {
        "Authorization": f"Bearer {SHOPEE_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "query": """
        query($keyword:String!, $limit:Int!){
            shopeeOfferV2(keyword:$keyword, sortType:2, page:1, limit:$limit){
                nodes{
                    offerName
                    priceMin
                    priceMax
                    imageUrl
                    offerLink
                    shopName
                }
            }
        }
        """,
        "variables": {"keyword": keyword, "limit": limit}
    }
    response = requests.post(url, json=payload, headers=headers)
    if response.status_code != 200:
        print(f"Erro ao buscar ofertas: {response.text}")
        return []

    data = response.json()
    nodes = data.get("data", {}).get("shopeeOfferV2", {}).get("nodes", [])
    return nodes

def send_offer_to_telegram(offer):
    """Monta mensagem com oferta e envia para o grupo"""
    name = offer.get('offerName')
    price_min = offer.get('priceMin')
    price_max = offer.get('priceMax')
    link = offer.get('offerLink')
    image_url = offer.get('imageUrl')

    message = f"*{name}*\nPreço: R$ {price_min} - R$ {price_max}\nFrete grátis e parcelamento disponível!\n[Comprar Aqui]({link})"

    # Envia imagem + mensagem
    try:
        image_response = requests.get(image_url)
        image = BytesIO(image_response.content)
        bot.send_photo(chat_id=TELEGRAM_CHAT_ID, photo=image, caption=message, parse_mode="Markdown")
    except Exception as e:
        print(f"Erro ao enviar oferta: {e}")

def job():
    """Função principal que busca e envia ofertas"""
    print("Buscando ofertas...")
    for keyword in SHOPEE_KEYWORDS:
        offers = fetch_offers(keyword.strip(), limit=10)
        for offer in offers:
            send_offer_to_telegram(offer)
    print("Envio de ofertas concluído.")

# -------------------------------
# Agendamento automático
# -------------------------------
schedule.every().day.at("09:00").do(job)
schedule.every().day.at("13:00").do(job)
schedule.every().day.at("16:00").do(job)
schedule.every().day.at("20:00").do(job)

print("Bot iniciado e aguardando horários programados...")

while True:
    schedule.run_pending()
    time.sleep(30)
