import { chromium } from 'playwright';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page = await context.newPage();
const safeUrl = raw => { try { const u=new URL(raw); return `${u.origin}${u.pathname}`; } catch { return String(raw).slice(0,180); } };

await page.goto(SOURCE_URL,{waitUntil:'domcontentloaded',timeout:45000});
await page.waitForFunction(()=>/Tier\s*A1\s*Price/i.test(document.body?.innerText||''),{timeout:60000}).catch(()=>{});
await page.waitForTimeout(2500);

let openedTitle='';
for(let i=0;i<90&&!openedTitle;i++){
  const found=await page.evaluate(()=>{
    const good=t=>/Quantity\s*Available/i.test(t)&&/Tier\s*A1\s*Price/i.test(t)&&/Tier\s*B1\s*Price/i.test(t)&&/Tier\s*C1\s*Price/i.test(t);
    for(const el of [...document.querySelectorAll('body *')]){
      const txt=(el.innerText||'').trim(); if(!txt||!good(txt)||txt.length>1800)continue;
      let node=el;
      for(let d=0;d<9&&node;d++,node=node.parentElement){
        const t=(node.innerText||'').trim(); if(!good(t)||t.length>3000)continue;
        const q=t.search(/Quantity\s*Available/i),prefix=q>=0?t.slice(0,q).trim():'';
        const title=prefix.split(/\n+/).map(x=>x.trim()).filter(Boolean)[0]||''; if(!title)continue;
        const key='diag-'+Math.random().toString(36).slice(2); node.setAttribute('data-diag-open',key); return {title,key};
      }
    }
    return null;
  });
  if(found){
    const card=page.locator(`[data-diag-open="${found.key}"]`).first();
    await card.scrollIntoViewIfNeeded().catch(()=>{});
    await card.click({timeout:1600}).catch(()=>{});
    await page.waitForTimeout(220);
    if(await page.locator('[role="button"][aria-label*=".mp4"]:visible').count()){openedTitle=found.title;break;}
    await page.keyboard.press('Escape').catch(()=>{}); await page.waitForTimeout(50);
  }
  await page.evaluate(()=>{
    const els=[...document.querySelectorAll('*')].filter(el=>{const s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+100}).sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,5);
    for(const el of els)el.scrollTop=Math.min(el.scrollTop+Math.max(500,el.clientHeight*.7),el.scrollHeight); window.scrollBy(0,800);
  });
  await page.waitForTimeout(120);
}
if(!openedTitle)throw new Error('No expanded record with .mp4 attachment control found');
console.log('FOUND_VIDEO_RECORD='+openedTitle);

const button=page.locator('[role="button"][aria-label*=".mp4"]:visible').first();
console.log('BUTTON_ARIA='+(await button.getAttribute('aria-label')));
console.log('BUTTON_BOX='+JSON.stringify(await button.boundingBox()));

const responses=[];
const requests=[];
const popups=[];
const downloads=[];
const onReq=r=>{try{const u=r.url();if(/mp4|mov|webm|video|download|attachment|usercontent|airtable/i.test(u))requests.push(safeUrl(u));}catch{}};
const onRes=r=>{try{const u=r.url(),ct=String(r.headers()['content-type']||'').toLowerCase();if(/video|octet-stream|mp4|mov|webm|download|attachment|usercontent/i.test(ct+' '+u))responses.push({status:r.status(),ct,url:safeUrl(u)});}catch{}};
page.on('request',onReq); page.on('response',onRes);
context.on('page',p=>{popups.push(p);});
page.on('download',d=>{downloads.push(d);});

await button.scrollIntoViewIfNeeded().catch(()=>{});
await button.click({force:true,timeout:2500});
await page.waitForTimeout(1800);

const state=await page.evaluate(()=>{
  const vis=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>10&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden'};
  const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(vis).map(el=>({tag:el.tagName,text:(el.innerText||'').trim().slice(0,100),aria:el.getAttribute('aria-label'),title:el.getAttribute('title'),href:el.getAttribute('href')?'URL':null})).filter(x=>x.text||x.aria||x.title||x.href).slice(-120);
  const videos=[...document.querySelectorAll('video')].filter(vis).map(v=>({src:(v.currentSrc||v.src||v.querySelector('source')?.src||'')?'URL':null,poster:v.poster?'URL':null}));
  const iframes=[...document.querySelectorAll('iframe')].filter(vis).map(f=>({src:f.src?'URL':null,title:f.title||''}));
  return {controls,videos,iframes,body:(document.body.innerText||'').slice(-2500)};
});
console.log('POST_CLICK='+JSON.stringify(state));
console.log('REQUESTS='+JSON.stringify(requests.slice(-60)));
console.log('RESPONSES='+JSON.stringify(responses.slice(-60)));
console.log('POPUPS='+popups.length);
console.log('DOWNLOADS='+downloads.length);

const downloadControl=page.locator('a:visible,button:visible,[role="button"]:visible').filter({hasText:/download/i}).first();
if(await downloadControl.count()){
  console.log('FOUND_DOWNLOAD_TEXT='+(await downloadControl.innerText().catch(()=>'')));
  await downloadControl.click({force:true,timeout:1500}).catch(()=>{});
  await page.waitForTimeout(1200);
  console.log('AFTER_DOWNLOAD_REQUESTS='+JSON.stringify(requests.slice(-60)));
  console.log('AFTER_DOWNLOAD_RESPONSES='+JSON.stringify(responses.slice(-60)));
}

page.off('request',onReq); page.off('response',onRes);
console.log('DIAGNOSTIC_VERSION=public-button-v2');
await browser.close();
