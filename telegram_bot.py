import os
import requests
from telegram import Bot
from telegram.ext import Updater, MessageHandler, Filters
from PIL import Image, ImageDraw, ImageFont
import io
import random

# ----------------------------
# Variáveis de ambiente
# ----------------------------
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")  # ID do seu grupo de ofertas
SHOPEE_AFILIATE_URL = os.getenv("SHOPEE_AFILIATE_URL")
SHOPEE_API_KEY = os.getenv("SHOPEE_API_KEY")

bot = Bot(token=TELEGRAM_BOT_TOKEN)

# ----------------------------
# Função para buscar ofertas
# ----------------------------
def buscar_ofertas(keyword, limit=10):
    headers = {
        "Authorization": f"{SHOPEE_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "query": """
        query productOfferV2($keyword: String!, $limit: Int!){
          productOfferV2(keyword: $keyword, limit: $limit) {
            nodes {
              productName
              priceMin
              priceMax
              imageUrl
              offerLink
              shippingFee
              installment
            }
          }
        }
        """,
        "variables": {"keyword": keyword, "limit": limit}
    }

    response = requests.post(SHOPEE_AFILIATE_URL, json=payload, headers=headers)
    if response.status_code != 200:
        return []

    data = response.json()
    nodes = data.get("data", {}).get("productOfferV2", {}).get("nodes", [])
    
    # Evita produtos repetidos
    produtos_unicos = []
    seen = set()
    for node in nodes:
        pid = node.get("offerLink")
        if pid and pid not in seen:
            produtos_unicos.append(node)
            seen.add(pid)
    return produtos_unicos

# ----------------------------
# Função para gerar templates para stories
# ----------------------------
def gerar_template(oferta):
    nome = oferta.get("productName", "Produto")
    preco_atual = oferta.get("priceMin", "Indisponível")
    preco_anterior = oferta.get("priceMax", "Indisponível")
    frete = "Frete grátis" if oferta.get("shippingFee", 0) == 0 else "Frete pago"
    parcelamento = oferta.get("installment", "Parcelamento não disponível")
    imagem_url = oferta.get("imageUrl", None)

    # Baixa a imagem do produto
    if imagem_url:
        response = requests.get(imagem_url)
        imagem_produto = Image.open(io.BytesIO(response.content))
    else:
        imagem_produto = Image.new("RGB", (600, 600), color=(255, 255, 255))

    # Cria a imagem do template
    largura, altura = imagem_produto.size
    template = Image.new("RGB", (largura, altura + 150), color=(230, 220, 250))  # lilás bebê
    template.paste(imagem_produto, (0,0))

    draw = ImageDraw.Draw(template)
    font = ImageFont.load_default()

    draw.text((10, altura + 10), f"{nome}", fill="black", font=font)
    draw.text((10, altura + 40), f"De: {preco_anterior} ➡️ Agora: {preco_atual}", fill="black", font=font)
    draw.text((10, altura + 70), f"{frete} | {parcelamento}", fill="black", font=font)
    draw.text((10, altura + 100), "Achadinho Da Káh", fill="purple", font=font)

    # Salva em bytes
    bytes_io = io.BytesIO()
    template.save(bytes_io, format="PNG")
    bytes_io.seek(0)
    return bytes_io

# ----------------------------
# Função para enviar ofertas
# ----------------------------
def enviar_ofertas(keyword):
    ofertas = buscar_ofertas(keyword)
    if not ofertas:
        bot.send_message(chat_id=TELEGRAM_CHAT_ID, text=f"Nenhuma oferta encontrada para: {keyword}")
        return

    for oferta in ofertas:
        nome = oferta.get("productName", "Produto")
        preco_atual = oferta.get("priceMin", "Indisponível")
        preco_anterior = oferta.get("priceMax", "Indisponível")
        link = oferta.get("offerLink", "#")
        frete = "Frete grátis" if oferta.get("shippingFee", 0) == 0 else "Frete pago"
        parcelamento = oferta.get("installment", "Parcelamento não disponível")
        imagem = gerar_template(oferta)

        mensagem = (
            f"🛍 *{nome}*\n"
            f"💰 De: {preco_anterior} ➡️ Agora: {preco_atual}\n"
            f"{frete} | {parcelamento}\n"
            f"[Clique aqui para comprar]({link})"
        )

        bot.send_photo(chat_id=TELEGRAM_CHAT_ID, photo=imagem, caption=mensagem, parse_mode="Markdown")

# ----------------------------
# Função para receber mensagens do usuário
# ----------------------------
def handle_message(update, context):
    text = update.message.text.strip()
    if text:
        enviar_ofertas(text)

# ----------------------------
# Main
# ----------------------------
def main():
    updater = Updater(token=TELEGRAM_BOT_TOKEN, use_context=True)
    dp = updater.dispatcher

    # Recebe qualquer mensagem de texto enviada para o bot
    dp.add_handler(MessageHandler(Filters.text & ~Filters.command, handle_message))

    # Inicia o bot
    print("Bot iniciado e aguardando mensagens...")
    updater.start_polling()
    updater.idle()

if __name__ == "__main__":
    main()
