// fetchShopeeOffers.js
// Node ESM - pronto com dedupe robusto (chave por imagem), SHA256, OpenAI caption e AutoPush

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
// sentOffersMap: key (hash) -> lastPrice (number|null)
let sentOffersMap = new Map();

async function loadSentOffers() {
  try {
    const data = await fs.readFile(SENT_FILE, "utf8");
    const obj = JSON.parse(data || "{}");
    sentOffersMap = new Map(Object.entries(obj));
    console.log(`Loaded ${sentOffersMap.size} sent offers from ${SENT_FILE}`);
  } catch (e) {
    sentOffersMap = new Map();
    if (e.code !== "ENOENT") console.log("Não foi possível ler sent_offers.json:", e.message);
  }
}

async function saveSentOffers() {
  try {
    // converte Map para objeto simples
    const obj = {};
    for (const [k, v] of sentOffersMap.entries()) obj[k] = v;
    await fs.writeFile(SENT_FILE, JSON.stringify(obj), "utf8");
  } catch (e) {
    console.log("Erro salvando sent_offers.json:", e.message);
  }
}

// util sha256
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// parsing de preço (tenta extrair número)
function parsePrice(val) {
  if (val == null) return null;
  try {
    // aceita "12.34", "12,34", "R$ 12,34" etc.
    const cleaned = String(val).replace(/[^\d,.-]/g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Gera payload padrão (usa PAYLOAD_SHOPEE se definido)
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

// busca várias páginas e dedup local (por offerLink/image/productName+shopId)
async function fetchOffersAllPages(keywords = []) {
  const pagesToCheck = [1, 2, 3]; // pode aumentar se quiser mais alcance
  const map = new Map();
  if (!Array.isArray(keywords) || keywords.length === 0) keywords = [""];

  for (const kw of keywords) {
    for (const p of pagesToCheck) {
      const pageOffers = await fetchOffersPage(p, kw);
      for (const off of pageOffers) {
        const key = `${off.offerLink || off.imageUrl || off.productName}::${off.shopId || ""}`;
        if (!map.has(key)) map.set(key, off);
      }
    }
  }
  return Array.from(map.values());
}

// priorização (Black Friday, cupom, maior desconto)
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
    const key = `${off.offerLink || off.imageUrl || off.productName}::${off.shopId || ""}`;
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

  const sortDesc = (arr) => arr.sort((a, b) => (b.discountScore || 0) - (a.discountScore || 0));

  sortDesc(bf);
  sortDesc(coupon);
  sortDesc(withDiscount);

  const ordered = [
    ...bf.map((x) => x.off),
    ...coupon.map((x) => x.off),
    ...withDiscount.map((x) => x.off),
    ...rest.map((x) => x.off),
  ];

  const seen = new Set();
  const final = [];
  for (const o of ordered) {
    const k = `${o.offerLink || o.imageUrl || o.productName}::${o.shopId || ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      final.push(o);
    }
  }
  return final;
}

// OpenAI caption (se OPENAI_API_KEY estiver definido)
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

// Formata a mensagem (inclui 🔥 e cupons se houver)
async function formatOfferMessage(offer) {
  const caption = await generateOpenAICaption(offer.productName || "");
  const coupon = offer.couponLink || offer.coupon_url || offer.coupon || offer.couponCode || null;

  const isBF = isBlackFridayOffer(offer);
  let header = "";
  if (isBF) header = "🔥 *OFERTA BLACK FRIDAY!* \n";
  else if (coupon) header = "🔥 *OFERTA RELÂMPAGO — COM CUPOM!* \n";

  // sempre adicionar 🔥 antes da legenda principal para destacar
  const main = `🔥 ${caption}`;
  let msg = `${header}${main}\nDe: ${offer.priceMax}\nPor: *${offer.priceMin}*`;
  if (coupon) msg += `\n🎟️ [Cupons desconto](${coupon})`;
  msg += `\n🛒 [Link da oferta](${offer.offerLink})`;
  return msg;
}

// ----------------- NOVO: Normalização / chave robusta -----------------
function normalizeOfferKey(offer) {
  // prefer imageUrl, fallback to offerLink, fallback to productName+shopId
  const rawCandidate =
    (offer.imageUrl && String(offer.imageUrl).trim()) ||
    (offer.offerLink && String(offer.offerLink).trim()) ||
    (`${(offer.productName || "").trim()}::${offer.shopId || ""}`);

  if (!rawCandidate) return null;

  try {
    // remove query string and fragment
    let cleaned = rawCandidate.replace(/\?.*$/, "").replace(/#.*$/, "").trim().toLowerCase();

    // remove common tracking params if present (generic)
    cleaned = cleaned.replace(/utm_[^&=]+=[^&]*/g, "").replace(/(&){2,}/g, "&").replace(/^&|&$/g, "");

    // if it's an URL path, we can take last path + filename part to reduce variance
    try {
      const u = new URL(cleaned);
      cleaned = u.pathname.replace(/\/+$/, "") || u.hostname || cleaned;
    } catch (e) {
      // not a URL, keep cleaned as-is
    }

    // finally hash it (curto e consistente)
    return sha256Hex(cleaned);
  } catch (e) {
    return sha256Hex(String(rawCandidate));
  }
}
// ----------------------------------------------------------------------

// START endpoints
app.get("/", (req, res) => {
  res.send(`ok - pid=${process.pid} PORT=${PORT}`);
});

app.get("/fetch", async (req, res) => {
  try {
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
    const keywordsEnv = envKeys || "";
    const keywords = keywordsEnv
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const offers = await fetchOffersAllPages(keywords);
    const prioritized = prioritizeOffers(offers);
    res.json({ offers: prioritized });
  } catch (e) {
    console.log("Erro geral no /fetch:", e);
    res.status(500).json({ error: "Erro interno ao buscar ofertas" });
  }
});

// --- push: envia uma lista de ofertas (utilizada por /push e AutoPush) ---
async function pushOffersToTelegram(offers) {
  for (const offer of offers) {
    const key = normalizeOfferKey(offer);
    if (!key) {
      console.log("Oferta sem chave válida, pulando:", offer.productName || offer.offerLink);
      continue;
    }

    // verifica se já enviamos essa chave e com o mesmo preço
    const lastPriceRaw = sentOffersMap.get(key);
    const lastPrice = lastPriceRaw != null ? Number(lastPriceRaw) : null;
    const priceMin = parsePrice(offer.priceMin);

    if (lastPrice !== null && priceMin !== null && Number(lastPrice) === Number(priceMin)) {
      // mesma oferta e mesmo preço -> pular
      continue;
    }

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

      // APÓS envio bem-sucedido, registrar chave com preço atual (ou null)
      sentOffersMap.set(key, priceMin ?? null);
      await saveSentOffers();

      // atraso entre envios
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_OFFERS_MS));
    } catch (err) {
      console.log("Erro ao enviar oferta para Telegram (não marcando como enviada):", err?.message || err);
      // não marcamos como enviada se falhou
    }
  }
}

// route /push: força um envio agora (usa keywords)
app.get("/push", async (req, res) => {
  try {
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
    const keywordsEnv = envKeys || "";
    const keywords = keywordsEnv
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    const all = await fetchOffersAllPages(keywords);
    const prioritized = prioritizeOffers(all);

    // filtra por chaves que não estão no sentOffersMap (ou que mudaram de preço)
    const unique = [];
    for (const offer of prioritized) {
      const key = normalizeOfferKey(offer);
      if (!key) continue;
      const lastPriceRaw = sentOffersMap.get(key);
      const lastPrice = lastPriceRaw != null ? Number(lastPriceRaw) : null;
      const priceMin = parsePrice(offer.priceMin);
      if (lastPrice !== null && priceMin !== null && Number(lastPrice) === Number(priceMin)) {
        continue; // mesma oferta e mesmo preço -> pular
      }
      unique.push(offer);
    }

    const toSend = unique.slice(0, OFFERS_PER_PUSH);
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
    const keywordsEnv = envKeys || "";
    const keywords = keywordsEnv
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const all = await fetchOffersAllPages(keywords);
    const prioritized = prioritizeOffers(all);

    // filtra por chaves não enviadas ou preço alterado
    const unique = [];
    for (const offer of prioritized) {
      const key = normalizeOfferKey(offer);
      if (!key) continue;
      const lastPriceRaw = sentOffersMap.get(key);
      const lastPrice = lastPriceRaw != null ? Number(lastPriceRaw) : null;
      const priceMin = parsePrice(offer.priceMin);
      if (lastPrice !== null && priceMin !== null && Number(lastPrice) === Number(priceMin)) {
        continue;
      }
      unique.push(offer);
    }

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