// BOT MULTI OFERTAS PRO

import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import TelegramBot from "node-telegram-bot-api";

const {
TELEGRAM_BOT_TOKEN,
TELEGRAM_CHAT_ID,
SHOPEE_APP_ID,
SHOPEE_APP_SECRET,
ML_ACCESS_TOKEN,
PORT=3000
}=process.env;

const bot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN) : null;

const app = express();
app.use(express.json());

// CONFIG
const PUSH_INTERVAL_MINUTES=30;
const OFFERS_PER_PUSH=10;
const DELAY_BETWEEN_OFFERS_MS=2500;
const MIN_DISCOUNT=20;

// STORAGE
const SENT_FILE=path.resolve("./sent_links.json");
let sentDB={};

async function loadSent(){
 try{
  const raw=await fs.readFile(SENT_FILE,"utf8");
  sentDB=JSON.parse(raw);
 }catch{
  sentDB={};
 }
}

async function saveSent(){
 await fs.writeFile(SENT_FILE,JSON.stringify(sentDB,null,2));
}

function sha256Hex(s){
 return crypto.createHash("sha256").update(s).digest("hex");
}

function delay(ms){
 return new Promise(r=>setTimeout(r,ms));
}

// LIMPA LINKS ANTIGOS (3 dias)
function cleanupDB(){
 const now=Date.now();
 for(const k in sentDB){
  if(now-sentDB[k] > 3*24*60*60*1000){
   delete sentDB[k];
  }
 }
}

// KEYWORDS
const KEYWORDS=[
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

const SHOPEE_URL="https://open-api.affiliate.shopee.com.br/graphql";

async function fetchShopee(keyword){

 let results=[];

 for(let page=1;page<=2;page++){

 const payload={
 query:"query productOfferV2($keyword:String,$limit:Int,$page:Int){productOfferV2(keyword:$keyword,limit:$limit,page:$page){nodes{productName imageUrl offerLink priceMin priceMax}}}",
 variables:{keyword,limit:20,page}
 };

 const payloadStr=JSON.stringify(payload);
 const timestamp=Math.floor(Date.now()/1000);

 const sign=sha256Hex(`${SHOPEE_APP_ID}${timestamp}${payloadStr}${SHOPEE_APP_SECRET}`);

 const headers={
 "Content-Type":"application/json",
 Authorization:`SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${timestamp}, Signature=${sign}`
 };

 const resp=await axios.post(SHOPEE_URL,payload,{headers});

 const nodes=resp?.data?.data?.productOfferV2?.nodes || [];

 results.push(...nodes);

 }

 return results;
}

// ================= MERCADO LIVRE =================

async function fetchMercadoLivre(keyword){

 const url=`https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(keyword)}&limit=20`;

 const resp=await axios.get(url,{
 headers:{Authorization:`Bearer ${ML_ACCESS_TOKEN}`}
 });

 return resp.data.results.map(p=>{

 const price=p.price;
 const original=p.original_price||price;

 const discount=Math.round((1-price/original)*100);

 return{
 productName:p.title,
 imageUrl:p.thumbnail,
 offerLink:p.permalink,
 priceMin:price,
 priceMax:original,
 discount,
 source:"mercadolivre"
 };

 });

}

// ================= SHEIN =================

async function fetchShein(keyword){

 const url=`https://www.shein.com/pdsearch/${encodeURIComponent(keyword)}/`;

 const html=(await axios.get(url)).data;

 const matches=[...html.matchAll(/"goods_name":"(.*?)".*?"goods_img":"(.*?)".*?"salePrice":"(.*?)"/g)];

 return matches.slice(0,10).map(m=>({

 productName:m[1],
 imageUrl:`https:${m[2]}`,
 offerLink:`SEU_LINK_AFILIADO_SHEIN`,
 priceMin:m[3],
 priceMax:m[3],
 source:"shein"

 }));

}

// ================= MAGALU =================

async function fetchMagalu(keyword){

 const url=`https://www.magazineluiza.com.br/busca/${encodeURIComponent(keyword)}/`;

 const html=(await axios.get(url)).data;

 const matches=[...html.matchAll(/data-title="(.*?)".*?data-image="(.*?)"/g)];

 return matches.slice(0,10).map(m=>({

 productName:m[1],
 imageUrl:m[2],
 offerLink:`SEU_LINK_AFILIADO_MAGALU`,
 priceMin:"--",
 priceMax:"--",
 source:"magalu"

 }));

}

// ================= C&A =================

async function fetchCEA(keyword){

 const url=`https://www.cea.com.br/busca?q=${encodeURIComponent(keyword)}`;

 const html=(await axios.get(url)).data;

 const matches=[...html.matchAll(/"name":"(.*?)".*?"image":"(.*?)"/g)];

 return matches.slice(0,10).map(m=>({

 productName:m[1],
 imageUrl:m[2],
 offerLink:`SEU_LINK_AFILIADO_CEA`,
 priceMin:"--",
 priceMax:"--",
 source:"cea"

 }));

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

 const key=sha256Hex(o.offerLink);

 if(sentDB[key]) return;

 sentDB[key]=Date.now();
 await saveSent();

 const msg=formatMsg(o);

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

let platformIndex=0;

const platforms=[
"shopee",
"mercadolivre",
"shopee",
"magalu",
"shopee",
"shein",
"cea"
];

async function cycle(){

 cleanupDB();

 const keyword=KEYWORDS[Math.floor(Math.random()*KEYWORDS.length)];

 const platform=platforms[platformIndex];

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
 console.log("erro",platform);
 }

 offers.sort((a,b)=>(b.discount||0)-(a.discount||0));

 for(const o of offers.slice(0,OFFERS_PER_PUSH)){

 try{
 await sendOffer(o);
 await delay(DELAY_BETWEEN_OFFERS_MS);
 }catch{}

 }

}

// SERVER

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