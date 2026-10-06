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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'en-US'
});

await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(
  () => /Quantity\s*Available/i.test(document.body?.innerText || '') || /Tier\s*A1\s*Price/i.test(document.body?.innerText || ''),
  { timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(3500);

const seen = new Map();
const expandedTitles = new Set();

function mergeMedia(a = [], b = []) {
  const out = [];
  const keys = new Set();
  for (const m of [...a, ...b]) {
    if (!m?.url || !/^https?:\/\//i.test(m.url)) continue;
    if (m.type === 'video' && /attachment_thumbnails\/video_dark\.png/i.test(m.url)) continue;
    let key = m.url;
    try {
      const u = new URL(m.url);
      u.search = '';
      u.hash = '';
      key = `${m.type}:${u}`;
    } catch { key = `${m.type}:${m.url}`; }
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(m);
  }
  return [
    ...out.filter(x => x.type === 'image').slice(0, 2),
    ...out.filter(x => x.type === 'video').slice(0, 1)
  ];
}

async function extractExpandedMedia(openKey, title) {
  const loc = page.locator(`[data-pp-open-key="${openKey}"]`).first();
  if (!(await loc.count())) return [];

  const beforeUrl = page.url();
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => {});
    await loc.click({ timeout: 1800 });
  } catch {
    return [];
  }
  await page.waitForTimeout(240);

  const basic = await page.evaluate((wantedTitle) => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 20 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0;
    };
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const fixed = [...document.querySelectorAll('body *')].filter(el => {
      if (!visible(el)) return false;
      const s = getComputedStyle(el);
      if (!['fixed','absolute'].includes(s.position)) return false;
      const r = el.getBoundingClientRect();
      return r.width > innerWidth * .45 && r.height > innerHeight * .45 && (el.innerText || '').includes(wantedTitle.slice(0, 24));
    });
    const root = dialogs.at(-1) || fixed.sort((a,b) => (parseInt(getComputedStyle(a).zIndex)||0) - (parseInt(getComputedStyle(b).zIndex)||0)).at(-1);
    if (!root) return { images: [], hasVideo: false };

    const images = [];
    const keys = new Set();
    const addImage = url => {
      if (!url || !/^https?:\/\//i.test(url) || /attachment_thumbnails\/video_dark\.png/i.test(url)) return;
      let key = url;
      try { const u = new URL(url); u.search=''; u.hash=''; key=u.toString(); } catch {}
      if (keys.has(key)) return;
      keys.add(key);
      images.push(url);
    };

    for (const img of root.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      const r = img.getBoundingClientRect();
      const useful = img.naturalWidth >= 180 || img.naturalHeight >= 120 || (r.width >= 140 && r.height >= 90) || /airtableusercontent|attachment/i.test(src);
      if (useful) addImage(src);
      const srcset = img.getAttribute('srcset') || '';
      for (const bit of srcset.split(',')) addImage(bit.trim().split(/\s+/)[0] || '');
    }

    for (const el of [root, ...root.querySelectorAll('*')]) {
      const bg = getComputedStyle(el).backgroundImage || '';
      for (const m of bg.matchAll(/url\(["']?(https?:\/\/[^"')]+)["']?\)/ig)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 80) addImage(m[1]);
      }
    }

    const hasVideo = !!root.querySelector('img[src*="attachment_thumbnails/video_dark"]') ||
      [...root.querySelectorAll('*')].some(el => /\.(mp4|mov|webm)\b/i.test((el.textContent || '') + ' ' + (el.getAttribute?.('aria-label') || '') + ' ' + (el.getAttribute?.('title') || '')));

    return { images: images.slice(0, 2), hasVideo };
  }, title).catch(() => ({ images: [], hasVideo: false }));

  let videoUrl = null;
  if (basic.hasVideo) {
    const captured = [];
    const onResponse = response => {
      try {
        const h = response.headers();
        const ct = String(h['content-type'] || '').toLowerCase();
        const u = response.url();
        if (ct.startsWith('video/') || /\.(mp4|webm|mov)(?:$|\?)/i.test(u)) captured.push(u);
      } catch {}
    };
    page.on('response', onResponse);

    try {
      const thumb = page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').last();
      if (await thumb.count()) {
        await thumb.click({ timeout: 1200 }).catch(async () => {
          const parent = thumb.locator('xpath=..');
          await parent.click({ timeout: 800 }).catch(() => {});
        });
        await page.waitForTimeout(320);

        const vid = page.locator('video:visible').last();
        if (await vid.count()) {
          videoUrl = await vid.evaluate(v => {
            const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
            try { v.muted = true; v.play().catch(() => {}); } catch {}
            return /^https?:\/\//i.test(src) ? src : null;
          }).catch(() => null);
          await page.waitForTimeout(700);
        } else {
          await page.waitForTimeout(450);
        }

        if (!videoUrl) {
          videoUrl = await page.evaluate(() => {
            const visible = el => {
              const r=el.getBoundingClientRect(), s=getComputedStyle(el);
              return r.width>20&&r.height>20&&s.display!=='none'&&s.visibility!=='hidden';
            };
            for (const v of [...document.querySelectorAll('video')].filter(visible).reverse()) {
              const src=v.currentSrc||v.src||v.querySelector('source')?.src||'';
              if (/^https?:\/\//i.test(src)) return src;
            }
            for (const a of [...document.querySelectorAll('a[href]')].filter(visible).reverse()) {
              const href=a.href||'';
              if (/\.(mp4|webm|mov)(?:$|\?)/i.test(href)) return href;
            }
            return null;
          }).catch(() => null);
        }

        if (!videoUrl) videoUrl = captured.find(u => /^https?:\/\//i.test(u)) || null;

        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(100);
      }
    } finally {
      page.off('response', onResponse);
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(80);
  if (page.url() !== beforeUrl && !page.url().startsWith(beforeUrl)) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => {});
  }

  const media = basic.images.map(url => ({ type: 'image', url }));
  if (videoUrl && /^https?:\/\//i.test(videoUrl) && !/video_dark\.png/i.test(videoUrl)) media.push({ type: 'video', url: videoUrl, poster: basic.images[0] || null });
  return media;
}

async function collectVisible() {
  const cards = await page.evaluate(() => {
    const marker = /Quantity\s*Available/i;
    const hasAll = t => marker.test(t) && /Tier\s*A1\s*Price/i.test(t) && /Tier\s*B1\s*Price/i.test(t) && /Tier\s*C1\s*Price/i.test(t);
    const out = [];

    function cardImage(root) {
      for (const img of root.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        const r = img.getBoundingClientRect();
        if (/^https?:\/\//i.test(src) && !/video_dark\.png/i.test(src) && (img.naturalWidth >= 120 || img.naturalHeight >= 80 || r.width >= 100 || r.height >= 70)) return src;
      }
      for (const n of [root, ...root.querySelectorAll('*')]) {
        const bg = getComputedStyle(n).backgroundImage || '';
        const m = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (m && !/video_dark\.png/i.test(m[1])) return m[1];
      }
      return null;
    }

    let ordinal = 0;
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
          const lines = prefix.split(/\n+/).map(x=>x.trim()).filter(Boolean);
          const openKey = `pp-${Date.now()}-${ordinal++}-${Math.random().toString(36).slice(2,8)}`;
          node.setAttribute('data-pp-open-key', openKey);
          chosen = { text: txt, titleHint: lines.join(' '), titleRaw: lines[0] || prefix, openKey, image: cardImage(node) };
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
    let media = prior?.media || (c.image ? [{ type:'image', url:c.image }] : []);
    if (!expandedTitles.has(c.titleHint) && c.openKey) {
      expandedTitles.add(c.titleHint);
      media = mergeMedia(media, await extractExpandedMedia(c.openKey, c.titleRaw || c.titleHint));
    }
    if (!prior || media.length > (prior.media?.length || 0)) seen.set(key, { ...c, media });
  }
}

await collectVisible();
for (let i = 0; i < 90; i++) {
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')]
      .filter(el => { const s=getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100; })
      .sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,5);
    for (const el of els) el.scrollTop = Math.min(el.scrollTop + Math.max(500, el.clientHeight*.7), el.scrollHeight);
    window.scrollBy(0,800);
  });
  await page.waitForTimeout(170);
  await collectVisible();
}
await page.waitForTimeout(500);
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
  return {title,fields,media:card.media||[]};
}

const byTitle=new Map();
for(const card of seen.values()){
  const parsed=parseCard(card);
  if(!parsed.title||parsed.fields.filter(f=>f.kind==='price').length<3) continue;
  const prior=byTitle.get(parsed.title);
  if(!prior||parsed.media.length>prior.media.length) byTitle.set(parsed.title,parsed);
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
for(const item of byTitle.values()){
  const media=[]; let imageIndex=0;
  for(const m of item.media){
    if(m.type==='image'&&imageIndex<2){
      const cached=await cacheImage(m.url,item.title,imageIndex);
      if(cached){media.push({type:'image',src:cached});imageCount++;mediaCount++;imageIndex++}
    }else if(m.type==='video'&&!media.some(x=>x.type==='video')&&/^https?:\/\//i.test(m.url)&&!/video_dark\.png/i.test(m.url)){
      media.push({type:'video',src:m.url,poster:m.poster||null});videoCount++;mediaCount++;
    }
  }
  if(media.filter(x=>x.type==='image').length>=2&&media.some(x=>x.type==='video')) fullMediaProducts++;
  products.push({title:item.title,fields:item.fields,image:media.find(x=>x.type==='image')?.src||null,media});
}
if(!products.length) throw new Error('No catalog product cards detected');
products.sort((x,y)=>x.title.localeCompare(y.title));
await fs.writeFile(path.join(outDir,'catalog.json'),JSON.stringify({updatedAt:new Date().toISOString(),count:products.length,imageCount,videoCount,mediaCount,fullMediaProducts,products},null,2));
console.log(`Synced ${products.length} products, ${imageCount} images, ${videoCount} real videos, ${mediaCount} media items, ${fullMediaProducts} products with 2 photos + video, with +$${MARKUP} pricing.`);
await browser.close();