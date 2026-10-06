import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
const MARKUP = 600;
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
await page.waitForTimeout(2200);

const records = new Map();
const opened = new Set();

function uniq(items) {
  const out = [], seen = new Set();
  for (const x of items) {
    if (!x || !/^https?:\/\//i.test(x)) continue;
    if (/attachment_thumbnails\/video_(?:dark|white)\.png/i.test(x)) continue;
    if (seen.has(x)) continue;
    seen.add(x); out.push(x);
  }
  return out;
}

async function expandedMedia(openKey, title) {
  if (!openKey || opened.has(title)) return null;
  opened.add(title);
  const card = page.locator(`[data-pp-open-key="${openKey}"]`).first();
  if (!(await card.count())) return null;

  try {
    await card.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => {});
    await card.click({ timeout: 1800 });
  } catch { return null; }
  await page.waitForTimeout(220);

  const imageUrls = await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const out = [], seen = new Set();
    const add = u => {
      if (!u || !/^https?:\/\//i.test(u) || /attachment_thumbnails\/video_(?:dark|white)\.png/i.test(u)) return;
      if (seen.has(u)) return; seen.add(u); out.push(u);
    };

    const controls = [...document.querySelectorAll('[role="button"][aria-label^="View attachment"]')].filter(visible);
    for (const control of controls) {
      const label = control.getAttribute('aria-label') || '';
      if (!/\.(jpe?g|png|webp|gif|heic)[”\"]?$/i.test(label)) continue;
      for (const img of control.querySelectorAll('img')) {
        add(img.currentSrc || img.src || '');
        for (const part of (img.getAttribute('srcset') || '').split(',')) add(part.trim().split(/\s+/)[0] || '');
      }
    }

    if (out.length < 2) {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const root = dialogs.at(-1) || document.body;
      for (const img of root.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '', r = img.getBoundingClientRect();
        if ((img.naturalWidth >= 160 || img.naturalHeight >= 100 || r.width >= 120 || r.height >= 80) && /airtableusercontent/i.test(src)) add(src);
      }
    }
    return out.slice(0, 2);
  }).catch(() => []);

  let videoUrl = null;
  let viewerUrl = null;
  let videoButton = page.locator('[role="button"][aria-label^="View attachment"][aria-label*=".mp4"]:visible,[role="button"][aria-label^="View attachment"][aria-label*=".mov"]:visible,[role="button"][aria-label^="View attachment"][aria-label*=".webm"]:visible,[role="button"][aria-label^="View attachment"][aria-label*=".m4v"]:visible').first();
  if (!(await videoButton.count())) {
    const thumb = page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').first();
    if (await thumb.count()) videoButton = thumb.locator('xpath=ancestor::*[@role="button"][1]');
  }

  if (await videoButton.count()) {
    const captured = [];
    const onResponse = response => {
      try {
        const u = response.url();
        const ct = String(response.headers()['content-type'] || '').toLowerCase();
        if ((ct.startsWith('video/') || /\.(mp4|mov|webm|m4v)(?:$|\?)/i.test(u)) && /^https?:\/\//i.test(u)) captured.push(u);
      } catch {}
    };
    page.on('response', onResponse);
    try {
      await videoButton.scrollIntoViewIfNeeded().catch(() => {});
      await videoButton.focus().catch(() => {});
      await page.keyboard.press('Space').catch(() => {});

      for (let i = 0; i < 12 && !videoUrl; i++) {
        await page.waitForTimeout(120);
        videoUrl = await page.evaluate(() => {
          const visible = el => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
          };
          const vids = [...document.querySelectorAll('video')].filter(visible).reverse();
          for (const v of vids) {
            const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
            if (/^https?:\/\//i.test(src)) return src;
          }
          return null;
        }).catch(() => null);
        if (!videoUrl && captured.length) videoUrl = captured.at(-1);
      }
      if (videoUrl) viewerUrl = page.url();
    } finally {
      page.off('response', onResponse);
      const closeViewer = page.locator('[aria-label="Close attachment viewer"]:visible').first();
      if (await closeViewer.count()) await closeViewer.click({ timeout: 900 }).catch(() => {});
      else await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(70);
    }
  }

  const closeRecord = page.locator('[aria-label="Close dialog"]:visible').first();
  if (await closeRecord.count()) await closeRecord.click({ timeout: 900 }).catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(60);

  const images = uniq(imageUrls).slice(0, 2);
  if (images.length < 2 || !videoUrl) return { images, video: null };
  return { images, video: { url: videoUrl, viewer: viewerUrl } };
}

async function collectVisible() {
  const cards = await page.evaluate(() => {
    const marker = /Quantity\s*Available/i;
    const good = t => marker.test(t) && /Tier\s*A1\s*Price/i.test(t) && /Tier\s*B1\s*Price/i.test(t) && /Tier\s*C1\s*Price/i.test(t);
    const out = [], local = new Set(); let n = 0;
    for (const el of [...document.querySelectorAll('body *')]) {
      const base = (el.innerText || '').trim();
      if (!base || !good(base) || base.length > 1800) continue;
      let node = el;
      for (let d = 0; d < 9 && node; d++, node = node.parentElement) {
        const txt = (node.innerText || '').trim();
        if (!good(txt) || txt.length > 3000) continue;
        const q = txt.search(marker), prefix = q >= 0 ? txt.slice(0, q).trim() : '';
        const lines = prefix.split(/\n+/).map(x => x.trim()).filter(Boolean);
        if (!lines.length || prefix.length > 500) continue;
        const title = lines[0];
        if (local.has(title)) break;
        local.add(title);
        const openKey = `pp-${Date.now()}-${n++}-${Math.random().toString(36).slice(2,8)}`;
        node.setAttribute('data-pp-open-key', openKey);
        out.push({ title, text: txt, openKey });
        break;
      }
    }
    return out;
  });

  for (const c of cards) {
    if (records.has(c.title)) continue;
    const media = await expandedMedia(c.openKey, c.title);
    records.set(c.title, { title: c.title, text: c.text, media });
  }
}

await collectVisible();
for (let i = 0; i < 100; i++) {
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')]
      .filter(el => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100; })
      .sort((a,b) => b.scrollHeight - a.scrollHeight).slice(0,5);
    for (const el of els) el.scrollTop = Math.min(el.scrollTop + Math.max(520, el.clientHeight * .72), el.scrollHeight);
    window.scrollBy(0, 820);
  });
  await page.waitForTimeout(120);
  await collectVisible();
}
await page.waitForTimeout(350);
await collectVisible();

const moneyRe = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/;
const capture = (text,re) => text.match(re)?.[1]?.trim() || '';
function bumped(v) {
  const m = String(v).match(moneyRe); if (!m) return String(v).trim();
  const raw = m[1], amount = Number(raw.replace(/,/g,'')) + MARKUP, dec = raw.includes('.') ? 2 : 0;
  return '$' + amount.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});
}
function fields(text) {
  text = text.replace(/\r/g,''); const f = [];
  const qty = capture(text,/Quantity\s*Available\s*\n?\s*([^\n]+)/i);
  const a = capture(text,/Tier\s*A1\s*Price\s*\(1-10\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const b = capture(text,/Tier\s*B1\s*Price\s*\(10-50\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const c = capture(text,/Tier\s*C1\s*Price\s*\(50\+\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const q = capture(text,/Quality\s*\n?\s*([^\n]+)/i);
  if (qty) f.push({label:'Quantity Available',value:qty,kind:'text'});
  if (a) f.push({label:'Tier A1 Price (1-10 lbs)',value:bumped(a),kind:'price'});
  if (b) f.push({label:'Tier B1 Price (10-50 lbs)',value:bumped(b),kind:'price'});
  if (c) f.push({label:'Tier C1 Price (50+ lbs)',value:bumped(c),kind:'price'});
  if (q) f.push({label:'Quality',value:q,kind:'text'});
  return f;
}

const products = [];
let complete = 0, twoPhotos = 0, videos = 0;
for (const r of records.values()) {
  const f = fields(r.text);
  const images = r.media?.images || [];
  const video = r.media?.video || null;
  if (images.length >= 2) twoPhotos++;
  if (video?.url) videos++;
  if (images.length < 2 || !video?.url || f.filter(x => x.kind === 'price').length < 3) continue;
  complete++;
  products.push({
    title:r.title,
    fields:f,
    image:images[0],
    media:[
      {type:'image',src:images[0]},
      {type:'image',src:images[1]},
      {type:'video',src:video.url,poster:images[0],viewer:video.viewer || null}
    ]
  });
}
products.sort((a,b) => a.title.localeCompare(b.title));
console.log(`Scanned ${records.size} products: ${twoPhotos} with 2 photos, ${videos} with real Airtable video, ${complete} complete.`);
if (!products.length) throw new Error('No complete 2-photo + video strains detected');

await fs.writeFile('public/catalog.json', JSON.stringify({
  updatedAt:new Date().toISOString(),
  count:products.length,
  imageCount:products.length*2,
  videoCount:products.length,
  mediaCount:products.length*3,
  completeMediaOnly:true,
  mediaHostedBy:'airtable',
  products
}, null, 2));
console.log(`Published ${products.length} strains with exactly 2 Airtable-hosted photos + 1 Airtable-hosted video each. +$${MARKUP} pricing.`);
await browser.close();
