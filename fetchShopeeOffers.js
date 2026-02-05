import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ===== resolve __dirname no ES Module =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== arquivos =====
const SENT_FILE = path.join(__dirname, "sent_offers.json");
const NEW_FILE = path.join(__dirname, "new_offers.json");
const OFFERS_SOURCE = path.join(__dirname, "offers_store.json");

// ================= KEYWORDS OBRIGATÓRIAS =================
const REQUIRED_KEYWORDS = [
  // móveis
  "sofa","sofá","cama","guarda roupa","guarda-roupa","armario","armário",
  "mesa","cadeira","estante","rack","painel","cristaleira",

  // eletro / eletrônicos
  "televisao","tv","ventilador","geladeira","fogao","fogão","microondas",
  "micro-ondas","lavadora","maquina de lavar","air fryer","liquidificador",

  // cozinha / mesa posta
  "panela","jogo de panela","talher","jogo de talheres","prato","louça",
  "mesa posta","organizadores","pote hermetico","pote hermético",

  // cama mesa banho
  "lençol","edredom","cobertor","toalha","jogo de cama","travesseiro",

  // moda
  "vestido","blusa","camisa","calça","short","bermuda",
  "roupa feminina","roupa masculina","roupa infantil",

  // calçados
  "tenis","tênis","sapato","sandalia","sandália","chinelo",

  // beleza
  "perfume","perfumaria","maquiagem","batom","base","corretivo",

  // bebê
  "bebê","bebe","mala maternidade","enxoval","kit bebe","kit bebê",

  // brinquedos / escolar
  "brinquedo","material escolar","mochila","estojo","caderno",

  // supermercado
  "alimento","limpeza","higiene","supermercado"
];

// =========================================================

// garante sent_offers.json
function ensureSentFile() {
  if (!fs.existsSync(SENT_FILE)) {
    fs.writeFileSync(SENT_FILE, JSON.stringify({ sent: [] }, null, 2));
  }
}

function loadSentOffers() {
  ensureSentFile();
  return JSON.parse(fs.readFileSync(SENT_FILE)).sent;
}

function saveSentOffers(sent) {
  fs.writeFileSync(SENT_FILE, JSON.stringify({ sent }, null, 2));
}

// normaliza texto
function normalize(text = "") {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// verifica keyword obrigatória
function hasRequiredKeyword(name) {
  const n = normalize(name);
  return REQUIRED_KEYWORDS.some(k => n.includes(normalize(k)));
}

// fingerprint real do produto
function productFingerprint(offer) {
  const name = normalize(offer.productName || offer.name || "");
  const image = offer.imageUrl || "";
  const shop = offer.shopId || "";
  return `${name}|${image}|${shop}`;
}

function run() {
  ensureSentFile();

  if (!fs.existsSync(OFFERS_SOURCE)) {
    console.log("❌ offers_store.json não encontrado");
    return;
  }

  const allOffers = JSON.parse(fs.readFileSync(OFFERS_SOURCE));
  const sentOffers = loadSentOffers();
  const sentSet = new Set(sentOffers);

  const newOffers = [];

  for (const offer of allOffers) {
    const name = offer.productName || offer.name || "";

    // 🔒 força keywords
    if (!hasRequiredKeyword(name)) continue;

    const fingerprint = productFingerprint(offer);

    if (sentSet.has(fingerprint)) continue;

    newOffers.push(offer);
    sentSet.add(fingerprint);
  }

  fs.writeFileSync(NEW_FILE, JSON.stringify(newOffers, null, 2));
  saveSentOffers([...sentSet]);

  console.log(`✅ ${newOffers.length} ofertas válidas salvas`);
}

run();
