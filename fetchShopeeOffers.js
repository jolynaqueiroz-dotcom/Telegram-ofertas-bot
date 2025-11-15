// fetchShopeeOffers.js
// Node ESM - completo com normalização de imagem, dedupe por imagem+preço, OpenAI caption e priorização
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
 * - OPENAI_API_KEY (opcional: para legendas melhores via OpenAI)
 * - OFFERS_PER_PUSH (opcional, default 10)
 * - PUSH_INTERVAL_MINUTES (opcional, default 30)
 * - DELAY_BETWEEN_OFFERS_MS (opcional, default 3000)
 * - PAGES_PER_RUN (opcional, default 3)
 */

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!botToken) console.warn(
  "AVISO: TELEGRAM_BOT_TOKEN não definido (mensagens não serão enviadas)."
);
if (!CHAT_ID) console.warn(
  "AVISO: TELEGRAM_CHAT_ID não definido (mensagens não serão enviadas)."
);

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
// Map: key -> { lastPrice: number|null, lastSentAt: timestamp }
let sentOffersMap = new Map();

/* ---------- Persistence helpers ---------- */
async function loadSentOffers() {
  try {
    const data = await fs.readFile(SENT_FILE, "utf8");
    const arr = JSON.parse(data || "[]");
    sentOffersMap = new Map(arr.map(item => [item.key, { lastPrice: item.lastPrice, lastSentAt: item.lastSentAt }]));
    console.log(`Loaded ${arr.length} sent offers from ${SENT_FILE}`);
  } catch (e) {
    sentOffersMap = new Map();
    if (e.code !== "ENOENT") console.log("Não foi possível ler sent_offers.json:", e.message);
  }
}

async function saveSentOffers() {
  try {
    const arr = Array.from(sentOffersMap.entries()).map(([key, v]) => ({ key, lastPrice: v.lastPrice, lastSentAt: v.lastSentAt }));
    await fs.writeFile(SENT_FILE, JSON.stringify(arr), "utf8");
  } catch (e) {
    console.log("Erro salvando sent_offers.json:", e.message);
  }
}

/* ---------- Utilities ---------- */
function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

function normalizeImageUrl(url) {
  if (!url || typeof url !== "string") return url || "";
  try {
    const u = new URL(url);
    u.search = "";
    return u.toString();
  } catch (e) {
    return url.split("?")[0];
  }
}

function makeImageKey(offer) {
  // prefer image normalized; fallback to offerLink+productName
  const img = normalizeImageUrl(offer?.imageUrl || "");
  if (img) return sha256Hex(img);
  return sha256Hex(`${offer?.offerLink || ""}::${offer?.productName || ""}`);
}

function parsePrice(val) {
  if (val == null) return null;
  const s = String(val).replace(/\s+/g, "");
  // remove currency symbols and letters
  const cleaned = s.replace(/[^\d.,-]/g, "").replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // round to cents
  return Math.round(n * 100) / 100;
}

/* ---------- Shopee payload / fetch ---------- */
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

/* ---------- Pages / Keywords rotation ---------- */
function parseShopeePagesEnv() {
  const raw = (process.env.SHOPEE_PAGES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      // número puro -> treat as page
      if (/^\d+$/.test(s)) return { type: "page", value: Number(s) };
      // else treat as keyword
      return { type: "keyword", value: s };
    });
}

async function fetchOffersFromPagesOrKeywords() {
  const parsed = parseShopeePagesEnv();
  const keywordsEnv = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
  const keywordsFallback = keywordsEnv ? keywordsEnv.split(",").map(k => k.trim()).filter(Boolean) : [];

  const chosenEntries = [];
  if (parsed.length > 0) {
    // shuffle and pick up to PAGES_PER_RUN
    const shuffled = parsed.sort(() => 0.5 - Math.random());
    for (let i = 0; i < Math.min(PAGES_PER_RUN, shuffled.length); i++) chosenEntries.push(shuffled[i]);
  } else if (keywordsFallback.length > 0) {
    const shuffled = keywordsFallback.sort(() => 0.5 - Math.random());
    for (let i = 0; i < Math.min(PAGES_PER_RUN, shuffled.length); i++) chosenEntries.push({ type: "keyword", value: shuffled[i] });
  } else {
    chosenEntries.push({ type: "page", value: 1 });
  }

  const all = [];
  for (const entry of chosenEntries) {
    const pageNum = entry.type === "page" ? entry.value : 1;
    const keyword = entry.type === "keyword" ? entry.value : "";
    const pageOffers = await fetchOffersPage(pageNum, keyword);
    if (Array.isArray(pageOffers) && pageOffers.length > 0) {
      all.push(...pageOffers);
    }
  }

  // dedupe by normalized image or link before returning
  const map = new Map();
  for (const off of all) {
    const key = `${normalizeImageUrl(off.imageUrl || "") || (off.offerLink || off.productName)}::${off.shopId || ""}`;
    if (!map.has(key)) map.set(key, off);
  }
  return Array.from(map.values());
}

/* ---------- fetchOffersAllPages (full scan helper) ---------- */
async function fetchOffersAllPages(keywords = []) {
  const pagesToCheck = [1, 2, 3];
  const map = new Map();
  if (!Array.isArray(keywords) || keywords.length === 0) keywords = [""];
  for (const kw of keywords) {
    for (const p of pagesToCheck) {
      const pageOffers = await fetchOffersPage(p, kw);
      for (const off of pageOffers) {
        const key = `${normalizeImageUrl(off.imageUrl || "") || off.offerLink || off.productName}::${off.shopId || ""}`;
        if (!map.has(key)) map.set(key, off);
      }
    }
  }
  return Array.from(map.values());
}

/* ---------- Prioritization ---------- */
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
    const key = `${normalizeImageUrl(off.imageUrl || "") || off.offerLink || off.productName}::${off.shopId || ""}`;
    if (!map.has(key)) map.set(key, off);
  }
  const uniq = Array.from(map.values());

  const bf = [], coupon = [], withDiscount = [], rest = [];

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

  // final dedupe preserve order
  const seen = new Set();
  const final = [];
  for (const o of ordered) {
    const k = `${normalizeImageUrl(o.imageUrl || "") || o.offerLink || o.productName}::${o.shopId || ""}`;
    if (!seen.has(k)) { seen.add(k); final.push(o); }
  }
  return final;
}

/* ---------- OpenAI caption (optional) ---------- */
async function generateOpenAICaption(productName) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return productName;
    // prompt: keep short; we will prepend 🔥 ourselves
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

/* ---------- Message formatting ---------- */
async function formatOfferMessage(offer) {
  const captionRaw = await generateOpenAICaption(offer.productName || "");
  // prepend 🔥 as requested
  const caption = `🔥 ${captionRaw}`;
  const coupon = offer.couponLink || offer.coupon_url || offer.coupon || offer.couponCode || null;
  const isBF = isBlackFridayOffer(offer);

  let header = "";
  if (isBF) header = "🔥 *OFERTA BLACK FRIDAY!* \n";
  else if (coupon) header = "🔥 *OFERTA RELÂMPAGO — COM CUPOM!* \n";

  // show price formatting (no strike for "De", user wanted no tildes)
  const priceMax = offer.priceMax || "";
  const priceMin = offer.priceMin || "";
  let msg = `${header}*${caption}*\nDe: ${priceMax}\nPor: *${priceMin}*`;
  if (coupon) msg += `\n🎟️ [Cupons desconto](${coupon})`;
  msg += `\n🛒 [Link da oferta](${offer.offerLink})`;
  return msg;
}

/* ---------- Endpoints ---------- */
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
      const keywords = keywordsEnv ? keywordsEnv.split(",").map(k => k.trim()).filter(Boolean) : [];
      offers = await fetchOffersAllPages(keywords);
    }
    const prioritized = prioritizeOffers(offers);
    res.json({ offers: prioritized });
  } catch (e) {
    console.log("Erro geral no /fetch:", e);
    res.status(500).json({ error: "Erro interno ao buscar ofertas" });
  }
});

/* ---------- Sending with dedupe logic ---------- */
async function pushOffersToTelegram(offers) {
  // dedupe by image-key in this batch
  const batchSeen = new Set();
  const filtered = [];
  for (const off of offers) {
    const k = makeImageKey(off);
    if (!batchSeen.has(k)) { batchSeen.add(k); filtered.push(off); }
  }

  for (const offer of filtered) {
    const key = makeImageKey(offer);
    const currentPrice = parsePrice(offer.priceMin || offer.priceMax);
    const meta = sentOffersMap.get(key);

    // If already sent and price equals (within cents), skip
    if (meta && meta.lastPrice != null) {
      const saved = Math.round(meta.lastPrice * 100)/100;
      const nowp = currentPrice == null ? null : Math.round(currentPrice * 100)/100;
      if (nowp !== null && saved === nowp) {
        // same price => skip
        continue;
      }
    }

    // mark prior to sending to avoid races
    sentOffersMap.set(key, { lastPrice: currentPrice, lastSentAt: Date.now() });
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
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_OFFERS_MS));
    } catch (err) {
      console.log("Erro ao enviar oferta para Telegram:", err?.message || err);
      // on failure we keep the mark so we don't repeatedly attempt same failing offer
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
      const keywords = keywordsEnv ? keywordsEnv.split(",").map(k => k.trim()).filter(Boolean) : [];
      all = await fetchOffersAllPages(keywords);
    }

    const prioritized = prioritizeOffers(all);

    // dedupe prioritized by makeImageKey and remove those already sent with same price
    const uniquePrioritized = [];
    const seen = new Set();
    for (const off of prioritized) {
      const k = makeImageKey(off);
      if (seen.has(k)) continue;
      seen.add(k);
      // check price vs persisted
      const meta = sentOffersMap.get(k);
      const currentPrice = parsePrice(off.priceMin || off.priceMax);
      if (meta && meta.lastPrice != null && currentPrice != null) {
        const saved = Math.round(meta.lastPrice * 100)/100;
        const nowp = Math.round(currentPrice * 100)/100;
        if (saved === nowp) {
          // skip (same price)
          continue;
        }
      }
      uniquePrioritized.push(off);
    }

    const toSend = uniquePrioritized.slice(0, OFFERS_PER_PUSH);
    await pushOffersToTelegram(toSend);
    res.json({ sent: toSend.length });
  } catch (err) {
    console.log("Erro ao enviar para o Telegram:", err);
    res.status(500).json({ error: "Erro ao enviar para o Telegram" });
  }
});

/* ---------- AutoPush ---------- */
async function sendOffersToTelegram() {
  try {
    const pagesList = parseShopeePagesEnv();
    let all = [];
    if (pagesList.length > 0) {
      all = await fetchOffersFromPagesOrKeywords();
    } else {
      const keywordsEnv = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
      const keywords = keywordsEnv ? keywordsEnv.split(",").map(k => k.trim()).filter(Boolean) : [];
      all = await fetchOffersAllPages(keywords);
    }
    const prioritized = prioritizeOffers(all);

    // filter ones not sent with same price
    const unique = [];
    for (const offer of prioritized) {
      const key = makeImageKey(offer);
      const meta = sentOffersMap.get(key);
      const currentPrice = parsePrice(offer.priceMin || offer.priceMax);
      if (meta && meta.lastPrice != null && currentPrice != null) {
        const saved = Math.round(meta.lastPrice * 100)/100;
        const nowp = Math.round(currentPrice * 100)/100;
        if (saved === nowp) continue; // skip
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

/* ---------- Init ---------- */
await loadSentOffers();
sendOffersToTelegram().catch((e) => console.log("AutoPush init erro:", e?.message || e));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Node HTTP Shopee rodando na porta ${PORT} (pid=${process.pid})`);
  console.log(`USE: GET /fetch, GET /push e GET / (health)`);
});