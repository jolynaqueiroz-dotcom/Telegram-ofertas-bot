// fetchShopeeOffers.js
import express from "express";
import axios from "axios";
import crypto from "crypto";
import TelegramBot from "node-telegram-bot-api";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

const SHOPEE_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const PAYLOAD_ENV = process.env.PAYLOAD_SHOPEE || null;
const APP_ID = process.env.SHOPEE_APP_ID || "";
const APP_SECRET = process.env.SHOPEE_APP_SECRET || "";

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function makePayloadForPage(page) {
  if (PAYLOAD_ENV) {
    try {
      const p = JSON.parse(PAYLOAD_ENV);
      if (p.variables && typeof p.variables === "object") {
        p.variables.page = page;
      } else {
        p.variables = { keyword: "", limit: 30, page };
      }
      return p;
    } catch (e) {
      console.log("PAYLOAD_SHOPEE inválido no env; usando payload padrão.");
    }
  }
  return {
    query:
      "query productOfferV2($keyword: String,$limit: Int,$page: Int){productOfferV2(keyword:$keyword,limit:$limit,page:$page){nodes{productName imageUrl offerLink priceMin priceMax shopId}pageInfo{hasNextPage}}}",
    variables: { keyword: "", limit: 30, page },
  };
}

async function fetchOffersPage(page) {
  let offersPage = [];
  try {
    const payloadObj = makePayloadForPage(page);
    const timestamp = Math.floor(Date.now() / 1000);
    const signFactor = `${APP_ID}${timestamp}${JSON.stringify(payloadObj)}${APP_SECRET}`;
    const signature = sha256Hex(signFactor);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
    };

    const resp = await axios.post(SHOPEE_URL, payloadObj, { headers, timeout: 20000 });
    const nodes = resp.data?.data?.productOfferV2?.nodes || resp.data?.data?.shopeeOfferV2?.nodes || [];
    if (Array.isArray(nodes)) offersPage = nodes;
  } catch (err) {
    console.log("Erro ao buscar ofertas:", err?.message || err);
  }
  return offersPage;
}

// Health check
app.get("/", (req, res) => {
  res.send(`ok - pid=${process.pid} PORT=${PORT}`);
});

// Endpoint que retorna as ofertas
app.get("/fetch", async (req, res) => {
  try {
    let allOffers = [];
    for (let page = 1; page <= 3; page++) {
      const pageOffers = await fetchOffersPage(page);
      allOffers = allOffers.concat(pageOffers);
    }
    res.json({ offers: allOffers });
  } catch (e) {
    console.log("Erro geral no /fetch:", e);
    res.status(500).json({ error: "Erro interno ao buscar ofertas" });
  }
});

// Endpoint que envia ofertas para o Telegram
app.get("/push", async (req, res) => {
  try {
    const offersToSend = (await fetchOffersPage(1)).slice(0, 10);
    for (let i = 0; i < offersToSend.length; i++) {
      const offer = offersToSend[i];
      const msg =
`🔥 *${offer.productName}*
💰 Por: *${offer.priceMin}* Até: *${offer.priceMax}*
🛒 [Link da oferta](${offer.offerLink})`;
      await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
      await new Promise(r => setTimeout(r, 3000)); // 3 segundos entre cada
    }
    res.json({ sent: offersToSend.length });
  } catch (err) {
    console.log("Erro ao enviar para o Telegram:", err);
    res.status(500).json({ error: "Erro ao enviar para o Telegram" });
  }
});

// AutoPush: envia 10 ofertas a cada 30 minutos
const PUSH_INTERVAL_MINUTES = 30;
const OFFERS_PER_PUSH = 10;
const DELAY_BETWEEN_OFFERS_MS = 3000; // 3 segundos

async function sendOffersToTelegram() {
  try {
    const offers = await fetchOffersPage(1);
    const offersToSend = offers.slice(0, OFFERS_PER_PUSH);

    for (const offer of offersToSend) {
      const msg =
`🔥 *${offer.productName}*
💰 Por: *${offer.priceMin}* Até: *${offer.priceMax}*
🛒 [Link da oferta](${offer.offerLink})`;
      await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_OFFERS_MS));
    }

    console.log(`[AutoPush] Enviadas ${offersToSend.length} ofertas para o Telegram.`);
  } catch (err) {
    console.log("Erro no AutoPush:", err);
  }
}

// Chama a função de push a cada 30 minutos
setInterval(sendOffersToTelegram, PUSH_INTERVAL_MINUTES * 60 * 1000);

// Envia uma vez logo ao iniciar
sendOffersToTelegram();

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Node HTTP Shopee rodando na porta ${PORT} (pid=${process.pid})`);
  console.log(`USE: GET /fetch, GET /push e GET / (health)`);
});
