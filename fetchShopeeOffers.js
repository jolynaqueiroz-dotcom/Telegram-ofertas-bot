// server.js — BOT MULTI OFERTAS

import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import TelegramBot from "node-telegram-bot-api";

// ================= ENV =================

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SHOPEE_APP_ID,
  SHOPEE_APP_SECRET,
  ML_ACCESS_TOKEN,
  PORT = 3000
} = process.env;

// ================= TELEGRAM =================

const bot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN) : null;

// ================= APP =================

const app = express();
app.use(express.json());

// ================= CONFIG =================

const PUSH_INTERVAL_MINUTES = 30;
const OFFERS_PER_PUSH = 10;
const DELAY_BETWEEN_OFFERS_MS = 3000;

// ================= STORAGE =================

const SENT_FILE = path.resolve("./sent_links.json");
let sentSet = new Set();

async function loadSent() {
  try {
    const raw = await fs.readFile(SENT_FILE,"utf8");
    sentSet = new Set(JSON.parse(raw));
  } catch {
    await fs.writeFile(SENT_FILE, JSON.stringify([]));
  }
}

async function saveSent(){
  await fs.writeFile(SENT_FILE, JSON.stringify([...sentSet]));
}

// ================= UTILS =================

function sha256Hex(s){
  return crypto.createHash("sha256").update(s).digest("hex");
}

function delay(ms){
  return new Promise(r=>setTimeout(r,ms));
}

// ================= KEYWORDS =================

const KEYWORDS = [
"smart tv",
"notebook",
"geladeira",
"sofa",
"tenis",
"perfume",
"maquiagem",
"vestido",
"panela",
"ferramenta"
];

// ================= SHOPEE =================

const SHOPEE_URL = "https://open-api.affiliate.shopee.com.br/graphql";

async function fetchShopee(keyword){

  const payload = {
    query:"query productOfferV2($keyword:String,$limit:Int,$page:Int){productOfferV2(keyword:$keyword,limit:$limit,page:$page){nodes{productName imageUrl offerLink priceMin priceMax}}}",
    variables:{keyword,limit:20,page:1}
  };

  const payloadStr = JSON.stringify(payload);

  const timestamp = Math.floor(Date.now()/1000);

  const sign = sha256Hex(
    `${SHOPEE_APP_ID}${timestamp}${payloadStr}${SHOPEE_APP_SECRET}`
  );

  const headers={
    "Content-Type":"application/json",
    Authorization:`SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${sign}`
  };

  const resp = await axios.post(SHOPEE_URL,payload,{headers});

  return resp?.data?.data?.productOfferV2?.nodes || [];
}

// ================= MERCADO LIVRE =================

async function fetchMercadoLivre(keyword){

  const url=`https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(keyword)}&limit=20`;

  const resp=await axios.get(url,{
    headers:{
      Authorization:`Bearer ${ML_ACCESS_TOKEN}`
    }
  });

  return resp.data.results.map(p=>({

    productName:p.title,
    imageUrl:p.thumbnail,
    offerLink:p.permalink,
    priceMin:p.price,
    priceMax:p.original_price || p.price,
    source:"mercadolivre"

  }));
}

// ================= SHEIN (placeholder) =================

async function fetchShein(keyword){

  return [
    {
      productName:`Produto Shein ${keyword}`,
      imageUrl:null,
      offerLink:`SEU_LINK_AFILIADO_SHEIN`,
      priceMin:"--",
      priceMax:"--",
      source:"shein"
    }
  ];

}

// ================= MAGALU =================

async function fetchMagalu(keyword){

  return [
    {
      productName:`Produto Magalu ${keyword}`,
      imageUrl:null,
      offerLink:`SEU_LINK_AFILIADO_MAGALU`,
      priceMin:"--",
      priceMax:"--",
      source:"magalu"
    }
  ];

}

// ================= C&A =================

async function fetchCEA(keyword){

  return [
    {
      productName:`Produto C&A ${keyword}`,
      imageUrl:null,
      offerLink:`SEU_LINK_AFILIADO_CEA`,
      priceMin:"--",
      priceMax:"--",
      source:"cea"
    }
  ];

}

// ================= TELEGRAM =================

function formatMsg(o){

return `🔥 *OFERTA*

*${o.productName}*

💰 De: ${o.priceMax}
🔥 Por: *${o.priceMin}*

🛒 [Comprar aqui](${o.offerLink})
`;

}

async function sendOffer(o){

  const key = sha256Hex(o.offerLink);

  if(sentSet.has(key)) return;

  sentSet.add(key);
  await saveSent();

  const msg = formatMsg(o);

  if(o.imageUrl){
    await bot.sendPhoto(
      TELEGRAM_CHAT_ID,
      o.imageUrl,
      {caption:msg,parse_mode:"Markdown"}
    );
  }else{
    await bot.sendMessage(
      TELEGRAM_CHAT_ID,
      msg,
      {parse_mode:"Markdown"}
    );
  }

}

// ================= CICLO =================

let platformIndex = 0;

const platforms = [
"shopee",
"mercadolivre",
"shopee",
"magalu",
"shopee",
"shein",
"cea"
];

async function cycle(){

  const keyword = KEYWORDS[Math.floor(Math.random()*KEYWORDS.length)];

  const platform = platforms[platformIndex];

  platformIndex++;
  if(platformIndex>=platforms.length) platformIndex=0;

  let offers=[];

  try{

    if(platform==="shopee")
      offers=await fetchShopee(keyword);

    if(platform==="mercadolivre")
      offers=await fetchMercadoLivre(keyword);

    if(platform==="shein")
      offers=await fetchShein(keyword);

    if(platform==="magalu")
      offers=await fetchMagalu(keyword);

    if(platform==="cea")
      offers=await fetchCEA(keyword);

  }catch(e){
    console.log("erro plataforma",platform);
  }

  for(const o of offers.slice(0,OFFERS_PER_PUSH)){

    try{
      await sendOffer(o);
      await delay(DELAY_BETWEEN_OFFERS_MS);
    }catch{}

  }

}

// ================= SERVER =================

app.get("/",(_,res)=>res.send("bot rodando"));

app.listen(PORT,"0.0.0.0",async()=>{

  await loadSent();

  await cycle();

  setInterval(
    cycle,
    PUSH_INTERVAL_MINUTES*60*1000
  );

  console.log("BOT ONLINE");

});