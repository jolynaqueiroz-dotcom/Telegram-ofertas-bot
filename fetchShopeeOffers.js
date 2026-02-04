const fs = require("fs");
const path = require("path");

const SENT_FILE = path.join(__dirname, "sent_offers.json");
const NEW_FILE = path.join(__dirname, "new_offers.json");
const OFFERS_SOURCE = path.join(__dirname, "offers_store.json");

// Garante que o sent_offers.json existe
function ensureSentFile() {
  if (!fs.existsSync(SENT_FILE)) {
    fs.writeFileSync(SENT_FILE, JSON.stringify({ sent: [] }, null, 2));
  }
}

// Carrega IDs já enviados
function loadSentOffers() {
  ensureSentFile();
  return JSON.parse(fs.readFileSync(SENT_FILE)).sent;
}

// Salva novos IDs enviados
function saveSentOffers(sent) {
  fs.writeFileSync(SENT_FILE, JSON.stringify({ sent }, null, 2));
}

function run() {
  ensureSentFile();

  if (!fs.existsSync(OFFERS_SOURCE)) {
    console.log("❌ offers_store.json não encontrado");
    return;
  }

  const allOffers = JSON.parse(fs.readFileSync(OFFERS_SOURCE));
  const sentOffers = loadSentOffers();

  const newOffers = [];
  const updatedSent = new Set(sentOffers);

  for (const offer of allOffers) {
    const offerId =
      offer.itemid ||
      offer.product_id ||
      offer.id ||
      offer.name;

    if (!offerId) continue;

    if (!updatedSent.has(offerId)) {
      newOffers.push(offer);
      updatedSent.add(offerId);
    }
  }

  fs.writeFileSync(NEW_FILE, JSON.stringify(newOffers, null, 2));
  saveSentOffers([...updatedSent]);

  console.log(`✅ ${newOffers.length} ofertas novas salvas`);
}

run();
