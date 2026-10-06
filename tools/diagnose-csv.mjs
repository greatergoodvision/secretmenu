import { chromium } from 'playwright';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});
const page = await context.newPage();
const safe = raw => { try { const u=new URL(raw); return `${u.origin}${u.pathname}`; } catch { return String(raw).slice(0,220); } };

await page.goto(SOURCE_URL,{waitUntil:'domcontentloaded',timeout:45000});
await page.waitForFunction(()=>/Tier\s*A1\s*Price/i.test(document.body?.innerText||''),{timeout:60000}).catch(()=>{});
await page.waitForTimeout(2200);

let found=null;
for(let i=0;i<110&&!found;i++){
  const card=await page.evaluate(()=>{
    const good=t=>/Quantity\s*Available/i.test(t)&&/Tier\s*A1\s*Price/i.test(t)&&/Tier\s*B1\s*Price/i.test(t)&&/Tier\s*C1\s*Price/i.test(t);
    for(const el of [...document.querySelectorAll('body *')]){
      const txt=(el.innerText||'').trim(); if(!txt||!good(txt)||txt.length>1800)continue;
      let node=el;
      for(let d=0;d<9&&node;d++,node=node.parentElement){
        const t=(node.innerText||'').trim(); if(!good(t)||t.length>3000)continue;
        const q=t.search(/Quantity\s*Available/i),prefix=q>=0?t.slice(0,q).trim():'';
        const title=prefix.split(/\n+/).map(x=>x.trim()).filter(Boolean)[0]||''; if(!title)continue;
        const key='viewer-'+Math.random().toString(36).slice(2);node.setAttribute('data-viewer-card',key);return{title,key};
      }
    }
    return null;
  });
  if(card){
    const loc=page.locator(`[data-viewer-card="${card.key}"]`).first();
    await loc.scrollIntoViewIfNeeded().catch(()=>{});
    await loc.click({timeout:1600}).catch(()=>{});
    await page.waitForTimeout(260);
    const videoButton=page.locator('[role="button"][aria-label*=".mp4"]:visible,[role="button"][aria-label*=".mov"]:visible,[role="button"][aria-label*=".webm"]:visible').first();
    const videoThumb=page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').first();
    if(await videoButton.count()) found={title:card.title,kind:'button'};
    else if(await videoThumb.count()) found={title:card.title,kind:'thumb'};
    if(found)break;
    await page.keyboard.press('Escape').catch(()=>{});await page.waitForTimeout(70);
  }
  await page.evaluate(()=>{
    const els=[...document.querySelectorAll('*')].filter(el=>{const s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+100}).sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,5);
    for(const el of els)el.scrollTop=Math.min(el.scrollTop+Math.max(500,el.clientHeight*.7),el.scrollHeight);window.scrollBy(0,800);
  });
  await page.waitForTimeout(120);
}
if(!found)throw new Error('No public record with video attachment found');
console.log('FOUND='+found.title);

let button=page.locator('[role="button"][aria-label*=".mp4"]:visible,[role="button"][aria-label*=".mov"]:visible,[role="button"][aria-label*=".webm"]:visible').first();
if(!(await button.count())){
  const thumb=page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').first();
  button=thumb.locator('xpath=ancestor::*[@role="button"][1]');
}
console.log('ARIA='+(await button.getAttribute('aria-label').catch(()=>'')));
const before=page.url();
console.log('BEFORE='+safe(before));

const req=[];const res=[];const popups=[];
page.on('request',r=>{try{const u=r.url();if(/mp4|mov|webm|video|attachment|usercontent|download/i.test(u))req.push(safe(u));}catch{}});
page.on('response',r=>{try{const u=r.url(),ct=String(r.headers()['content-type']||'');if(/mp4|mov|webm|video|attachment|usercontent|octet-stream/i.test(u+' '+ct))res.push({s:r.status(),ct,u:safe(u)});}catch{}});
context.on('page',p=>popups.push(p));

await button.scrollIntoViewIfNeeded().catch(()=>{});
await button.focus().catch(()=>{});
await page.keyboard.press('Space').catch(()=>{});
await page.waitForTimeout(1000);
console.log('AFTER_SPACE='+safe(page.url()));

if(page.url()===before){
  const box=await button.boundingBox().catch(()=>null);
  if(box)await page.mouse.click(box.x+box.width/2,box.y+box.height/2).catch(()=>{});
  await page.waitForTimeout(700);
}
console.log('AFTER_MOUSE='+safe(page.url()));

if(page.url()===before){await button.focus().catch(()=>{});await page.keyboard.press('Enter').catch(()=>{});await page.waitForTimeout(700);}
console.log('AFTER_ENTER='+safe(page.url()));

const publicState=await page.evaluate(()=>{
  const vis=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>10&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden'};
  const videos=[...document.querySelectorAll('video')].filter(vis).map(v=>({src:v.currentSrc||v.src||v.querySelector('source')?.src||'',poster:v.poster||''}));
  const links=[...document.querySelectorAll('a[href]')].filter(vis).map(a=>({text:(a.innerText||'').trim().slice(0,80),href:a.href||''})).filter(x=>/download|mp4|mov|webm|attachment|usercontent/i.test(x.text+' '+x.href));
  const imgs=[...document.querySelectorAll('img')].filter(vis).map(i=>i.currentSrc||i.src||'').filter(x=>/airtableusercontent|attachment|video_dark/i.test(x));
  const controls=[...document.querySelectorAll('button,[role="button"]')].filter(vis).map(el=>({text:(el.innerText||'').trim().slice(0,80),aria:el.getAttribute('aria-label')||'',title:el.getAttribute('title')||''})).filter(x=>/download|attachment|video|close/i.test(x.text+' '+x.aria+' '+x.title));
  return {videos,links,imgs:imgs.slice(-12),controls:controls.slice(-30),dialogs:[...document.querySelectorAll('[role="dialog"]')].filter(vis).length};
});
function scrub(obj){
  if(Array.isArray(obj))return obj.map(scrub);
  if(obj&&typeof obj==='object'){const out={};for(const[k,v]of Object.entries(obj))out[k]=scrub(v);return out;}
  if(typeof obj==='string'&&/^https?:\/\//i.test(obj))return safe(obj);
  return obj;
}
console.log('STATE='+JSON.stringify(scrub(publicState)));
console.log('REQUESTS='+JSON.stringify([...new Set(req)].slice(-30)));
console.log('RESPONSES='+JSON.stringify(res.slice(-30)));
console.log('POPUPS='+popups.length);
if(popups[0])console.log('POPUP_URL='+safe(popups[0].url()));

await browser.close();
