import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
const MARKUP = 50;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');

await fs.mkdir('public', { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153 Safari/537.36',
  locale: 'en-US'
});

await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(() => /Tier\s*A1\s*Price/i.test(document.body?.innerText || ''), { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);

const records = new Map();
const opened = new Set();

function canonical(url) {
  try { const u = new URL(url); u.hash=''; return u.toString(); } catch { return url || ''; }
}

function mergeMedia(...groups) {
  const seen = new Set();
  const images = [];
  const videos = [];
  for (const m of groups.flat()) {
    if (!m?.url || !/^https?:\/\//i.test(m.url)) continue;
    if (/attachment_thumbnails\/video_dark\.png/i.test(m.url)) continue;
    const type = m.type === 'video' ? 'video' : 'image';
    const key = `${type}:${canonical(m.url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (type === 'video' ? videos : images).push({ type, url: m.url, poster: m.poster || null });
  }
  return [...images.slice(0,2), ...videos.slice(0,1)];
}

async function readExpanded(openKey, title, fallback=[]) {
  if (!openKey || opened.has(title)) return fallback;
  opened.add(title);
  const card = page.locator(`[data-pp-open-key="${openKey}"]`).first();
  if (!(await card.count())) return fallback;

  try {
    await card.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => {});
    await card.click({ timeout: 1600 });
  } catch { return fallback; }

  await page.waitForTimeout(220);

  let images = await page.evaluate((wantedTitle) => {
    const visible = el => {
      const r=el.getBoundingClientRect(), s=getComputedStyle(el);
      return r.width>20 && r.height>20 && s.display!=='none' && s.visibility!=='hidden';
    };
    const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const fixed=[...document.querySelectorAll('body *')].filter(el=>{
      if(!visible(el)) return false;
      const s=getComputedStyle(el), r=el.getBoundingClientRect();
      return ['fixed','absolute'].includes(s.position) && r.width>innerWidth*.4 && r.height>innerHeight*.4 && (el.innerText||'').includes(wantedTitle.slice(0,20));
    });
    const root=dialogs.at(-1)||fixed.at(-1);
    if(!root) return [];
    const out=[], seen=new Set();
    const add=url=>{
      if(!url||!/^https?:\/\//i.test(url)||/video_dark\.png/i.test(url)) return;
      let k=url; try{const u=new URL(url);u.hash='';k=u.toString()}catch{}
      if(seen.has(k)) return; seen.add(k); out.push(url);
    };
    for(const img of root.querySelectorAll('img')){
      const src=img.currentSrc||img.src||'', r=img.getBoundingClientRect();
      if((img.naturalWidth>=180||img.naturalHeight>=120||r.width>=130||r.height>=90)&&/airtable|usercontent|attachment|cdn/i.test(src)) add(src);
      const srcset=img.getAttribute('srcset')||'';
      for(const part of srcset.split(',')) add(part.trim().split(/\s+/)[0]||'');
    }
    for(const el of [root,...root.querySelectorAll('*')]){
      const bg=getComputedStyle(el).backgroundImage||'';
      for(const m of bg.matchAll(/url\(["']?(https?:\/\/[^"')]+)["']?\)/ig)){
        const r=el.getBoundingClientRect(); if(r.width>=120&&r.height>=80) add(m[1]);
      }
    }
    return out.slice(0,2);
  }, title).catch(()=>[]);

  let videoUrl = null;
  const thumb = page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').first();
  if (await thumb.count()) {
    const captured=[];
    const onResponse = response => {
      try {
        const u=response.url(), ct=String(response.headers()['content-type']||'').toLowerCase();
        if((ct.startsWith('video/')||/\.(mp4|mov|webm)(?:$|\?)/i.test(u)) && /^https?:\/\//i.test(u)) captured.push(u);
      } catch {}
    };
    page.on('response', onResponse);
    try {
      await thumb.click({ timeout: 1200 }).catch(async()=>{ await thumb.locator('xpath=..').click({ timeout: 800 }).catch(()=>{}); });
      for(let i=0;i<10&&!videoUrl;i++){
        await page.waitForTimeout(180);
        videoUrl = await page.evaluate(() => {
          const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden'};
          for(const v of [...document.querySelectorAll('video')].filter(visible).reverse()){
            try{v.muted=true;v.play().catch(()=>{})}catch{}
            const src=v.currentSrc||v.src||v.querySelector('source')?.src||'';
            if(/^https?:\/\//i.test(src)) return src;
          }
          for(const a of [...document.querySelectorAll('a[href]')].filter(visible).reverse()){
            const href=a.href||''; if(/\.(mp4|mov|webm)(?:$|\?)/i.test(href)) return href;
          }
          return null;
        }).catch(()=>null);
        if(!videoUrl) videoUrl=captured.at(-1)||null;
      }
    } finally {
      page.off('response', onResponse);
      await page.keyboard.press('Escape').catch(()=>{});
      await page.waitForTimeout(70);
    }
  }

  await page.keyboard.press('Escape').catch(()=>{});
  await page.waitForTimeout(70);

  const expanded=[...images.map(url=>({type:'image',url})), ...(videoUrl?[{type:'video',url:videoUrl,poster:images[0]||null}]:[])];
  return mergeMedia(fallback, expanded);
}

async function collectVisible() {
  const cards = await page.evaluate(() => {
    const marker=/Quantity\s*Available/i;
    const good=t=>marker.test(t)&&/Tier\s*A1\s*Price/i.test(t)&&/Tier\s*B1\s*Price/i.test(t)&&/Tier\s*C1\s*Price/i.test(t);
    const out=[], local=new Set(); let n=0;
    for(const el of [...document.querySelectorAll('body *')]){
      const base=(el.innerText||'').trim();
      if(!base||!good(base)||base.length>1800) continue;
      let node=el, chosen=null;
      for(let d=0;d<9&&node;d++,node=node.parentElement){
        const txt=(node.innerText||'').trim(); if(!good(txt)||txt.length>3000) continue;
        const q=txt.search(marker), prefix=q>=0?txt.slice(0,q).trim():'';
        const lines=prefix.split(/\n+/).map(x=>x.trim()).filter(Boolean);
        if(!lines.length||prefix.length>500) continue;
        const title=lines[0]; if(local.has(title)) break; local.add(title);
        const openKey=`pp-${Date.now()}-${n++}-${Math.random().toString(36).slice(2,8)}`;
        node.setAttribute('data-pp-open-key',openKey);
        const media=[];
        for(const img of node.querySelectorAll('img')){
          const src=img.currentSrc||img.src||'', r=img.getBoundingClientRect();
          if(/^https?:\/\//i.test(src)&&!/video_dark\.png/i.test(src)&&(img.naturalWidth>=120||img.naturalHeight>=80||r.width>=100||r.height>=70)) media.push({type:'image',url:src});
        }
        chosen={title,text:txt,openKey,media}; break;
      }
      if(chosen) out.push(chosen);
    }
    return out;
  });

  for(const c of cards){
    const prior=records.get(c.title);
    let media=mergeMedia(prior?.media||[],c.media||[]);
    if(!opened.has(c.title)) media=await readExpanded(c.openKey,c.title,media);
    const candidate={title:c.title,text:c.text,media};
    if(!prior||candidate.media.length>prior.media.length) records.set(c.title,candidate);
  }
}

await collectVisible();
for(let i=0;i<90;i++){
  await page.evaluate(()=>{
    const els=[...document.querySelectorAll('*')].filter(el=>{const s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+100}).sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,5);
    for(const el of els) el.scrollTop=Math.min(el.scrollTop+Math.max(500,el.clientHeight*.7),el.scrollHeight);
    window.scrollBy(0,800);
  });
  await page.waitForTimeout(150);
  await collectVisible();
}
await page.waitForTimeout(500);
await collectVisible();

const moneyRe=/\$\s*(\d[\d,]*(?:\.\d{1,2})?)/;
const capture=(text,re)=>text.match(re)?.[1]?.trim()||'';
function bumped(v){const m=String(v).match(moneyRe);if(!m)return String(v).trim();const raw=m[1],amount=Number(raw.replace(/,/g,''))+MARKUP,dec=raw.includes('.')?2:0;return '$'+amount.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec})}
function fields(text){
  text=text.replace(/\r/g,''); const f=[];
  const qty=capture(text,/Quantity\s*Available\s*\n?\s*([^\n]+)/i),a=capture(text,/Tier\s*A1\s*Price\s*\(1-10\s*lbs\)\s*\n?\s*([^\n]+)/i),b=capture(text,/Tier\s*B1\s*Price\s*\(10-50\s*lbs\)\s*\n?\s*([^\n]+)/i),c=capture(text,/Tier\s*C1\s*Price\s*\(50\+\s*lbs\)\s*\n?\s*([^\n]+)/i),q=capture(text,/Quality\s*\n?\s*([^\n]+)/i);
  if(qty)f.push({label:'Quantity Available',value:qty,kind:'text'}); if(a)f.push({label:'Tier A1 Price (1-10 lbs)',value:bumped(a),kind:'price'}); if(b)f.push({label:'Tier B1 Price (10-50 lbs)',value:bumped(b),kind:'price'}); if(c)f.push({label:'Tier C1 Price (50+ lbs)',value:bumped(c),kind:'price'}); if(q)f.push({label:'Quality',value:q,kind:'text'}); return f;
}

const products=[];
for(const r of records.values()){
  const imgs=r.media.filter(m=>m.type==='image').slice(0,2);
  const vid=r.media.find(m=>m.type==='video');
  const f=fields(r.text);
  if(imgs.length<2||!vid||f.filter(x=>x.kind==='price').length<3) continue;
  const media=[{type:'image',src:imgs[0].url},{type:'image',src:imgs[1].url},{type:'video',src:vid.url,poster:vid.poster||imgs[0].url}];
  products.push({title:r.title,fields:f,image:imgs[0].url,media});
}
products.sort((a,b)=>a.title.localeCompare(b.title));
if(!products.length) throw new Error('No complete 2-photo + video strains detected');

await fs.writeFile('public/catalog.json',JSON.stringify({updatedAt:new Date().toISOString(),count:products.length,imageCount:products.length*2,videoCount:products.length,mediaCount:products.length*3,completeMediaOnly:true,mediaHostedBy:'airtable',products},null,2));
console.log(`Published ${products.length} strains with exactly 2 Airtable-hosted photos + 1 Airtable-hosted video each. +$${MARKUP} pricing.`);
await browser.close();