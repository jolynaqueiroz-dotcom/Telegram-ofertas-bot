import os
import json
import requests
from telegram import Bot
from PIL import Image
from io import BytesIO

# --- Configurações via variáveis de ambiente ---
TELEGRAM_BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.getenv('TELEGRAM_CHAT_ID')
SHOPEE_APP_ID = os.getenv('SHOPEE_APP_ID')
SHOPEE_APP_SECRET = os.getenv('SHOPEE_APP_SECRET')
SHOPEE_API_KEY = os.getenv('SHOPEE_API_KEY')
SHOPEE_AFILIATE_URL = os.getenv('SHOPEE_AFILIATE_URL')

# Inicializa bot Telegram
bot = Bot(token=TELEGRAM_BOT_TOKEN)

# --- Função para buscar ofertas da Shopee ---
def buscar_ofertas(keywords, limit=10):
    ofertas = []
    for keyword in keywords:
        payload = {
            "query": """
            query shopeeOfferV2($keyword: String, $limit: Int, $sortType: Int, $page: Int) {
                shopeeOfferV2(keyword: $keyword, limit: $limit, sortType: $sortType, page: 1) {
                    nodes {
                        offerName
                        imageUrl
                        priceMin
                        priceMax
                        commissionRate
                        offerLink
                        originalLink
                        shopName
                    }
                }
            }
            """,
            "variables": {
                "keyword": keyword,
                "limit": limit,
                "sortType": 2,  # Maior comissão
                "page": 1
            }
        }

        headers = {
            "Authorization": f"Bearer {SHOPEE_API_KEY}",
            "Content-Type": "application/json"
        }

        try:
            resp = requests.post(SHOPEE_AFILIATE_URL, headers=headers, json=payload)
            data = resp.json()
            nodes = data.get("data", {}).get("shopeeOfferV2", {}).get("nodes", [])
            for node in nodes[:limit]:
                ofertas.append(node)
        except Exception as e:
            print(f"Erro ao buscar {keyword}: {e}")
    return ofertas

# --- Função para enviar imagem + mensagem no Telegram ---
def enviar_oferta(oferta):
    nome = oferta.get("offerName")
    preco_min = oferta.get("priceMin")
    preco_max = oferta.get("priceMax")
    shop = oferta.get("shopName")
    link = oferta.get("offerLink")
    imagem_url = oferta.get("imageUrl")

    # Monta legenda
    legenda = (
        f"🛍 *{nome}*\n"
        f"💰 De R${preco_max} por R${preco_min}\n"
        f"🚚 Frete grátis | Parcelamento disponível\n"
        f"🏬 Loja: {shop}\n"
        f"[Comprar agora]({link})"
    )

    # Baixa imagem
    try:
        response = requests.get(imagem_url)
        img = BytesIO(response.content)
        bot.send_photo(chat_id=TELEGRAM_CHAT_ID, photo=img, caption=legenda, parse_mode='Markdown')
    except Exception as e:
        print(f"Erro ao enviar oferta {nome}: {e}")

# --- Função principal ---
def main():
    keywords_env = os.getenv('SHOPEE_KEYWORDS', '')
    if not keywords_env:
        print("Nenhuma keyword configurada!")
        return
    keywords = [k.strip() for k in keywords_env.split(",") if k.strip()]
    
    ofertas = buscar_ofertas(keywords, limit=10)
    
    if not ofertas:
        print("Nenhuma oferta encontrada.")
        return

    # Evita duplicados no mesmo envio
    enviados = set()
    for oferta in ofertas:
        if oferta.get("offerLink") not in enviados:
            enviar_oferta(oferta)
            enviados.add(oferta.get("offerLink"))

if __name__ == "__main__":
    main()
