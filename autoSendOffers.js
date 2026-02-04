const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const bot = new TelegramBot(TOKEN, { polling: false });
const OFFERS_FILE = "new_offers.json";

if (!fs.existsSync(OFFERS_FILE)) {
  console.log("Nenhuma oferta nova para enviar");
  process.exit();
}

const offers = JSON.parse(fs.readFileSync(OFFERS_FILE));

const MAX_OFFERS = 10;

offers.slice(0, MAX_OFFERS).forEach(async (offer) => {
  const message = `
🛍️ *Oferta do dia!*

✨ *${offer.name}*
🔥 Preço: R$ ${offer.price}
🚚 Frete: ${offer.shipping || "Ver na Shopee"}

👉 ${offer.link}
`;

  await bot.sendMessage(CHAT_ID, message, {
    parse_mode: "Markdown"
  });
});
