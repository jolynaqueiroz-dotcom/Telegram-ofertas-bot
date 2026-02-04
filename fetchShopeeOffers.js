import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOPEE_URL = "https://open-api.affiliate.shopee.com.br/graphql";

const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const PUSH_INTERVAL_MINUTES = 30;
const OFFERS_PER_PUSH = 10;
const SENT_FILE = path.resolve("./sent_offers.json");

let sentOffers = new Set();

/* ===================== KEYWORDS ===================== */

const REQUIRED_KEYWORDS = [
  "sofá","cama","guarda roupa","mesa","rack","painel tv",
  "geladeira","fogão","microondas","air fryer","ventilador",
  "televisão","smart tv","notebook","tablet",
  "jogo de pratos","panelas","talheres","mesa posta",
  "potes herméticos","organizador de cozinha",
  "jogo de cama","toalha","edredom",
  "vestido","camiseta","roupa infantil",
  "tênis","sandália","sapato",
  "kit mala maternidade","enxoval bebê",
  "fralda","mamadeira",
  "brinquedo","mochila escolar","caderno",
  "liquidificador","cafeteira","supermercado"
];

const BLOCKED_KEYWORDS = [
  "adesivo","capinha","película","chaveiro",
  "enfeite","decorativo","black friday",
  "promoção","oferta"
];

/* ===================== UTILS ===================== */

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function isValidProduct(name = "") {
  const n = name.toLowerCase();
  if (BLOCKED_KEYWORDS.some(w => n.includes(w))) return false;
  if (!REQUIRED_KEYWORDS.some(w => n.includes(w))) return false;
  return true;
}

function uniqueKey(offer) {
  return `${offer.productName}::${offer.shopId}::${offer.priceMin}`;
}

/* ===================== STORAGE ===================== */

async function loadSentOffers() {
  try {
    const data = await fs.readFile(SENT_FILE, "utf8");
    sentOffers = new Set(JSON.parse(data));
  } catch {
    sentOffers = new Set();
  }
}

async function saveSentOffers() {
  await fs.writeFile(SENT_FILE, JSON.stringify([...sentOffers]));
}

/* ===================== SHOPEE ===================== */

async function fetchOffers(keyword, page = 1) {
  const payload = {
    query: `
      query productOfferV2($keyword: String,$limit: Int,$page: Int){
        productOfferV2(keyword:$keyword,limit:$limit,page:$page){
          nodes{
            productName imageUrl offerLink priceMin priceMax shopId
          }
        }
      }`,
    variables: { keyword, limit: 30, page }
  };

  const payloadStr = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = sha256Hex(APP_ID + timestamp + payloadStr + APP_SECRET);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${sign}`
  };

  const res = await axios.post(SHOPEE_URL, payload, { headers });
  return res.data?.data?.productOfferV2?.nodes || [];
}

/* ===================== TELEGRAM ===================== */

async function sendOffer(offer) {
  const msg = `🔥 *${offer.productName}*
De: ${offer.priceMax}
Por: *${offer.priceMin}*
🛒 [Comprar agora](${offer.offerLink})`;

  await bot.sendPhoto(CHAT_ID, offer.imageUrl, {
    caption: msg,
    parse_mode: "Markdown"
  });
}

/* ===================== MAIN LOGIC ===================== */

async function runBot() {
  for (const kw of REQUIRED_KEYWORDS) {
    const offers = await fetchOffers(kw, 1);

    for (const offer of offers) {
      if (!isValidProduct(offer.productName)) continue;

      const key = uniqueKey(offer);
      if (sentOffers.has(key)) continue;

      sentOffers.add(key);
      await saveSentOffers();
      await sendOffer(offer);
    }
  }
}

setInterval(runBot, PUSH_INTERVAL_MINUTES * 60 * 1000);

await loadSentOffers();
runBot();

app.listen(PORT, () => {
  console.log("🔥 Bot Shopee rodando perfeitamente");
});
