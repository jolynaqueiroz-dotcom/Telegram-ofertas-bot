// fetchShopeeOffers.js
// Node ESM - dedupe preferencial por imagem (image hash), com fallback por link/nome
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
 * - KEYWORDS (opcional, csv - fallback)
 * - OPENAI_API_KEY (opcional: para legendas melhores via OpenAI)
 * - OFFERS_PER_PUSH (opcional, default 10)
 * - PUSH_INTERVAL_MINUTES (opcional, default 30)
 * - DELAY_BETWEEN_OFFERS_MS (opcional, default 3000)
 * - IMAGE_FETCH_TIMEOUT_MS (opcional, default 7000)
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
const IMAGE_FETCH_TIMEOUT_MS = Number(process.env.IMAGE_FETCH_TIMEOUT_MS || 7000);

// arquivo local para persistir dedupe entre reboots
const SENT_FILE = path.resolve("./sent_offers.json");
// estrutura: { "<uniqueKey>": { sentAt: 169..., lastPriceMin: "19.99", nameHash: "...", imageHash: "..." }, ... }
let sentOffers = {}; // objeto em memória

async function loadSentOffers() {
  try {
    const data = await fs.readFile(SENT_FILE, "utf8");
    sentOffers = JSON.parse(data || "{}");
    console.log(`Loaded ${Object.keys(sentOffers).length} sent offers from ${SENT_FILE}`);
  } catch (e) {
    sentOffers = {};
    if (e.code !== "ENOENT") console.log("Não foi possível ler sent_offers.json:", e.message);
  }
}

async function saveSentOffers() {
  try {
    await fs.writeFile(SENT_FILE, JSON.stringify(sentOffers, null, 2), "utf8");
  } catch (e) {
    console.log("Erro salvando sent_offers.json:", e.message);
  }
}

// util sha256
function sha256HexStr(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

// canonicalize URL: retira query string e hash, deixa origin + pathname (remove trailing slash)
function canonicalizeUrl(raw) {
  if (!raw) return null;
  try {
    let u = raw.trim();
    if (!u.startsWith("http://") && !u.startsWith("https://")) {
      u = "https://" + u.replace(/^\/+/, "");
    }
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch (e) {
    return raw.replace(/\?.*$/, "").replace(/#.*$/, "").trim();
  }
}

// Normalize name
function normalizeName(name, maxWords = 12) {
  if (!name) return "";
  const withoutAccents = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const alpha = withoutAccents.replace(/[^0-9a-zA-Z\s]/g, " ");
  const parts = alpha
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, maxWords);
  return parts.join(" ").toLowerCase();
}

// nameHash (nome normalizado + shopId)
function computeNameHash(offer) {
  const shop = offer?.shopId || offer?.shop_id || "";
  const nm = normalizeName(offer?.productName || offer?.product_name || "", 12);
  return sha256HexStr(`NAME:${nm}::S:${shop}`);
}

// image hash cache (em memória) - persistiremos via sentOffers entries (cada item pode ter imageHash)
const imageHashCache = new Map();

// baixa a imagem e calcula sha256 dos bytes (retorna string hex) - timeout e erros tratados
async function getImageHash(url) {
  if (!url) return null;
  try {
    const canon = canonicalizeUrl(url);
    if (imageHashCache.has(canon)) return imageHashCache.get(canon);

    const resp = await axios.get(canon, {
      responseType: "arraybuffer",
      timeout: IMAGE_FETCH_TIMEOUT_MS,
      maxContentLength: 5 * 1024 * 1024, // 5MB cap
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0)" },
    });
    const buf = Buffer.from(resp.data);
    const h = sha256HexStr(buf);
    imageHashCache.set(canon, h);
    return h;
  } catch (err) {
    // falha no download -> retorna null (seguimos com fallback)
    // console.log("getImageHash error:", err?.message || err);
    return null;
  }
}

// computeUniqueKey: prefere imageHash -> canonical offer link -> canonical image url -> nameHash
async function computeUniqueKey(offer) {
  // tenta image hash primeiro (assincronamente)
  const image = offer?.imageUrl || offer?.image_url || null;
  if (image) {
    const iHash = await getImageHash(image);
    if (iHash) return `I:${iHash}::S:${offer?.shopId || offer?.shop_id || ""}`;
  }

  const link = offer?.offerLink || offer?.offer_link || offer?.offer_url || null;
  if (link) {
    const canon = canonicalizeUrl(link);
    return `L:${sha256HexStr(canon)}::S:${offer?.shopId || offer?.shop_id || ""}`;
  }

  // fallback image canonical url hashed
  if (image) {
    const canonImg = canonicalizeUrl(image);
    return `ImgUrl:${sha256HexStr(canonImg)}::S:${offer?.shopId || offer?.shop_id || ""}`;
  }

  // por fim, nameHash
  const nameHash = computeNameHash(offer);
  return `N:${nameHash}`;
}

// procura uma entry existente por nameHash (retorna uniqueKey ou null)
function findExistingKeyByNameHash(nameHash) {
  for (const k of Object.keys(sentOffers)) {
    if (sentOffers[k] && sentOffers[k].nameHash === nameHash) return k;
  }
  return null;
}

// parsePrice
function parsePrice(val) {
  if (val == null) return null;
  const s = String(val).replace(/\s/g, "");
  const cleaned = s.replace(/[^\d.,]/g, "").replace(/\.(?=\d{3,})/g, "");
  const normalized = cleaned.replace(",", ".");
  const n = Number(normalized);
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
    const key = JSON.stringify([off.offerLink || off.imageUrl || off.productName, off.shopId || ""]);
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

  // garantir unicidade por chave calculada simples (link/image/name)
  const seen = new Set();
  const final = [];
  for (const o of ordered) {
    const k = JSON.stringify([o.offerLink || o.imageUrl || o.productName, o.shopId || ""]);
    if (!seen.has(k)) {
      seen.add(k);
      final.push(o);
    }
  }
  return final;
}

// Shopee fetch helpers
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
    const signature = sha256HexStr(signFactor);

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

async function fetchOffersAllPages(keywords = []) {
  const pagesToCheck = [1, 2, 3];
  const map = new Map();
  if (!Array.isArray(keywords) || keywords.length === 0) keywords = [""];

  for (const kw of keywords) {
    for (const p of pagesToCheck) {
      const pageOffers = await fetchOffersPage(p, kw);
      for (const off of pageOffers) {
        const key = JSON.stringify([off.offerLink || off.imageUrl || off.productName, off.shopId || ""]);
        if (!map.has(key)) map.set(key, off);
      }
    }
  }
  return Array.from(map.values());
}

// OpenAI caption (opcional)
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
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
    const keywordsEnv = envKeys;
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

// push util com persistência de identidade (imageHash/nameHash)
async function pushOffersToTelegram(offers) {
  for (const offer of offers) {
    // compute a chave preferencial (tenta image hash)
    const nameHash = computeNameHash(offer);
    let uniqueKey;
    // try to compute an image hash (await inside)
    const imageUrl = offer?.imageUrl || offer?.image_url || null;
    let imageHash = null;
    if (imageUrl) {
      try {
        imageHash = await getImageHash(imageUrl);
      } catch (e) {
        imageHash = null;
      }
    }

    if (imageHash) {
      uniqueKey = `I:${imageHash}::S:${offer?.shopId || offer?.shop_id || ""}`;
    } else if (offer?.offerLink) {
      const canon = canonicalizeUrl(offer.offerLink);
      uniqueKey = `L:${sha256HexStr(canon)}::S:${offer?.shopId || offer?.shop_id || ""}`;
    } else if (imageUrl) {
      const canonImg = canonicalizeUrl(imageUrl);
      uniqueKey = `ImgUrl:${sha256HexStr(canonImg)}::S:${offer?.shopId || offer?.shop_id || ""}`;
    } else {
      uniqueKey = `N:${nameHash}`;
    }

    // se já existe algum registro com o mesmo nameHash, usa essa key pra comparar
    const existingByName = findExistingKeyByNameHash(nameHash);
    const useKey = existingByName || uniqueKey;

    const existing = sentOffers[useKey];
    const currentPriceMin = offer.priceMin != null ? String(offer.priceMin) : null;

    if (existing) {
      const prevPrice = existing.lastPriceMin != null ? String(existing.lastPriceMin) : null;
      if (prevPrice === currentPriceMin) {
        // mesma oferta (mesmo name/image/key) e mesmo preço => pular
        continue;
      }
      // preço diferente => vamos enviar e atualizar
    }

    // marca antes para evitar race conditions
    sentOffers[useKey] = { sentAt: Date.now(), lastPriceMin: currentPriceMin, nameHash, imageHash: imageHash || null };
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
      // mantemos a marcação para evitar spam em caso de falha repetida
    }
  }
}

app.get("/push", async (req, res) => {
  try {
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || "").trim();
    const keywordsEnv = envKeys;
    const keywords = keywordsEnv
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
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
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const all = await fetchOffersAllPages(keywords);
    const prioritized = prioritizeOffers(all);
    // Filtra apenas ofertas novas (ou com priceMin diferente)
    const unique = [];
    for (const offer of prioritized) {
      const nameHash = computeNameHash(offer);
      const existingKey = findExistingKeyByNameHash(nameHash);
      if (!existingKey) {
        unique.push(offer);
        continue;
      }
      const prev = sentOffers[existingKey];
      const prevPrice = prev?.lastPriceMin != null ? String(prev.lastPriceMin) : null;
      if (String(offer.priceMin) !== prevPrice) unique.push(offer);
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
