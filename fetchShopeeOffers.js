// fetchShopeeOffers.js
// Node ESM - completo com suporte a categoryIds, shopType, direct URLs, OpenAI captions e dedupe por imagem

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
 * - PAYLOAD_SHOPEE (opcional JSON string) - usado como base; será injetado page/keyword/categoryId/shopType
 * - SHOPEE_KEYWORDS (csv grande) - preferencial
 * - KEYWORDS (fallback csv)
 * - SHOPEE_CATEGORY_IDS (csv de categoryId, ex: 123,456)
 * - SHOPEE_DIRECT_URLS (csv de URLs públicas, ex: https://s.shopee.com.br/5L46qCJE2r)
 * - SHOPEE_SHOP_TYPE (csv de shopType ints, ex: "1,4")
 * - OPENAI_API_KEY (opcional: para legendas melhores via OpenAI)
 * - OFFERS_PER_PUSH (default 10)
 * - PUSH_INTERVAL_MINUTES (default 30)
 * - DELAY_BETWEEN_OFFERS_MS (default 3000)
 */

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!botToken) console.warn("AVISO: TELEGRAM_BOT_TOKEN não definido (mensagens não serão enviadas).");
if (!CHAT_ID) console.warn("AVISO: TELEGRAM_CHAT_ID não definido (mensagens não serão enviadas).");

const bot = botToken ? new TelegramBot(botToken) : null;

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const SHOPEE_URL = "https://open-api.affiliate.shopee.com.br/graphql"; // seu endpoint GraphQL afiliado
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

// Default payload (mantido compatível com sua versão anterior)
function defaultPayload(page, keyword = "") {
  return {
    query:
      "query productOfferV2($keyword: String,$limit: Int,$page: Int){productOfferV2(keyword:$keyword,limit:$limit,page:$page){nodes{productName imageUrl videoUrl offerLink priceMin priceMax shopId couponLink}pageInfo{hasNextPage}}}",
    variables: { keyword, limit: 30, page },
  };
}

// Cria payload compatível, injetando categoryId/shopType quando fornecido
function makePayloadForPage(page, keyword = "", categoryId = null, shopTypeArr = null) {
  if (PAYLOAD_ENV) {
    try {
      const p = JSON.parse(PAYLOAD_ENV);
      if (p.variables && typeof p.variables === "object") {
        p.variables.page = page;
        if ("keyword" in p.variables) p.variables.keyword = keyword;
        // injeta categoryId/shopType se existirem
        if (categoryId != null) p.variables.categoryId = Number(categoryId);
        if (Array.isArray(shopTypeArr) && shopTypeArr.length) p.variables.shopType = shopTypeArr.map(Number);
      } else {
        p.variables = { keyword, limit: 30, page };
        if (categoryId != null) p.variables.categoryId = Number(categoryId);
        if (Array.isArray(shopTypeArr) && shopTypeArr.length) p.variables.shopType = shopTypeArr.map(Number);
      }
      return p;
    } catch (e) {
      console.log("PAYLOAD_SHOPEE inválido no env; usando payload padrão.");
    }
  }

  const base = defaultPayload(page, keyword);
  if (categoryId != null) base.variables.categoryId = Number(categoryId);
  if (Array.isArray(shopTypeArr) && shopTypeArr.length) base.variables.shopType = shopTypeArr.map(Number);
  return base;
}

async function fetchOffersPage(page = 1, keyword = "", categoryId = null, shopTypeArr = null) {
  let offersPage = [];
  try {
    const payloadObj = makePayloadForPage(page, keyword, categoryId, shopTypeArr);
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
      console.log(`Shopee retornou status ${resp.status} para página ${page} (kw=${keyword} cat=${categoryId})`);
    }
  } catch (err) {
    console.log("Erro ao buscar ofertas:", err?.message || err);
  }
  return offersPage;
}

// Tenta carregar ofertas a partir de URLs diretas (ex: páginas Black Friday / flash)
// Nota: algumas páginas podem responder HTML — tentamos extrair JSON se vier
async function fetchOffersFromDirectUrl(url) {
  try {
    const resp = await axios.get(url, { timeout: 20000 });
    const data = resp.data;
    // se for JSON com "offers" ou "nodes" tenta extrair
    if (data && typeof data === "object") {
      const nodes = data.offers || data.nodes || data.items || [];
      if (Array.isArray(nodes)) return nodes;
    }
    // se resposta for string (HTML) não conseguimos parsear confiavelmente aqui — retorna []
    return [];
  } catch (err) {
    console.log("Erro fetch direct url:", url, err?.message || err);
    return [];
  }
}

// Busca em várias páginas / categorias, juntando sem duplicatas (por imageUrl ou offerLink)
async function fetchOffersAllPages(options = {}) {
  const {
    keywords = [""],
    pagesToCheck = [1, 2, 3],
    categoryIds = [],
    shopTypeArr = [],
    directUrls = [],
  } = options;

  const map = new Map(); // key -> offer

  // 1) Busca por keywords + categoryIds
  const keywordsToUse = Array.isArray(keywords) && keywords.length ? keywords : [""];
  const categoryList = Array.isArray(categoryIds) && categoryIds.length ? categoryIds : [null];

  for (const kw of keywordsToUse) {
    for (const cat of categoryList) {
      for (const p of pagesToCheck) {
        const pageOffers = await fetchOffersPage(p, kw, cat, shopTypeArr);
        for (const off of pageOffers) {
          // key prefer imageUrl else link else productName
          const key = (off.imageUrl || off.offerLink || off.productName || "") + "::" + (off.shopId || "");
          if (!map.has(key)) map.set(key, off);
        }
      }
    }
  }

  // 2) Direct URLs (Black Friday / Flash deals)
  for (const url of directUrls) {
    const nodes = await fetchOffersFromDirectUrl(url);
    for (const off of nodes) {
      const key = (off.imageUrl || off.offerLink || off.productName || "") + "::" + (off.shopId || "");
      if (!map.has(key)) map.set(key, off);
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
  // uniq by imageUrl/offerLink/productName+shopId
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

  // final dedupe by same key
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

// ---------- OpenAI caption (se OPENAI_API_KEY estiver definido) ----------
// Gera uma legenda curta; sempre retornamos texto SEM emojis adicionados, e em seguida
// adicionamos manualmente o 🔥 na frente (como você pediu).
async function generateOpenAICaption(productName) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return productName;

    const prompt = `Escreva uma legenda curta, persuasiva e natural para divulgar este produto em um grupo de ofertas no Telegram. Produto: ${productName}\nResponda em 1-2 linhas, linguagem coloquial, sem incluir emojis no texto de saída.`;

    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
        temperature: 0.75,
      },
      {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        timeout: 12000,
      }
    );
    const text = resp.data?.choices?.[0]?.message?.content;
    return (text && text.trim()) || productName;
  } catch (err) {
    console.log("Erro OpenAI (usando nome do produto):", err?.message || err);
    return productName;
  }
}

// Formata mensagem com preços, cupons e link; adiciona 🔥 manualmente no início da legenda
async function formatOfferMessage(offer) {
  const rawCaption = await generateOpenAICaption(offer.productName || "");
  // adiciona o 🔥 conforme seu pedido
  const caption = `🔥 ${rawCaption}`;
  const coupon = offer.couponLink || offer.coupon_url || offer.coupon || offer.couponCode || null;

  let header = "";
  if (isBlackFridayOffer(offer)) header = "🔥 *OFERTA BLACK FRIDAY!* \n";
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

// /fetch — retorna ofertas aplicando keywords, categoryIds e directUrls
app.get("/fetch", async (req, res) => {
  try {
    // prefer SHOPEE_KEYWORDS env, fallback KEYWORDS env, fallback DEFAULT_SHOPEE_KEYWORDS
    const DEFAULT_SHOPEE_KEYWORDS = (process.env.DEFAULT_SHOPEE_KEYWORDS || "").trim();
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || DEFAULT_SHOPEE_KEYWORDS || "").trim();
    const keywords = envKeys ? envKeys.split(",").map((k) => k.trim()).filter(Boolean) : [""];

    // category ids
    const catEnv = (process.env.SHOPEE_CATEGORY_IDS || "").trim();
    const categoryIds = catEnv ? catEnv.split(",").map((c) => c.trim()).filter(Boolean) : [];

    // shop type
    const shopTypeEnv = (process.env.SHOPEE_SHOP_TYPE || "").trim();
    const shopTypeArr = shopTypeEnv ? shopTypeEnv.split(",").map((s) => s.trim()).filter(Boolean) : [];

    // direct urls (ex: black friday / flash)
    const directEnv = (process.env.SHOPEE_DIRECT_URLS || "").trim();
    const directUrls = directEnv ? directEnv.split(",").map((u) => u.trim()).filter(Boolean) : [];

    const offers = await fetchOffersAllPages({
      keywords,
      pagesToCheck: [1, 2, 3],
      categoryIds,
      shopTypeArr,
      directUrls,
    });

    const prioritized = prioritizeOffers(offers);
    res.json({ offers: prioritized });
  } catch (e) {
    console.log("Erro geral no /fetch:", e);
    res.status(500).json({ error: "Erro interno ao buscar ofertas" });
  }
});

// envio util com persistência e dedupe por imageUrl preferencialmente
async function pushOffersToTelegram(offers) {
  for (const offer of offers) {
    // chave única prefer imageUrl; se não existir, usa offerLink
    const uniqueKey = `${offer.imageUrl || offer.offerLink || offer.productName}::${offer.shopId || ""}`;
    if (sentOffers.has(uniqueKey)) {
      // já enviado anteriormente
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
      // marca e persiste somente após envio bem-sucedido
      sentOffers.add(uniqueKey);
      await saveSentOffers();

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_OFFERS_MS));
    } catch (err) {
      console.log("Erro ao enviar oferta para Telegram:", err?.message || err);
      // se falhar, não marca para tentar novamente no próximo ciclo
    }
  }
}

app.get("/push", async (req, res) => {
  try {
    const DEFAULT_SHOPEE_KEYWORDS = (process.env.DEFAULT_SHOPEE_KEYWORDS || "").trim();
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || DEFAULT_SHOPEE_KEYWORDS || "").trim();
    const keywords = envKeys ? envKeys.split(",").map((k) => k.trim()).filter(Boolean) : [""];

    const catEnv = (process.env.SHOPEE_CATEGORY_IDS || "").trim();
    const categoryIds = catEnv ? catEnv.split(",").map((c) => c.trim()).filter(Boolean) : [];

    const shopTypeEnv = (process.env.SHOPEE_SHOP_TYPE || "").trim();
    const shopTypeArr = shopTypeEnv ? shopTypeEnv.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const directEnv = (process.env.SHOPEE_DIRECT_URLS || "").trim();
    const directUrls = directEnv ? directEnv.split(",").map((u) => u.trim()).filter(Boolean) : [];

    const all = await fetchOffersAllPages({
      keywords,
      pagesToCheck: [1, 2, 3],
      categoryIds,
      shopTypeArr,
      directUrls,
    });

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
    const DEFAULT_SHOPEE_KEYWORDS = (process.env.DEFAULT_SHOPEE_KEYWORDS || "").trim();
    const envKeys = (process.env.SHOPEE_KEYWORDS || process.env.KEYWORDS || DEFAULT_SHOPEE_KEYWORDS || "").trim();
    const keywords = envKeys ? envKeys.split(",").map((k) => k.trim()).filter(Boolean) : [""];

    const catEnv = (process.env.SHOPEE_CATEGORY_IDS || "").trim();
    const categoryIds = catEnv ? catEnv.split(",").map((c) => c.trim()).filter(Boolean) : [];

    const shopTypeEnv = (process.env.SHOPEE_SHOP_TYPE || "").trim();
    const shopTypeArr = shopTypeEnv ? shopTypeEnv.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const directEnv = (process.env.SHOPEE_DIRECT_URLS || "").trim();
    const directUrls = directEnv ? directEnv.split(",").map((u) => u.trim()).filter(Boolean) : [];

    const all = await fetchOffersAllPages({
      keywords,
      pagesToCheck: [1, 2, 3],
      categoryIds,
      shopTypeArr,
      directUrls,
    });

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

// load persisted file e inicia
await loadSentOffers();
sendOffersToTelegram().catch((e) => console.log("AutoPush init erro:", e?.message || e));

// start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Node HTTP Shopee rodando na porta ${PORT} (pid=${process.pid})`);
  console.log(`USE: GET /fetch, GET /push e GET / (health)`);
});