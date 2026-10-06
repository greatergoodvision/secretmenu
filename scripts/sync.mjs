import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
const MARKUP = 50;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');

const outDir = path.resolve('public');
const imageDir = path.join(outDir, 'images');
await fs.mkdir(outDir, { recursive: true });
await fs.rm(imageDir, { recursive: true, force: true });
await fs.mkdir(imageDir, { recursive: true });

const SKU_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{2,4}\b/g;
const networkMediaBySku = new Map();

function addNetworkMedia(sku, item) {
  if (!sku || !item?.url || !/^https?:\/\//i.test(item.url)) return;
  const arr = networkMediaBySku.get(sku) || [];
  const key = `${item.type}:${item.url}`;
  if (!arr.some(x => `${x.type}:${x.url}` === key)) arr.push(item);
  networkMediaBySku.set(sku, arr);
}

function classifyAttachmentObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const type = String(obj.type || obj.mimeType || obj.contentType || '').toLowerCase();
  const name = String(obj.filename || obj.name || '').toLowerCase();
  const urls = [];
  for (const key of ['url','downloadUrl','download_url','signedUrl','signed_url']) {
    if (typeof obj[key] === 'string' && /^https?:\/\//i.test(obj[key])) urls.push(obj[key]);
  }
  let kind = null;
  if (type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(name)) kind = 'video';
  else if (type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(name)) kind = 'image';
  if (!kind) return [];
  return urls.map(url => ({ type: kind, url, poster: null }));
}

function analyzeNode(node, depth = 0) {
  const skus = new Set();
  const media = [];
  if (depth > 24 || node == null) return { skus, media };

  if (typeof node === 'string') {
    for (const m of node.matchAll(SKU_RE)) skus.add(m[0]);
    if (/^https?:\/\//i.test(node)) {
      if (/\.(mp4|mov|webm|m4v)(?:$|\?)/i.test(node)) media.push({ type:'video', url:node, poster:null });
      else if (/\.(jpe?g|png|webp|gif|heic)(?:$|\?)/i.test(node) && !/attachment_thumbnails\/video_dark/i.test(node)) media.push({ type:'image', url:node, poster:null });
    }
    return { skus, media };
  }
  if (typeof node !== 'object') return { skus, media };

  media.push(...classifyAttachmentObject(node));
  const values = Array.isArray(node) ? node : Object.values(node);
  for (const value of values) {
    const child = analyzeNode(value, depth + 1);
    for (const sku of child.skus) skus.add(sku);
    media.push(...child.media);
  }

  if (skus.size === 1 && media.length) {
    const sku = [...skus][0];
    for (const item of media) addNetworkMedia(sku, item);
  }
  return { skus, media };
}

async function inspectPublicDataResponse(response) {
  try {
    const headers = response.headers();
    const ct = String(headers['content-type'] || '').toLowerCase();
    const url = response.url();
    if (!/airtable\.com/i.test(url)) return;
    if (!(ct.includes('json') || ct.includes('text') || /readshared|sharedview|rows|records|data/i.test(url))) return;
    const len = Number(headers['content-length'] || 0);
    if (len && len > 25_000_000) return;
    const text = await response.text();
    if (!text || text.length > 25_000_000 || !/[A-Z0-9]{4}-[A-Z0-9]{2,4}/.test(text)) return;
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const firstBrace = Math.min(...['{','['].map(c => { const i=text.indexOf(c); return i<0?Infinity:i; }));
      if (!Number.isFinite(firstBrace)) return;
      try { parsed = JSON.parse(text.slice(firstBrace)); } catch { return; }
    }
    analyzeNode(parsed);
  } catch {}
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'en-US'
});

page.on('response', response => { void inspectPublicDataResponse(response); });

await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(
  () => /Quantity\s*Available/i.test(document.body?.innerText || '') || /Tier\s*A1\s*Price/i.test(document.body?.innerText || ''),
  { timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(4000);

const seen = new Map();

async function collectVisible() {
  const cards = await page.evaluate(() => {
    const marker = /Quantity\s*Available/i;
    const hasAll = t => marker.test(t) && /Tier\s*A1\s*Price/i.test(t) && /Tier\s*B1\s*Price/i.test(t) && /Tier\s*C1\s*Price/i.test(t);
    const out = [];

    function imageFrom(root) {
      for (const img of root.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        const r = img.getBoundingClientRect();
        if (/^https?:\/\//i.test(src) && !/attachment_thumbnails\/video_dark/i.test(src) && (img.naturalWidth >= 120 || img.naturalHeight >= 80 || r.width >= 100 || r.height >= 70)) return src;
      }
      for (const n of [root, ...root.querySelectorAll('*')]) {
        const bg = getComputedStyle(n).backgroundImage || '';
        const m = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (m && !/attachment_thumbnails\/video_dark/i.test(m[1])) return m[1];
      }
      return null;
    }

    for (const el of [...document.querySelectorAll('body *')]) {
      const base = (el.innerText || '').trim();
      if (!base || !hasAll(base) || base.length > 1800) continue;
      let node = el, chosen = null;
      for (let depth = 0; depth < 9 && node; depth++, node = node.parentElement) {
        const txt = (node.innerText || '').trim();
        if (!hasAll(txt) || txt.length > 3000) continue;
        const q = txt.search(marker);
        const prefix = q >= 0 ? txt.slice(0, q).trim() : '';
        if (prefix && prefix.length <= 500) {
          chosen = {
            text: txt,
            titleHint: prefix.split(/\n+/).map(x => x.trim()).filter(Boolean).join(' '),
            image: imageFrom(node)
          };
          break;
        }
      }
      if (!chosen || !chosen.titleHint || /^Quantity\s*Available$/i.test(chosen.titleHint)) continue;
      out.push(chosen);
    }
    return out;
  });

  for (const c of cards) {
    const key = `${c.titleHint}|${c.text}`;
    const prior = seen.get(key);
    if (!prior || (!prior.image && c.image)) seen.set(key, c);
  }
}

await collectVisible();
for (let i = 0; i < 95; i++) {
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')]
      .filter(el => { const s=getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100; })
      .sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,5);
    for (const el of els) el.scrollTop = Math.min(el.scrollTop + Math.max(500, el.clientHeight*.7), el.scrollHeight);
    window.scrollBy(0,800);
  });
  await page.waitForTimeout(190);
  await collectVisible();
}
await page.waitForTimeout(1800);
await collectVisible();

const moneyRe = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/;
function bumped(value) {
  const m=String(value).match(moneyRe); if(!m) return String(value).trim();
  const original=m[1], amount=Number(original.replace(/,/g,''))+MARKUP, decimals=original.includes('.')?2:0;
  return '$'+amount.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
}
function capture(text,re){const m=text.match(re);return m?m[1].trim():''}
function parseCard(card){
  const text=card.text.replace(/\r/g,''), title=card.titleHint.trim();
  const qty=capture(text,/Quantity\s*Available\s*\n?\s*([^\n]+)/i);
  const a=capture(text,/Tier\s*A1\s*Price\s*\(1-10\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const b=capture(text,/Tier\s*B1\s*Price\s*\(10-50\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const c=capture(text,/Tier\s*C1\s*Price\s*\(50\+\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const quality=capture(text,/Quality\s*\n?\s*([^\n]+)/i);
  const fields=[];
  if(qty) fields.push({label:'Quantity Available',value:qty,kind:'text'});
  if(a) fields.push({label:'Tier A1 Price (1-10 lbs)',value:bumped(a),kind:'price'});
  if(b) fields.push({label:'Tier B1 Price (10-50 lbs)',value:bumped(b),kind:'price'});
  if(c) fields.push({label:'Tier C1 Price (50+ lbs)',value:bumped(c),kind:'price'});
  if(quality) fields.push({label:'Quality',value:quality,kind:'text'});
  return {title,fields,imageUrl:card.image};
}

const byTitle=new Map();
for(const card of seen.values()){
  const parsed=parseCard(card);
  if(!parsed.title||parsed.fields.filter(f=>f.kind==='price').length<3) continue;
  const prior=byTitle.get(parsed.title);
  if(!prior||(!prior.imageUrl&&parsed.imageUrl)) byTitle.set(parsed.title,parsed);
}

function dedupeMedia(items) {
  const out=[]; const keys=new Set();
  for(const m of items){
    if(!m?.url||!/^https?:\/\//i.test(m.url)) continue;
    if(m.type==='video'&&/attachment_thumbnails\/video_dark/i.test(m.url)) continue;
    let key=m.url;
    try{const u=new URL(m.url);u.search='';u.hash='';key=`${m.type}:${u}`;}catch{key=`${m.type}:${m.url}`}
    if(keys.has(key)) continue; keys.add(key); out.push(m);
  }
  return [...out.filter(x=>x.type==='image').slice(0,2),...out.filter(x=>x.type==='video').slice(0,1)];
}

async function cacheImage(url,title,index){
  if(!/^https?:\/\//i.test(url||'')) return null;
  try{
    const res=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}}); if(!res.ok) return null;
    const type=(res.headers.get('content-type')||'').toLowerCase(); if(!type.startsWith('image/')) return null;
    const buf=Buffer.from(await res.arrayBuffer());
    const ext=type.includes('png')?'.png':type.includes('webp')?'.webp':type.includes('gif')?'.gif':'.jpg';
    const file=crypto.createHash('sha1').update(`${title}|${index}|${url}`).digest('hex').slice(0,18)+ext;
    await fs.writeFile(path.join(imageDir,file),buf); return `images/${file}`;
  }catch{return null}
}

const products=[]; let imageCount=0,videoCount=0,mediaCount=0,fullMediaProducts=0;
let productsWithNetworkMedia=0;
for(const item of byTitle.values()){
  const sku=(item.title.match(SKU_RE)||[])[0]||'';
  const network=dedupeMedia(networkMediaBySku.get(sku)||[]);
  if(network.length) productsWithNetworkMedia++;
  const combined=dedupeMedia([...(network||[]),...(item.imageUrl?[{type:'image',url:item.imageUrl,poster:null}]:[])]);
  const media=[]; let imageIndex=0;
  for(const m of combined){
    if(m.type==='image'&&imageIndex<2){
      const cached=await cacheImage(m.url,item.title,imageIndex);
      if(cached){media.push({type:'image',src:cached});imageCount++;mediaCount++;imageIndex++}
    }else if(m.type==='video'&&!media.some(x=>x.type==='video')){
      media.push({type:'video',src:m.url,poster:m.poster||null});videoCount++;mediaCount++;
    }
  }
  if(media.filter(x=>x.type==='image').length>=2&&media.some(x=>x.type==='video')) fullMediaProducts++;
  products.push({title:item.title,fields:item.fields,image:media.find(x=>x.type==='image')?.src||null,media});
}
if(!products.length) throw new Error('No catalog product cards detected');
products.sort((x,y)=>x.title.localeCompare(y.title));
await fs.writeFile(path.join(outDir,'catalog.json'),JSON.stringify({updatedAt:new Date().toISOString(),count:products.length,imageCount,videoCount,mediaCount,fullMediaProducts,productsWithNetworkMedia,products},null,2));
console.log(`Public record data matched ${networkMediaBySku.size} SKUs; ${productsWithNetworkMedia} catalog products received attachment media.`);
console.log(`Synced ${products.length} products, ${imageCount} images, ${videoCount} real videos, ${mediaCount} media items, ${fullMediaProducts} products with 2 photos + video, with +$${MARKUP} pricing.`);
await browser.close();