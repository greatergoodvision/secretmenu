import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
const MARKUP = 50;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');

const outDir = path.resolve('public');
const imageDir = path.join(outDir, 'images');
await fs.mkdir(imageDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1200 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  locale: 'en-US'
});

// Airtable keeps background requests open, so networkidle can hang forever.
await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(
  () => /Quantity\s*Available/i.test(document.body?.innerText || '') || /Tier\s*A1\s*Price/i.test(document.body?.innerText || ''),
  { timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(4000);

// Scroll the largest scrollable containers because Airtable card views often
// virtualize inside a div rather than using the browser window.
for (let i = 0; i < 70; i++) {
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')]
      .filter(el => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 100;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 5);
    for (const el of els) {
      el.scrollTop = Math.min(el.scrollTop + Math.max(700, el.clientHeight * 0.9), el.scrollHeight);
    }
    window.scrollBy(0, 1000);
  });
  await page.waitForTimeout(180);
}
await page.waitForTimeout(1500);

const rawCards = await page.evaluate(() => {
  const all = [...document.querySelectorAll('body *')];
  const cards = [];
  for (const el of all) {
    const text = (el.innerText || '').trim();
    if (!text) continue;
    if (!/Tier\s*A1\s*Price/i.test(text)) continue;
    if (!/Tier\s*B1\s*Price/i.test(text)) continue;
    if (!/Tier\s*C1\s*Price/i.test(text)) continue;
    if (!/Quantity\s*Available/i.test(text)) continue;
    if (text.length > 1800) continue;

    const childMatch = [...el.children].some(c => {
      const t = (c.innerText || '').trim();
      return t.length < 1800 && /Tier\s*A1\s*Price/i.test(t) && /Tier\s*B1\s*Price/i.test(t) && /Tier\s*C1\s*Price/i.test(t) && /Quantity\s*Available/i.test(t);
    });
    if (childMatch) continue;

    const img = el.querySelector('img');
    cards.push({ text, image: img?.src || null });
  }
  return cards;
});

const moneyRe = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/g;
function bumpMoney(s) {
  return String(s).replace(moneyRe, (_, num) => {
    const decimals = num.includes('.') ? 2 : 0;
    const value = Number(num.replace(/,/g, '')) + MARKUP;
    return '$' + value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  });
}

function parseCard(text) {
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const title = lines[0] || 'Product';
  const fields = [];
  for (let i = 1; i < lines.length; i++) {
    const label = lines[i];
    if (/^(Quantity\s*Available|Quality|Tier\s*A1\s*Price.*|Tier\s*B1\s*Price.*|Tier\s*C1\s*Price.*)$/i.test(label) && i + 1 < lines.length) {
      const raw = lines[++i];
      fields.push({
        label,
        value: /Price/i.test(label) ? bumpMoney(raw) : raw,
        kind: /Price/i.test(label) ? 'price' : 'text'
      });
    }
  }
  return { title, fields };
}

const unique = new Map();
for (const card of rawCards) {
  const parsed = parseCard(card.text);
  if (!parsed.title || parsed.fields.length < 4) continue;
  unique.set(parsed.title + '|' + card.text, { ...parsed, imageUrl: card.image });
}

const products = [];
let idx = 0;
for (const item of unique.values()) {
  let image = null;
  if (item.imageUrl?.startsWith('http')) {
    try {
      const res = await fetch(item.imageUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const type = res.headers.get('content-type') || '';
        const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
        const file = crypto.createHash('sha1').update(item.title + idx).digest('hex').slice(0, 16) + ext;
        await fs.writeFile(path.join(imageDir, file), buf);
        image = `images/${file}`;
      }
    } catch {}
  }
  products.push({ title: item.title, fields: item.fields, image });
  idx++;
}

if (!products.length) {
  const bodyText = (await page.locator('body').innerText()).slice(0, 8000);
  console.error('PAGE TEXT START');
  console.error(bodyText);
  console.error('PAGE TEXT END');
  throw new Error('No catalog product cards detected');
}

await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify({
  updatedAt: new Date().toISOString(),
  count: products.length,
  products
}, null, 2));

console.log(`Synced ${products.length} products with +$${MARKUP} pricing.`);
await browser.close();
