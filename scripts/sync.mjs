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
await page.waitForTimeout(3000);

const seen = new Map();
const videoChecked = new Set();
let videoThumbCount = 0;
let capturedVideoCount = 0;

function cleanVideoUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (/attachment_thumbnails\/video_dark\.png/i.test(url)) return null;
  return url;
}

async function extractRecordVideo(openKey, title) {
  if (!openKey || videoChecked.has(title)) return null;
  videoChecked.add(title);

  const card = page.locator(`[data-pp-open-key="${openKey}"]`).first();
  if (!(await card.count())) return null;

  try {
    await card.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => {});
    await card.click({ timeout: 1600 });
  } catch {
    return null;
  }

  await page.waitForTimeout(180);

  const thumb = page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').first();
  if (!(await thumb.count())) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(60);
    return null;
  }

  videoThumbCount++;
  const captured = [];
  const onResponse = response => {
    try {
      const url = response.url();
      const ct = String(response.headers()['content-type'] || '').toLowerCase();
      if (ct.startsWith('video/') || /\.(mp4|mov|webm)(?:$|\?)/i.test(url)) {
        const clean = cleanVideoUrl(url);
        if (clean) captured.push(clean);
      }
    } catch {}
  };
  page.on('response', onResponse);

  try {
    await thumb.click({ timeout: 1200 }).catch(async () => {
      await thumb.locator('xpath=..').click({ timeout: 900 }).catch(() => {});
    });

    let direct = null;
    for (let i = 0; i < 12 && !direct; i++) {
      await page.waitForTimeout(180);

      direct = await page.evaluate(() => {
        const visible = el => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
        };

        const videos = [...document.querySelectorAll('video')].filter(visible).reverse();
        for (const v of videos) {
          const src = v.currentSrc || v.src || v.querySelector('source')?.src || '';
          if (/^https?:\/\//i.test(src)) return src;
          try { v.muted = true; v.play().catch(() => {}); } catch {}
        }

        const links = [...document.querySelectorAll('a[href]')].filter(visible).reverse();
        for (const a of links) {
          const href = a.href || '';
          if (/^https?:\/\//i.test(href) && /\.(mp4|mov|webm)(?:$|\?)/i.test(href)) return href;
        }
        return null;
      }).catch(() => null);

      direct = cleanVideoUrl(direct) || captured.at(-1) || null;
    }

    if (direct) {
      capturedVideoCount++;
      console.log(`VIDEO_LINK ${title} -> ${new URL(direct).origin}${new URL(direct).pathname}`);
      return direct;
    }
    console.log(`VIDEO_MISSED ${title}`);
    return null;
  } finally {
    page.off('response', onResponse);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(60);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(60);
  }
}

async function collectVisible() {
  const cards = await page.evaluate(() => {
    const marker = /Quantity\s*Available/i;
    const hasAll = t => marker.test(t) && /Tier\s*A1\s*Price/i.test(t) && /Tier\s*B1\s*Price/i.test(t) && /Tier\s*C1\s*Price/i.test(t);
    const out = [];

    function normalKey(url) {
      try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
      } catch { return url; }
    }

    function mediaFrom(root) {
      const media = [];
      const keys = new Set();
      const add = (url, type, poster = null) => {
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (/attachment_thumbnails\/video_dark\.png/i.test(url)) return;
        const key = `${type}:${normalKey(url)}`;
        if (keys.has(key)) return;
        keys.add(key);
        media.push({ url, type, poster: poster && /^https?:\/\//i.test(poster) ? poster : null });
      };

      for (const video of root.querySelectorAll('video')) {
        const poster = video.poster || null;
        if (/^https?:\/\//i.test(video.currentSrc || '')) add(video.currentSrc, 'video', poster);
        if (/^https?:\/\//i.test(video.src || '')) add(video.src, 'video', poster);
        for (const source of video.querySelectorAll('source')) add(source.src || source.getAttribute('src'), 'video', poster);
      }

      for (const img of root.querySelectorAll('img')) {
        const src = img.currentSrc || img.src || '';
        const r = img.getBoundingClientRect();
        if ((img.naturalWidth >= 120 || img.naturalHeight >= 80 || r.width >= 100 || r.height >= 70) && !/video_dark\.png/i.test(src)) add(src, 'image');
      }

      for (const n of [root, ...root.querySelectorAll('*')]) {
        const bg = getComputedStyle(n).backgroundImage || '';
        const m = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (!m || /video_dark\.png/i.test(m[1])) continue;
        const r = n.getBoundingClientRect();
        if (r.width >= 100 && r.height >= 70) add(m[1], 'image');
      }

      return [
        ...media.filter(x => x.type === 'image').slice(0, 2),
        ...media.filter(x => x.type === 'video').slice(0, 1)
      ];
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
          const openKey = `pp-${Date.now()}-${ordinal++}-${Math.random().toString(36).slice(2, 8)}`;
          node.setAttribute('data-pp-open-key', openKey);
          chosen = {
            text: txt,
            titleHint: prefix.split(/\n+/).map(x => x.trim()).filter(Boolean).join(' '),
            openKey,
            media: mediaFrom(node)
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
    let media = prior?.media || c.media || [];

    if (!media.some(m => m.type === 'video')) {
      const videoUrl = await extractRecordVideo(c.openKey, c.titleHint);
      if (videoUrl) media = [...media, { type: 'video', url: videoUrl, poster: media.find(m => m.type === 'image')?.url || null }];
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
    for (const el of els) el.scrollTop = Math.min(el.scrollTop + Math.max(500, el.clientHeight * 0.7), el.scrollHeight);
    window.scrollBy(0, 800);
  });
  await page.waitForTimeout(160);
  await collectVisible();
}
await page.waitForTimeout(600);
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
      const videoUrl = cleanVideoUrl(m.url);
      if (videoUrl) {
        media.push({ type: 'video', src: videoUrl, poster: m.poster || null });
        videoCount++;
        mediaCount++;
      }
    }
  }

  if (!media.length) continue;
  const firstImage = media.find(x => x.type === 'image')?.src || null;
  products.push({ title: item.title, fields: item.fields, image: firstImage, media });
}

if (!products.length) throw new Error('No media-backed catalog products detected');

products.sort((x, y) => x.title.localeCompare(y.title));
await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify({
  updatedAt: new Date().toISOString(),
  count: products.length,
  imageCount,
  videoCount,
  mediaCount,
  filteredToMediaOnly: true,
  products
}, null, 2));

console.log(`Published ${products.length} media-backed strains: ${imageCount} images, ${videoCount} Airtable video links. Video thumbnails seen: ${videoThumbCount}; links captured: ${capturedVideoCount}. +$${MARKUP} pricing.`);
await browser.close();