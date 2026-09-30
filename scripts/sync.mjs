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
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
await page.goto(SOURCE_URL, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(3000);

// Scroll through the public shared view so lazy-loaded cards are rendered.
for (let i = 0; i < 50; i++) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(250);
}

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
      return /Tier\s*A1\s*Price/i.test(t) && /Tier\s*B1\s*Price/i.test(t) && /Tier\s*C1\s*Price/i.test(t) && /Quantity\s*Available/i.test(t);
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
  const bodyText = (await page.locator('body').innerText()).slice(0, 5000);
  console.error(bodyText);
  throw new Error('No catalog product cards detected');
}

await fs.writeFile(path.join(outDir, 'catalog.json'), JSON.stringify({
  updatedAt: new Date().toISOString(),
  count: products.length,
  products
}, null, 2));

console.log(`Synced ${products.length} products with +$${MARKUP} pricing.`);
await browser.close();
