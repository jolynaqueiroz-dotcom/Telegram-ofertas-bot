// fetchShopeeOffers.js
// Node ESM - completo com dedupe por imagem, priorização e persistência
import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import TelegramBot from "node-telegram-bot-api";

/**
 * ENV esperadas (defina no Render / Replit Secrets):
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 * - SHOPEE_APP_ID
 * - SHOPEE_APP_SECRET
 * - PAYLOAD_SHOPEE (opcional JSON string)
 * - SHOPEE_KEYWORDS (opcional, csv grande)
 * - KEYWORDS (opcional, csv - fallback se SHOPEE_KEYWORDS não existir)
 * - OPENAI_API_KEY (opcional: para legendas melhores via OpenAI)
 * - OFFERS_PER_PUSH (opcional, default 10)
 * - PUSH_INTERVAL_MINUTES (opcional, default 30)
 * - DELAY_BETWEEN_OFFERS_MS (opcional, default 3000)
 */

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!botToken) console.warn("AVISO: TELEGRAM_BOT_TOKEN não definido (mensagens não serão enviadas).");
if (!CHAT_ID) console.warn("AVISO: TELEGRAM_CHAT_ID não definido (mensagens não serão enviadas).");

const bot = botToken ? new TelegramBot(botToken) : null;

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const SHOPEE_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const PAYLOAD_ENV = process.env.PAYLOAD_SHOPEE || null;
const APP_ID = process.env.SHOPEE_APP_ID || "";
const APP_SECRET = process.env.SHOPEE_APP_SECRET || "";

const OFFERS_PER_PUSH = Number(process.env.OFFERS_PER_PUSH || 10);
const PUSH_INTERVAL_MINUTES = Number(process.env.PUSH_INTERVAL_MINUTES || 30);
const DELAY_BETWEEN_OFFERS_MS = Number(process.env.DELAY_BETWEEN_OFFERS_MS || 3000);

// arquivo local para persistir dedupe entre reboots
const SENT_FILE = path.resolve("./sent_offers.json");
let sentOffers = new Set();

async function loadSentOffers() {
  try {
    const data = await fs.readFile(SENT_FILE, "utf8");
    const arr = JSON.parse(data || "[]");
    sentOffers = new Set(arr);
    console.log(`Loaded ${arr.length} sent offers from ${SENT_FILE}`);
  } catch (e) {
    sentOffers = new Set();
    if (e.code !== "ENOENT") console.log("Não foi possível ler sent_offers.json:", e.message);
  }
}

async function saveSentOffers() {
  try {
    await fs.writeFile(SENT_FILE, JSON.stringify(Array.from(sentOffers)), "utf8");
  } catch (e) {
    console.log("Erro salvando sent_offers.json:", e.message);
  }
}

// util
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// Normaliza URL removendo query string e hash (útil para dedupe por link/imagem)
function normalizeUrlNoQuery(u) {
  if (!u || typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`; // sem query, sem hash
  } catch (e) {
    // se não for URL completa (às vezes vem como caminho parcial), tenta manual
    const qIdx = u.indexOf("?");
    const sharpIdx = u.indexOf("#");
    let end = u.length;
    if (qIdx !== -1) end = Math.min(end, qIdx);
    if (sharpIdx !== -1) end = Math.min(end, sharpIdx);
    return u.slice(0, end);
  }
}

// chave única para dedupe: PRIORIDADE -> imageUrl (normalizada) -> offerLink (normalizada) -> productName::shopId
function makeUniqueKey(offer) {
  const img = offer.imageUrl ? normalizeUrlNoQuery(offer.imageUrl) : null;
  if (img) return `img::${img}`;

  const link = offer.offerLink ? normalizeUrlNoQuery(offer.offerLink) : null;
  if (link) return `link::${link}`;

  const name = (offer.productName || "").trim().replace(/\s+/g, " ");
  const shop = offer.shopId || "";
  return `name::${name}::${shop}`;
}

function makePayloadForPage(page, keyword = "") {
  if (PAYLOAD_ENV) {
    try {
      const p = JSON.parse(PAYLOAD_ENV);
      if (p.variables && typeof p.variables === "object") {
        p.variables.page = page;
        if (typeof p.variables.keyword === "string") p.variables.keyword = keyword;
      } else {
        p.variables = { keyword, limit: 30, page };
      }
      return p;
    } catch (e) {
      console.log("PAYLOAD_SHOPEE inválido no env; usando payload padrão.");
    }
  }

  return {
    query:
      "query productOfferV2($keyword: String,$limit: Int,$page: Int){productOfferV2(keyword:$keyword,limit:$limit,page:$page){nodes{productName imageUrl offerLink priceMin priceMax shopId videoUrl couponLink}pageInfo{hasNextPage}}}",
    variables: { keyword, limit: 30, page },
  };
}

async function fetchOffersPage(page = 1, keyword = "") {
  let offersPage = [];
  try {
    const payloadObj = makePayloadForPage(page, keyword);
    const payloadStr = JSON.stringify(payloadObj);

    const timestamp = Math.floor(Date.now() / 1000);
    const signFactor = `${APP_ID}${timestamp}${payloadStr}${APP_SECRET}`;
    const signature = sha256Hex(signFactor);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`,
    };

    const resp = await axios.post(SHOPEE_URL, payloadObj, { headers, timeout: 20000 });

    if (resp.status === 200 && resp.data) {
      const data = resp.data;
      const nodes = data?.data?.productOfferV2?.nodes || data?.data?.shopeeOfferV2?.nodes || [];
      if (Array.isArray(nodes)) offersPage = nodes;
    } else {
      console.log(`Shopee retornou status ${resp.status} para página ${page} (kw=${keyword})`);
    }
  } catch (err) {
    console.log("Erro ao buscar ofertas:", err?.message || err);
  }
  return offersPage;
}

// Busca várias páginas e keywords, já deduplicando por chave única
async function fetchOffersAllPages(keywords = []) {
  const pagesToCheck = [1, 2, 3];
  const map = new Map();
  if (!Array.isArray(keywords) || keywords.length === 0) keywords = [""];

  for (const kw of keywords) {
    for (const p of pagesToCheck) {
      const pageOffers = await fetchOffersPage(p, kw);
      for (const off of pageOffers) {
        const key = makeUniqueKey(off);
        if (!map.has(key)) map.set(key, off);
      }
    }
  }
  return Array.from(map.values());
}

// ---------- Prioritização (Black Friday, cupom, maior desconto) ----------
function parsePrice(val) {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function computeDiscountScore(offer) {
  const max = parsePrice(offer.priceMax);
  const min = parsePrice(offer.priceMin);
  if (max && min && max > min) {
    return ((max - min) / max) * 100;
  }
  return 0;
}

function isBlackFridayOffer(offer) {
  const name = (offer.productName || "").toLowerCase();
  return name.includes("black") || name.includes("black friday");
}

// Fisher-Yates shuffle (embaralha in-place)
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function prioritizeOffers(offers) {
  // garante unicidade por chave (novamente)
  const map = new Map();
  for (const off of offers) {
    const key = makeUniqueKey(off);
    if (!map.has(key)) map.set(key, off);
  }
  const uniq = Array.from(map.values());

  const bf = [];
  const coupon = [];
  const withDiscount = [];
  const rest = [];

  for (const off of uniq) {
    const hasCoupon = Boolean(off.couponLink || off.coupon_url || off.coupon || off.couponCode);
    const discountScore = computeDiscountScore(off);
    if (isBlackFridayOffer(off)) {
      bf.push({ off, discountScore, hasCoupon });
    } else if (hasCoupon) {
      coupon.push({ off, discountScore, hasCoupon });
    } else if (discountScore > 0) {
      withDiscount.push({ off, discountScore, hasCoupon });
    } else {
      rest.push({ off, discountScore, hasCoupon });
    }
  }

  const sortDescByScore = arr => arr.sort((a,b) => (b.discountScore||0) - (a.discountScore||0));

  sortDescByScore(bf);
  sortDescByScore(coupon);
  sortDescByScore(withDiscount);

  // embaralha dentro de cada grupo (para evitar sempre os mesmos elementos no topo)
  const bfShuffled = shuffleArray(bf.map(x=>x.off));
  const couponShuffled = shuffleArray(coupon.map(x=>x.off));
  const withDiscountShuffled = shuffleArray(withDiscount.map(x=>x.off));
  const restShuffled = shuffleArray(rest.map(x=>x.off));

  const ordered = [
    ...bfShuffled,
    ...couponShuffled,
    ...withDiscountShuffled,
    ...restShuffled,
  ];

  // garante unicidade final (por via das dúvidas)
  const seen = new Set();
  const final = [];
  for (const o of ordered) {
    const k = makeUniqueKey(o);
    if (!seen.has(k)) {
      seen.add(k);
      final.push(o);
    }
  }
  return final;
}
// -------------------------------------------------------------------------

// OpenAI (GPT) caption (se OPENAI_API_KEY estiver definido)
async function generateOpenAICaption(productName) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return productName;

    const prompt = `Escreva uma legenda curta, persuasiva e natural para divulgar este produto em um grupo de ofertas no Telegram. Produto: ${productName}\nResponda em 1-2 linhas, linguagem coloquial, sem emojis adicionais.`;
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 60,
        temperature: 0.7,
      },
      {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        timeout: 10000,
      }
    );
    const text = resp.data?.choices?.[0]?.message?.content;
    return (text && text.trim()) || productName;
  } catch (err) {
    console.log("Erro OpenAI (usando nome do produto):", err?.message || err);
    return productName;
  }
}

async function formatOfferMessage(offer) {
  const caption = await generateOpenAICaption(offer.productName || "");
  const coupon =
    offer.couponLink || offer.coupon_url || offer.coupon || offer.couponCode || null;

  const isBF = isBlackFridayOffer(offer);
  let header = "";
  if (isBF) header = "🔥 *OFERTA BLACK FRIDAY!* \n";
  else if (coupon) header = "🔥 *OFERTA RELÂMPAGO — COM CUPOM!* \n";

  let msg = `${header}*${caption}*\nDe: ${offer.priceMax}\nPor: *${offer.priceMin}*`;
  if (coupon) msg += `\n🎟️ [Cupons desconto](${coupon})`;
  msg += `\n🛒 [Link da oferta](${offer.offerLink})`;
  return msg;
}

// endpoints
app.get("/", (req, res) => {
  res.send(`ok - pid=${process.pid} PORT=${PORT}`);
});

app.get("/fetch", async (req, res) => {
  try {
    // prefer SHOPEE_KEYWORDS env, fallback KEYWORDS env, fallback empty
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
    const keywordsEnv = envKeys;
    const keywords = keywordsEnv
      ? keywordsEnv.split(",").map((k) => k.trim()).filter(Boolean)
      : [""];
    const offers = await fetchOffersAllPages(keywords);
    const prioritized = prioritizeOffers(offers);
    res.json({ offers: prioritized });
  } catch (e) {
    console.log("Erro geral no /fetch:", e);
    res.status(500).json({ error: "Erro interno ao buscar ofertas" });
  }
});

// envio util com persistência
async function pushOffersToTelegram(offers) {
  for (const offer of offers) {
    const uniqueKey = makeUniqueKey(offer);
    if (sentOffers.has(uniqueKey)) continue;
    // marca imediatamente pra evitar race conditions
    sentOffers.add(uniqueKey);
    await saveSentOffers();

    const msg = await formatOfferMessage(offer);

    try {
      if (!bot) {
        console.log("Bot não configurado — mensagem pronta:", msg);
      } else {
        if (offer.videoUrl) {
          await bot.sendVideo(CHAT_ID, offer.videoUrl, { caption: msg, parse_mode: "Markdown" });
        } else if (offer.imageUrl) {
          await bot.sendPhoto(CHAT_ID, offer.imageUrl, { caption: msg, parse_mode: "Markdown" });
        } else {
          await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
        }
      }
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_OFFERS_MS));
    } catch (err) {
      console.log("Erro ao enviar oferta para Telegram:", err?.message || err);
    }
  }
}

app.get("/push", async (req, res) => {
  try {
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
    const keywordsEnv = envKeys;
    const keywords = keywordsEnv
      ? keywordsEnv.split(",").map((k) => k.trim()).filter(Boolean)
      : [""];
    const all = await fetchOffersAllPages(keywords);
    const prioritized = prioritizeOffers(all);
    const toSend = prioritized.slice(0, OFFERS_PER_PUSH);
    await pushOffersToTelegram(toSend);
    res.json({ sent: toSend.length });
  } catch (err) {
    console.log("Erro ao enviar para o Telegram:", err);
    res.status(500).json({ error: "Erro ao enviar para o Telegram" });
  }
});

// AutoPush rotineiro
async function sendOffersToTelegram() {
  try {
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
    const keywordsEnv = envKeys;
    const keywords = keywordsEnv
      ? keywordsEnv.split(",").map((k) => k.trim()).filter(Boolean)
      : [""];
    const all = await fetchOffersAllPages(keywords);
    const prioritized = prioritizeOffers(all);

    // filtra apenas ofertas não enviadas (com chave robusta)
    const unique = prioritized.filter((offer) => {
      const key = makeUniqueKey(offer);
      return !sentOffers.has(key);
    });

    const offersToSend = unique.slice(0, OFFERS_PER_PUSH);
    await pushOffersToTelegram(offersToSend);
    console.log(`[AutoPush] Enviadas ${offersToSend.length} ofertas para o Telegram.`);
  } catch (err) {
    console.log("Erro no AutoPush:", err?.message || err);
  }
}

setInterval(sendOffersToTelegram, PUSH_INTERVAL_MINUTES * 60 * 1000);

// load persisted file e inicia
await loadSentOffers();
sendOffersToTelegram().catch((e) => console.log("AutoPush init erro:", e?.message || e));

// start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Node HTTP Shopee rodando na porta ${PORT} (pid=${process.pid})`);
  console.log(`USE: GET /fetch, GET /push e GET / (health)`);
});
