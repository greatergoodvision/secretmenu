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
  const images = out.filter(x => x.type === 'image').slice(0, 2);
  const videos = out.filter(x => x.type === 'video').slice(0, 1);
  return [...images, ...videos];
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

  await page.waitForTimeout(260);

  const media = await page.evaluate((wantedTitle) => {
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
      return r.width > innerWidth * .45 && r.height > innerHeight * .45 && (el.innerText || '').includes(wantedTitle.slice(0, 28));
    });
    const root = dialogs.at(-1) || fixed.sort((a,b) => {
      const za = Number.parseInt(getComputedStyle(a).zIndex) || 0;
      const zb = Number.parseInt(getComputedStyle(b).zIndex) || 0;
      return za - zb;
    }).at(-1);
    if (!root) return [];

    const found = [];
    const keys = new Set();
    const normal = url => {
      try { const u = new URL(url); u.search=''; u.hash=''; return u.toString(); } catch { return url; }
    };
    const add = (url, type, poster = null) => {
      if (!url || !/^https?:\/\//i.test(url)) return;
      const key = `${type}:${normal(url)}`;
      if (keys.has(key)) return;
      keys.add(key);
      found.push({ url, type, poster: poster && /^https?:\/\//i.test(poster) ? poster : null });
    };

    for (const video of root.querySelectorAll('video')) {
      const poster = video.poster || null;
      add(video.currentSrc || video.src, 'video', poster);
      for (const source of video.querySelectorAll('source')) add(source.src || source.getAttribute('src'), 'video', poster);
    }

    for (const img of root.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      const r = img.getBoundingClientRect();
      const useful = img.naturalWidth >= 180 || img.naturalHeight >= 120 || (r.width >= 140 && r.height >= 90) || /airtable|attachment|usercontent/i.test(src);
      if (useful) add(src, 'image');
      const srcset = img.getAttribute('srcset') || '';
      for (const bit of srcset.split(',')) {
        const u = bit.trim().split(/\s+/)[0];
        if (u) add(u, 'image');
      }
    }

    for (const source of root.querySelectorAll('source')) {
      const src = source.src || source.getAttribute('src') || '';
      const type = (source.type || '').toLowerCase();
      if (type.startsWith('video/') || /\.(mp4|webm|mov)(?:$|\?)/i.test(src)) add(src, 'video');
      if (type.startsWith('image/')) add(src, 'image');
    }

    for (const el of [root, ...root.querySelectorAll('*')]) {
      const bg = getComputedStyle(el).backgroundImage || '';
      for (const m of bg.matchAll(/url\(["']?(https?:\/\/[^"')]+)["']?\)/ig)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 80) add(m[1], 'image');
      }

      for (const attr of [...el.attributes]) {
        const v = attr.value || '';
        if (!/^https?:\/\//i.test(v)) continue;
        const name = attr.name.toLowerCase();
        if (/video|mp4|webm|mov/i.test(v) || /video|movie/i.test(name)) add(v, 'video');
        else if (/image|photo|thumb|poster|src|href|url/i.test(name) || /jpe?g|png|webp|gif/i.test(v)) add(v, 'image');
      }
    }

    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.href || '';
      if (/\.(mp4|webm|mov)(?:$|\?)/i.test(href) || /video/i.test(a.innerText || a.getAttribute('aria-label') || '')) add(href, 'video');
      else if (/\.(jpe?g|png|webp|gif)(?:$|\?)/i.test(href)) add(href, 'image');
    }

    const images = found.filter(x => x.type === 'image').slice(0, 2);
    const videos = found.filter(x => x.type === 'video').slice(0, 1);
    return [...images, ...videos];
  }, title).catch(() => []);

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(80);
  if (page.url() !== beforeUrl && !page.url().startsWith(beforeUrl)) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => {});
  }
  return media;
}

async function collectVisible() {
  const cards = await page.evaluate(() => {
    const marker = /Quantity\s*Available/i;
    const hasAll = t => marker.test(t) && /Tier\s*A1\s*Price/i.test(t) && /Tier\s*B1\s*Price/i.test(t) && /Tier\s*C1\s*Price/i.test(t);
    const out = [];

    function normalKey(url) {
      try { const u = new URL(url); u.search=''; u.hash=''; return u.toString(); } catch { return url; }
    }

    function mediaFrom(root) {
      const media = [];
      const keys = new Set();
      const add = (url, type, poster = null) => {
        if (!url || !/^https?:\/\//i.test(url)) return;
        const key = `${type}:${normalKey(url)}`;
        if (keys.has(key)) return;
        keys.add(key);
        media.push({ url, type, poster: poster && /^https?:\/\//i.test(poster) ? poster : null });
      };

      for (const video of root.querySelectorAll('video')) {
        const poster = video.poster || null;
        add(video.currentSrc || video.src, 'video', poster);
        for (const source of video.querySelectorAll('source')) add(source.src || source.getAttribute('src'), 'video', poster);
      }
      for (const img of root.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        const r = img.getBoundingClientRect();
        if (img.naturalWidth >= 120 || img.naturalHeight >= 80 || r.width >= 100 || r.height >= 70 || /airtable|usercontent|attachment|cdn/i.test(src)) add(src, 'image');
      }
      for (const n of [root, ...root.querySelectorAll('*')]) {
        const bg = getComputedStyle(n).backgroundImage || '';
        const m = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (m) {
          const r = n.getBoundingClientRect();
          if (r.width >= 100 && r.height >= 70) add(m[1], 'image');
        }
      }
      return [...media.filter(x=>x.type==='image').slice(0,2), ...media.filter(x=>x.type==='video').slice(0,1)];
    }

    let ordinal = 0;
    for (const el of [...document.querySelectorAll('body *')]) {
      const base = (el.innerText || '').trim();
      if (!base || !hasAll(base) || base.length > 1800) continue;

      let node = el;
      let chosen = null;
      for (let depth = 0; depth < 9 && node; depth++, node = node.parentElement) {
        const txt = (node.innerText || '').trim();
        if (!hasAll(txt) || txt.length > 3000) continue;
        const q = txt.search(marker);
        const prefix = q >= 0 ? txt.slice(0, q).trim() : '';
        if (prefix && prefix.length <= 500) {
          const titleRaw = prefix.split(/\n+/).map(x=>x.trim()).filter(Boolean)[0] || prefix;
          const openKey = `pp-${Date.now()}-${ordinal++}-${Math.random().toString(36).slice(2,8)}`;
          node.setAttribute('data-pp-open-key', openKey);
          chosen = {
            text: txt,
            titleHint: prefix.split(/\n+/).map(x => x.trim()).filter(Boolean).join(' '),
            titleRaw,
            openKey,
            media: mediaFrom(node)
          };
          break;
        }
      }

      if (!chosen) continue;
      if (!chosen.titleHint || /^Quantity\s*Available$/i.test(chosen.titleHint)) continue;
      out.push(chosen);
    }
    return out;
  });

  for (const c of cards) {
    const key = `${c.titleHint}|${c.text}`;
    const prior = seen.get(key);
    let media = mergeMedia(prior?.media || [], c.media || []);

    if (!expandedTitles.has(c.titleHint) && media.length < 3 && c.openKey) {
      expandedTitles.add(c.titleHint);
      const expanded = await extractExpandedMedia(c.openKey, c.titleRaw || c.titleHint);
      media = mergeMedia(media, expanded);
    }

    if (!prior || media.length > (prior.media?.length || 0)) seen.set(key, { ...c, media });
  }
}

await collectVisible();
for (let i = 0; i < 90; i++) {
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')]
      .filter(el => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 5);
    for (const el of els) el.scrollTop = Math.min(el.scrollTop + Math.max(500, el.clientHeight * .7), el.scrollHeight);
    window.scrollBy(0, 800);
  });
  await page.waitForTimeout(170);
  await collectVisible();
}
await page.waitForTimeout(700);
await collectVisible();

const moneyRe = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/;
function bumped(value) {
  const m = String(value).match(moneyRe);
  if (!m) return String(value).trim();
  const original = m[1];
  const amount = Number(original.replace(/,/g, '')) + MARKUP;
  const decimals = original.includes('.') ? 2 : 0;
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function capture(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function parseCard(card) {
  const text = card.text.replace(/\r/g, '');
  const title = card.titleHint.trim();
  const qty = capture(text, /Quantity\s*Available\s*\n?\s*([^\n]+)/i);
  const a = capture(text, /Tier\s*A1\s*Price\s*\(1-10\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const b = capture(text, /Tier\s*B1\s*Price\s*\(10-50\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const c = capture(text, /Tier\s*C1\s*Price\s*\(50\+\s*lbs\)\s*\n?\s*([^\n]+)/i);
  const quality = capture(text, /Quality\s*\n?\s*([^\n]+)/i);

  const fields = [];
  if (qty) fields.push({ label: 'Quantity Available', value: qty, kind: 'text' });
  if (a) fields.push({ label: 'Tier A1 Price (1-10 lbs)', value: bumped(a), kind: 'price' });
  if (b) fields.push({ label: 'Tier B1 Price (10-50 lbs)', value: bumped(b), kind: 'price' });
  if (c) fields.push({ label: 'Tier C1 Price (50+ lbs)', value: bumped(c), kind: 'price' });
  if (quality) fields.push({ label: 'Quality', value: quality, kind: 'text' });
  return { title, fields, media: card.media || [] };
}

const byTitle = new Map();
for (const card of seen.values()) {
  const parsed = parseCard(card);
  if (!parsed.title || parsed.fields.filter(f => f.kind === 'price').length < 3) continue;
  const prior = byTitle.get(parsed.title);
  if (!prior || parsed.media.length > prior.media.length) byTitle.set(parsed.title, parsed);
}

async function cacheImage(url, title, mediaIndex) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : type.includes('gif') ? '.gif' : '.jpg';
    const file = crypto.createHash('sha1').update(`${title}|${mediaIndex}|${url}`).digest('hex').slice(0, 18) + ext;
    await fs.writeFile(path.join(imageDir, file), buf);
    return `images/${file}`;
  } catch { return null; }
}

const products = [];
let imageCount = 0;
let videoCount = 0;
let mediaCount = 0;
let fullMediaProducts = 0;
for (const item of byTitle.values()) {
  const media = [];
  let imageIndex = 0;
  for (const m of item.media) {
    if (m.type === 'image' && imageIndex < 2) {
      const cached = await cacheImage(m.url, item.title, imageIndex);
      if (cached) {
        media.push({ type: 'image', src: cached });
        imageCount++;
        mediaCount++;
        imageIndex++;
      }
    } else if (m.type === 'video' && !media.some(x => x.type === 'video')) {
      media.push({ type: 'video', src: m.url, poster: m.poster || null });
      videoCount++;
      mediaCount++;
    }
  }
  if (media.filter(x=>x.type==='image').length >= 2 && media.some(x=>x.type==='video')) fullMediaProducts++;
  const firstImage = media.find(x => x.type === 'image')?.src || null;
  products.push({ title: item.title, fields: item.fields, image: firstImage, media });
}

if (!products.length) throw new Error('No catalog product cards detected');

products.sort((x, y) => x.title.localeCompare(y.title));
await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify({
  updatedAt: new Date().toISOString(),
  count: products.length,
  imageCount,
  videoCount,
  mediaCount,
  fullMediaProducts,
  products
}, null, 2));

console.log(`Synced ${products.length} products, ${imageCount} images, ${videoCount} videos, ${mediaCount} media items, ${fullMediaProducts} products with 2 photos + video, with +$${MARKUP} pricing.`);
await browser.close();