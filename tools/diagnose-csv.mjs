import { chromium } from 'playwright';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');
const SKU='T9V3-IXB';

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page=await context.newPage();
const safe=raw=>{try{const u=new URL(raw);return `${u.origin}${u.pathname}`}catch{return String(raw).slice(0,220)}};

await page.goto(SOURCE_URL,{waitUntil:'domcontentloaded',timeout:45000});
await page.waitForFunction(()=>/Tier\s*A1\s*Price/i.test(document.body?.innerText||''),{timeout:60000}).catch(()=>{});
await page.waitForTimeout(1400);

const toggle=page.locator('[aria-label="toggle view search input"]:visible').first();
console.log('SEARCH_TOGGLE='+(await toggle.count()));
if(await toggle.count()){
  await toggle.click({timeout:1600}).catch(()=>{});
  await page.waitForTimeout(150);
  const input=page.locator('input:visible').last();
  console.log('SEARCH_INPUT='+(await input.count()));
  if(await input.count()){
    await input.fill(SKU);
    await page.waitForTimeout(500);
  }
}

let cardKey='';
for(let attempt=0;attempt<12&&!cardKey;attempt++){
  cardKey=await page.evaluate((sku)=>{
    const good=t=>t.includes(sku)&&/Quantity\s*Available/i.test(t)&&/Tier\s*A1\s*Price/i.test(t);
    for(const el of [...document.querySelectorAll('body *')]){
      const txt=(el.innerText||'').trim();if(!good(txt)||txt.length>3000)continue;
      let node=el;
      for(let d=0;d<9&&node;d++,node=node.parentElement){
        const t=(node.innerText||'').trim();if(!good(t)||t.length>3500)continue;
        const key='target-'+Math.random().toString(36).slice(2);node.setAttribute('data-target-card',key);return key;
      }
    }
    return '';
  },SKU);
  if(!cardKey){await page.evaluate(()=>{const els=[...document.querySelectorAll('*')].filter(el=>{const s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+50}).sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,5);for(const el of els)el.scrollTop=Math.min(el.scrollTop+500,el.scrollHeight)});await page.waitForTimeout(120);}
}
if(!cardKey)throw new Error('Target SKU card not found');

const card=page.locator(`[data-target-card="${cardKey}"]`).first();
await card.scrollIntoViewIfNeeded().catch(()=>{});
await card.click({timeout:1800}).catch(()=>{});
await page.waitForTimeout(350);

let button=page.locator('[role="button"][aria-label*=".mp4"]:visible,[role="button"][aria-label*=".mov"]:visible,[role="button"][aria-label*=".webm"]:visible').first();
if(!(await button.count())){
  const thumb=page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').first();
  if(await thumb.count())button=thumb.locator('xpath=ancestor::*[@role="button"][1]');
}
console.log('VIDEO_BUTTON='+(await button.count()));
if(!(await button.count()))throw new Error('Target record opened but public video attachment control was not exposed');
console.log('ARIA='+(await button.getAttribute('aria-label').catch(()=>'')));

const before=page.url();
const req=[];const res=[];const popups=[];
page.on('request',r=>{try{const u=r.url();if(/mp4|mov|webm|video|attachment|usercontent|download/i.test(u))req.push(safe(u))}catch{}});
page.on('response',r=>{try{const u=r.url(),ct=String(r.headers()['content-type']||'');if(/mp4|mov|webm|video|attachment|usercontent|octet-stream/i.test(u+' '+ct))res.push({s:r.status(),ct,u:safe(u)})}catch{}});
context.on('page',p=>popups.push(p));

await button.scrollIntoViewIfNeeded().catch(()=>{});
await button.focus().catch(()=>{});
await page.keyboard.press('Space').catch(()=>{});
await page.waitForTimeout(1200);
console.log('URL_CHANGED_AFTER_SPACE='+(page.url()!==before));
console.log('CURRENT_URL='+safe(page.url()));

const state=await page.evaluate(()=>{
  const vis=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>10&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden'};
  const videos=[...document.querySelectorAll('video')].filter(vis).map(v=>v.currentSrc||v.src||v.querySelector('source')?.src||'').filter(Boolean);
  const links=[...document.querySelectorAll('a[href]')].filter(vis).map(a=>a.href||'').filter(x=>/mp4|mov|webm|attachment|usercontent|download/i.test(x));
  const controls=[...document.querySelectorAll('button,[role="button"]')].filter(vis).map(el=>(el.getAttribute('aria-label')||'')+' '+(el.innerText||'')).filter(x=>/download|attachment|video/i.test(x));
  return {videos,links,controls,dialogs:[...document.querySelectorAll('[role="dialog"]')].filter(vis).length};
});
console.log('VIDEO_ELEMENT_COUNT='+state.videos.length);
console.log('VIDEO_LINK_COUNT='+state.links.length);
console.log('DOWNLOAD_CONTROL='+state.controls.some(x=>/download/i.test(x)));
console.log('REQUEST_COUNT='+req.length);
console.log('RESPONSE_COUNT='+res.length);
console.log('REQUESTS='+JSON.stringify([...new Set(req)].slice(-20)));
console.log('RESPONSES='+JSON.stringify(res.slice(-20)));
console.log('POPUPS='+popups.length);
if(popups[0])console.log('POPUP_URL='+safe(popups[0].url()));
if(state.videos[0])console.log('VIDEO_SRC='+safe(state.videos[0]));
if(state.links[0])console.log('VIDEO_LINK='+safe(state.links[0]));

await browser.close();
