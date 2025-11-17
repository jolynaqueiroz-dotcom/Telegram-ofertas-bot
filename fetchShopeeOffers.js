// server.js
// Node ESM - servidor completo (fetch + push) • PAGES_PER_RUN = 20 • timeout 30s
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
 * - SHOPEE_PAGES (opcional, csv: números de página ou keywords ou URLs)
 * - OFFERS_PER_PUSH (opcional, default 10)
 * - PUSH_INTERVAL_MINUTES (opcional, default 30)
 * - DELAY_BETWEEN_OFFERS_MS (opcional, default 3000)
 * - PAGES_PER_RUN (opcional, default 20)
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

// Configs (ajustáveis via env)
const OFFERS_PER_PUSH = Number(process.env.OFFERS_PER_PUSH || 10);
const PUSH_INTERVAL_MINUTES = Number(process.env.PUSH_INTERVAL_MINUTES || 30);
const DELAY_BETWEEN_OFFERS_MS = Number(process.env.DELAY_BETWEEN_OFFERS_MS || 3000);
const PAGES_PER_RUN = Number(process.env.PAGES_PER_RUN || 30); // você pediu 30 páginas
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000); // 30s timeout

// persistência de dedupe entre reinícios
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

// util sha256 hex
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// monta payload GraphQL (usa PAYLOAD_SHOPEE se setado)
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

// faz POST GraphQL para Shopee com assinatura SHA256 (usa HTTP_TIMEOUT_MS)
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

    const resp = await axios.post(SHOPEE_URL, payloadObj, { headers, timeout: HTTP_TIMEOUT_MS });

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

// Parse SHopee pages env (pode conter números ou palavras)
function parseShopeePagesEnv() {
  const raw = (process.env.SHOPEE_PAGES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (/^\d+$/.test(s)) return { type: "page", value: Number(s) };
      return { type: "keyword", value: s };
    });
}

// Pega ofertas rotacionando entre pages/keywords (escolhe até PAGES_PER_RUN)
async function fetchOffersFromPagesOrKeywords() {
  const parsed = parseShopeePagesEnv();
  const keywordsEnv = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
  const keywordsFallback = keywordsEnv ? keywordsEnv.split(",").map(k => k.trim()).filter(Boolean) : [];

  const chosenEntries = [];
  if (parsed.length > 0) {
    const shuffled = parsed.sort(() => 0.5 - Math.random());
    for (let i = 0; i < Math.min(PAGES_PER_RUN, shuffled.length); i++) chosenEntries.push(shuffled[i]);
  } else if (keywordsFallback.length > 0) {
    const shuffled = keywordsFallback.sort(() => 0.5 - Math.random());
    for (let i = 0; i < Math.min(PAGES_PER_RUN, shuffled.length); i++) chosenEntries.push({ type: "keyword", value: shuffled[i] });
  } else {
    // comportamento fallback
    chosenEntries.push({ type: "page", value: 1 });
  }

  const all = [];
  for (const entry of chosenEntries) {
    const pageNum = entry.type === "page" ? entry.value : 1;
    const keyword = entry.type === "keyword" ? entry.value : "";
    const pageOffers = await fetchOffersPage(pageNum, keyword);
    if (Array.isArray(pageOffers) && pageOffers.length > 0) all.push(...pageOffers);
  }

  // dedupe inicial por imageUrl/preferencial
  const map = new Map();
  for (const off of all) {
    const key = `${off.imageUrl || off.offerLink || off.productName}::${off.shopId || ""}`;
    if (!map.has(key)) map.set(key, off);
  }
  return Array.from(map.values());
}

// Busca em páginas 1..3 usando keywords (para endpoint /fetch completo)
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

// ---- Prioritização ----
function parsePrice(val) {
  if (val == null) return null;
  const n = Number(String(val).replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function computeDiscountScore(offer) {
  const max = parsePrice(offer.priceMax);
  const min = parsePrice(offer.priceMin);
  if (max && min && max > min) return ((max - min) / max) * 100;
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
    if (isBlackFridayOffer(off)) bf.push({ off, discountScore, hasCoupon });
    else if (hasCoupon) coupon.push({ off, discountScore, hasCoupon });
    else if (discountScore > 0) withDiscount.push({ off, discountScore, hasCoupon });
    else rest.push({ off, discountScore, hasCoupon });
  }

  const sortDesc = arr => arr.sort((a,b) => (b.discountScore||0) - (a.discountScore||0));
  sortDesc(bf); sortDesc(coupon); sortDesc(withDiscount);

  const ordered = [
    ...bf.map(x => x.off),
    ...coupon.map(x => x.off),
    ...withDiscount.map(x => x.off),
    ...rest.map(x => x.off),
  ];

  // final dedupe mantendo ordem
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
// -------------------------

// Formata mensagem (sem GPT, só formatação simples: 🔥 na frente)
function formatOfferMessagePlain(offer) {
  const isBF = isBlackFridayOffer(offer);
  const coupon = offer.couponLink || offer.coupon_url || offer.coupon || offer.couponCode || null;

  let header = "";
  if (isBF) header = "🔥 *OFERTA BLACK FRIDAY!* \n";
  else if (coupon) header = "🔥 *OFERTA RELÂMPAGO — COM CUPOM!* \n";

  let msg = `${header}🔥 *${offer.productName}*\nDe: ${offer.priceMax}\nPor: *${offer.priceMin}*`;
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

// push util (usa imageUrl como chave preferida para dedupe)
async function pushOffersToTelegram(offers) {
  for (const offer of offers) {
    const uniqueKey = `${offer.imageUrl || offer.offerLink || offer.productName}::${offer.shopId || ""}`;
    if (sentOffers.has(uniqueKey)) continue;
    // marca antes de enviar pra evitar race
    sentOffers.add(uniqueKey);
    await saveSentOffers();

    const msg = formatOfferMessagePlain(offer);
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
    // filtra apenas ofertas não enviadas (por imageUrl / key)
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

// inicialização
await loadSentOffers();
sendOffersToTelegram().catch((e) => console.log("AutoPush init erro:", e?.message || e));

// start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Node HTTP Shopee rodando na porta ${PORT} (pid=${process.pid})`);
  console.log(`USE: GET /fetch, GET /push e GET / (health)`);
});
