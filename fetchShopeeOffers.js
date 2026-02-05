// server.js (ESM) — Shopee + Telegram
import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import TelegramBot from "node-telegram-bot-api";

// ================== ENV ==================
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SHOPEE_APP_ID,
  SHOPEE_APP_SECRET,
  PORT = 3000,
} = process.env;

// ================== TELEGRAM ==================
const bot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN) : null;

// ================== APP ==================
const app = express();
app.use(express.json());

// ================== SHOPEE ==================
const SHOPEE_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const HTTP_TIMEOUT_MS = 30000;

// ================== ENVIO ==================
const OFFERS_PER_PUSH = 10;
const PUSH_INTERVAL_MINUTES = 30;
const DELAY_BETWEEN_OFFERS_MS = 3000;

// ================== DEDUPE ==================
const SENT_FILE = path.resolve("./sent_offers.json");
let sentSet = new Set();

async function loadSent() {
  try {
    const raw = await fs.readFile(SENT_FILE, "utf8");
    const json = JSON.parse(raw || '{"sent": []}');
    sentSet = new Set(json.sent || []);
  } catch {
    await fs.writeFile(SENT_FILE, JSON.stringify({ sent: [] }, null, 2));
    sentSet = new Set();
  }
}
async function saveSent() {
  await fs.writeFile(SENT_FILE, JSON.stringify({ sent: [...sentSet] }, null, 2));
}

// ================== KEYWORDS (FORÇADAS NO CÓDIGO) ==================
// >>> SOMENTE o que você quer vender
const REQUIRED_KEYWORDS = [
  // Eletro / Eletrônicos
  "televisão","tv","smart tv","geladeira","freezer","fogão","cooktop","forno","micro-ondas",
  "ar condicionado","ventilador","climatizador","lavadora","máquina de lavar","secadora",
  "notebook","computador","monitor","impressora","roteador","caixa de som","soundbar",

  // Casa / Móveis
  "sofá","cama","colchão","guarda-roupa","armário","rack","painel","mesa","cadeira","estante",
  "criado-mudo","cômoda","poltrona","mesa de jantar","bancada",

  // Cozinha / Mesa posta
  "panelas","jogo de panelas","talheres","faqueiro","louças","pratos","xícaras","canecas",
  "potes herméticos","organizador de cozinha","escorredor","mesa posta","cristaleira",

  // Cama, Mesa e Banho
  "jogo de cama","lençol","toalha","toalhas","edredom","cobertor","colcha","travesseiro",

  // Supermercado
  "alimentos","bebidas","limpeza","higiene","mercado",

  // Moda
  "roupa feminina","roupa masculina","roupa infantil","vestido","calça","camisa","blusa",
  "shorts","jaqueta","casaco","lingerie","cueca","sutiã","pijama","calçado","tênis","sapato",

  // Beleza / Perfumaria
  "perfume","perfumaria","maquiagem","skincare","cosméticos",

  // Mamãe e Bebê / Infantil
  "mamãe e bebê","enxoval","mala maternidade","fralda","carrinho","cadeira de alimentação",
  "brinquedo","material escolar",

  // Ferramentas
  "ferramentas","furadeira","parafusadeira","serra","kit ferramentas"
];

// >>> BLOQUEIOS (lixo que você NÃO quer)
const BLOCKED_KEYWORDS = [
  "almofada","capinha","película","adesivo","chaveiro","enfeite","decorativo",
  "black friday","black","case","capa","pelicula"
];

// ================== UTIL ==================
const normalize = (s="") =>
  s.toLowerCase()
   .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
   .replace(/[^a-z0-9\s]/g," ")
   .replace(/\s+/g," ")
   .trim();

const sha256Hex = (s) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex");

function matchesRequired(name) {
  const n = normalize(name);
  return REQUIRED_KEYWORDS.some(k => n.includes(normalize(k)));
}
function matchesBlocked(name) {
  const n = normalize(name);
  return BLOCKED_KEYWORDS.some(k => n.includes(normalize(k)));
}

// ================== SHOPEE FETCH ==================
function makePayload(keyword, page) {
  return {
    query:
      "query productOfferV2($keyword:String,$limit:Int,$page:Int){productOfferV2(keyword:$keyword,limit:$limit,page:$page){nodes{productName imageUrl offerLink priceMin priceMax shopId videoUrl couponLink}}}",
    variables: { keyword, limit: 30, page }
  };
}

async function fetchPage(keyword, page) {
  const payload = makePayload(keyword, page);
  const payloadStr = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now()/1000);
  const sign = sha256Hex(`${SHOPEE_APP_ID}${timestamp}${payloadStr}${SHOPEE_APP_SECRET}`);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${sign}`,
  };
  const resp = await axios.post(SHOPEE_URL, payload, { headers, timeout: HTTP_TIMEOUT_MS });
  return resp?.data?.data?.productOfferV2?.nodes || [];
}

async function fetchOffers() {
  const collected = [];
  for (const kw of REQUIRED_KEYWORDS) {
    for (let p=1; p<=2; p++) {
      try {
        const nodes = await fetchPage(kw, p);
        collected.push(...nodes);
      } catch {}
    }
  }
  return collected;
}

// ================== FORMAT ==================
function formatMsg(o) {
  return `🔥 *OFERTA DO DIA!*\n🔥 *${o.productName}*\nDe: ${o.priceMax}\nPor: *${o.priceMin}*\n🛒 [Link da oferta](${o.offerLink})`;
}

// ================== PUSH ==================
async function pushTelegram(offers) {
  for (const o of offers) {
    const key = normalize(o.productName);
    if (sentSet.has(key)) continue;

    sentSet.add(key);
    await saveSent();

    const msg = formatMsg(o);
    try {
      if (bot) {
        if (o.videoUrl) {
          await bot.sendVideo(TELEGRAM_CHAT_ID, o.videoUrl, { caption: msg, parse_mode:"Markdown" });
        } else if (o.imageUrl) {
          await bot.sendPhoto(TELEGRAM_CHAT_ID, o.imageUrl, { caption: msg, parse_mode:"Markdown" });
        } else {
          await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode:"Markdown" });
        }
      }
      await new Promise(r=>setTimeout(r, DELAY_BETWEEN_OFFERS_MS));
    } catch {}
  }
}

// ================== CICLO ==================
async function cycle() {
  const raw = await fetchOffers();
  const filtered = raw.filter(o =>
    o?.productName &&
    matchesRequired(o.productName) &&
    !matchesBlocked(o.productName)
  );

  // dedupe local por nome
  const map = new Map();
  for (const o of filtered) {
    const k = normalize(o.productName);
    if (!map.has(k)) map.set(k, o);
  }

  const toSend = [...map.values()]
    .filter(o => !sentSet.has(normalize(o.productName)))
    .slice(0, OFFERS_PER_PUSH);

  await pushTelegram(toSend);
}

// ================== SERVER ==================
app.get("/", (_,res)=>res.send("ok"));
app.listen(PORT, "0.0.0.0", async ()=>{
  await loadSent();
  await cycle();
  setInterval(cycle, PUSH_INTERVAL_MINUTES*60*1000);
  console.log(`Rodando na porta ${PORT}`);
});
