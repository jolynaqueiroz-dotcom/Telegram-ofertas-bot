// autoSendOffers.js
import axios from "axios";

const TELEGRAM_BOT_TOKEN = "8213634493:AAGEa31ayHP5rIQttfsvmW8LvJtdWvoVKi8";
const TELEGRAM_CHAT_ID = "-1002400084420";
const FETCH_URL = "http://localhost:3000/fetch"; // ou a URL pública
const INTERVAL_MINUTES = 30; // intervalo em minutos (30 minutos)
const offers_per_batch = 10; // número de ofertas por rodada
async function sendOfferToTelegram(offer) {
  try {
    const text = `🔥 *${offer.productName}*\n💰 Por: ${offer.priceMin} Até: ${offer.priceMax}\n🛒 [Link da oferta](${offer.offerLink})`;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: false
    });

    console.log(`Mensagem enviada: ${offer.productName}`);
  } catch (err) {
    console.log("Erro ao enviar para o Telegram:", err?.response?.data || err.message);
  }
}

async function fetchAndSendOffers() {
  try {
    const resp = await axios.get(FETCH_URL, { timeout: 20000 });
    const offers = resp.data?.offers || [];
    // limita a quantidade de ofertas por rodada
    const offers_per_batch = 10;
    offers = offers.slice(0, offers_per_batch);

    console.log(`Foram encontradas ${offers.length} ofertas.`);

    for (let offer of offers) {
      await sendOfferToTelegram(offer);
      // pausa de 3 segundo entre cada envio pra não sobrecarregar
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (err) {
    console.log("Erro ao buscar ofertas:", err?.message || err);
  }
}

// roda a primeira vez imediatamente
fetchAndSendOffers();

// agenda para rodar repetidamente no intervalo definido
setInterval(fetchAndSendOffers, INTERVAL_MINUTES * 60 * 1000);
