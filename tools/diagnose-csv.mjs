import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page = await context.newPage();
await page.goto(SOURCE_URL,{waitUntil:'domcontentloaded',timeout:45000});
await page.waitForFunction(()=>/Tier\s*A1\s*Price/i.test(document.body?.innerText||''),{timeout:60000}).catch(()=>{});
await page.waitForTimeout(1800);

const more=page.locator('[aria-label="More view options"]:visible').first();
console.log('MORE_COUNT='+(await more.count()));
if(await more.count()){
  await more.click({timeout:2000}).catch(()=>{});
  await page.waitForTimeout(300);
}

const menuText=await page.locator('body').innerText().catch(()=> '');
console.log('HAS_DOWNLOAD_CSV='+/download\s+csv/i.test(menuText));
console.log('HAS_COPY_OPTION='+/copy/i.test(menuText));

const csvControl=page.locator('button:visible,[role="menuitem"]:visible,[role="button"]:visible,a:visible').filter({hasText:/download\s+csv/i}).first();
console.log('CSV_CONTROL_COUNT='+(await csvControl.count()));

if(await csvControl.count()){
  const [download]=await Promise.all([
    page.waitForEvent('download',{timeout:8000}),
    csvControl.click({timeout:2500})
  ]);
  const p=await download.path();
  const text=await fs.readFile(p,'utf8');
  const lines=text.split(/\r?\n/).filter(Boolean);
  const header=lines[0]||'';
  const airtableUrls=(text.match(/https?:\/\/[^,\s\"]*airtableusercontent\.com[^,\s\"]*/gi)||[]).length;
  const mp4s=(text.match(/\.mp4\b/gi)||[]).length;
  const jpgs=(text.match(/\.(?:jpe?g|png|webp)\b/gi)||[]).length;
  console.log('CSV_BYTES='+text.length);
  console.log('CSV_ROWS='+Math.max(0,lines.length-1));
  console.log('CSV_HEADER='+header.slice(0,500));
  console.log('CSV_AIRTABLE_URL_COUNT='+airtableUrls);
  console.log('CSV_MP4_COUNT='+mp4s);
  console.log('CSV_IMAGE_EXT_COUNT='+jpgs);
}

await browser.close();
