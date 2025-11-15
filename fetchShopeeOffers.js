// fetchShopeeOffers.js
// Node ESM - completo com rotacionamento de páginas + priorização BF + dedupe por imagem
import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import TelegramBot from "node-telegram-bot-api";

/**
 * ENV esperadas:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 * - SHOPEE_APP_ID
 * - SHOPEE_APP_SECRET
 * - PAYLOAD_SHOPEE (opcional JSON string)
 * - SHOPEE_KEYWORDS (opcional, csv grande)
 * - SHOPEE_PAGES (opcional, csv: números de página ou keywords ou URLs)
 * - OPENAI_API_KEY (opcional: para legendas)
 * - OFFERS_PER_PUSH (default 10)
 * - PUSH_INTERVAL_MINUTES (default 30)
 * - DELAY_BETWEEN_OFFERS_MS (default 3000)
 * - PAGES_PER_RUN (quantas páginas sortear por ciclo, default 3)
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
const PAGES_PER_RUN = Number(process.env.PAGES_PER_RUN || 3);

const SENT_FILE = path.resolve("./sent_offers.json");
let sentOffers = new Set();

// load/save persistência
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

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
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

// Fetch usando GraphQL (mantido)
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

// Helper: processa SHOPEE_PAGES env e retorna lista de entries {type:'page'|'keyword', value}
function parseShopeePagesEnv() {
  const raw = (process.env.SHOPEE_PAGES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (/^\d+$/.test(s)) return { type: "page", value: Number(s) };
      // se for algo "black friday" ou texto, usa como keyword
      return { type: "keyword", value: s };
    });
}

// Busca ofertas combinando either pages or keywords (rotaciona)
async function fetchOffersFromPagesOrKeywords() {
  const parsed = parseShopeePagesEnv();
  const keywordsEnv = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
  const keywordsFallback = keywordsEnv ? keywordsEnv.split(",").map(k => k.trim()).filter(Boolean) : [];

  const chosenEntries = [];
  if (parsed.length > 0) {
    // embaralha e pega até PAGES_PER_RUN
    const shuffled = parsed.sort(() => 0.5 - Math.random());
    for (let i = 0; i < Math.min(PAGES_PER_RUN, shuffled.length); i++) chosenEntries.push(shuffled[i]);
  } else if (keywordsFallback.length > 0) {
    // se não houver pages, use keywords: sorteia PAGES_PER_RUN keywords
    const shuffled = keywordsFallback.sort(() => 0.5 - Math.random());
    for (let i = 0; i < Math.min(PAGES_PER_RUN, shuffled.length); i++) chosenEntries.push({ type: "keyword", value: shuffled[i] });
  } else {
    // sem pages/keywords definidos, usa page=1 vazia keyword (comportamento antigo)
    chosenEntries.push({ type: "page", value: 1 });
  }

  // agora fetch de cada entrada
  const all = [];
  for (const entry of chosenEntries) {
    const pageNum = entry.type === "page" ? entry.value : 1;
    const keyword = entry.type === "keyword" ? entry.value : "";
    const pageOffers = await fetchOffersPage(pageNum, keyword);
    if (Array.isArray(pageOffers) && pageOffers.length > 0) {
      all.push(...pageOffers);
    }
  }

  // remove duplicados simples por offerLink+shopId (antes da priorização)
  const map = new Map();
  for (const off of all) {
    const key = `${off.imageUrl || off.offerLink || off.productName}::${off.shopId || ""}`;
    if (!map.has(key)) map.set(key, off);
  }
  return Array.from(map.values());
}

// Fetch all pages based on keywords list (mantido para endpoint /fetch quando quiser varredura completa)
async function fetchOffersAllPages(keywords = []) {
  const pagesToCheck = [1, 2, 3];
  const map = new Map();
  if (!Array.isArray(keywords) || keywords.length === 0) keywords = [""];
  for (const kw of keywords) {
    for (const p of pagesToCheck) {
      const pageOffers = await fetchOffersPage(p, kw);
      for (const off of pageOffers) {
        const key = `${off.imageUrl || off.offerLink || off.productName}::${off.shopId || ""}`;
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
function prioritizeOffers(offers) {
  const map = new Map();
  for (const off of offers) {
    const key = `${off.imageUrl || off.offerLink || off.productName}::${off.shopId || ""}`;
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

  const sortDesc = arr => arr.sort((a,b) => (b.discountScore||0) - (a.discountScore||0));

  sortDesc(bf);
  sortDesc(coupon);
  sortDesc(withDiscount);

  const ordered = [
    ...bf.map(x => x.off),
    ...coupon.map(x => x.off),
    ...withDiscount.map(x => x.off),
    ...rest.map(x => x.off),
  ];

  const seen = new Set();
  const final = [];
  for (const o of ordered) {
    const k = `${o.imageUrl || o.offerLink || o.productName}::${o.shopId || ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      final.push(o);
    }
  }
  return final;
}
// -------------------------------------------------------------------------

// OpenAI caption (se definido)
async function generateOpenAICaption(productName) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return productName;
    const prompt = `Escreva uma legenda curta, persuasiva e natural para divulgar este produto em um grupo de ofertas no Telegram. Produto: ${productName}\nResponda em 1-2 linhas, linguagem coloquial.`;
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
  const coupon = offer.couponLink || offer.coupon_url || offer.coupon || offer.couponCode || null;
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
    // prioriza SHOPEE_PAGES se tiver; caso contrário usa SHOPEE_KEYWORDS
    const pagesList = parseShopeePagesEnv();
    let offers = [];
    if (pagesList.length > 0) {
      offers = await fetchOffersFromPagesOrKeywords();
    } else {
      const keywordsEnv = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
      const keywords = keywordsEnv
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      offers = await fetchOffersAllPages(keywords);
    }
    const prioritized = prioritizeOffers(offers);
    res.json({ offers: prioritized });
  } catch (e) {
    console.log("Erro geral no /fetch:", e);
    res.status(500).json({ error: "Erro interno ao buscar ofertas" });
  }
});

// enviar util com persistência (usa imageUrl como chave preferida)
async function pushOffersToTelegram(offers) {
  for (const offer of offers) {
    const uniqueKey = `${offer.imageUrl || offer.offerLink || offer.productName}::${offer.shopId || ""}`;
    if (sentOffers.has(uniqueKey)) continue;
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
    // decide fontes
    const pagesList = parseShopeePagesEnv();
    let all = [];
    if (pagesList.length > 0) {
      all = await fetchOffersFromPagesOrKeywords();
    } else {
      const keywordsEnv = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
      const keywords = keywordsEnv
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      all = await fetchOffersAllPages(keywords);
    }
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
    const pagesList = parseShopeePagesEnv();
    let all = [];
    if (pagesList.length > 0) {
      all = await fetchOffersFromPagesOrKeywords();
    } else {
      const keywordsEnv = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
      const keywords = keywordsEnv
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      all = await fetchOffersAllPages(keywords);
    }
    const prioritized = prioritizeOffers(all);
    const unique = prioritized.filter((offer) => {
      const key = `${offer.imageUrl || offer.offerLink || offer.productName}::${offer.shopId || ""}`;
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

// init
await loadSentOffers();
sendOffersToTelegram().catch((e) => console.log("AutoPush init erro:", e?.message || e));

// start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Node HTTP Shopee rodando na porta ${PORT} (pid=${process.pid})`);
  console.log(`USE: GET /fetch, GET /push e GET / (health)`);
});