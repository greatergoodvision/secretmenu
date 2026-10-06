import { chromium } from 'playwright';

const SOURCE_URL = process.env.AIRTABLE_SOURCE_URL;
if (!SOURCE_URL) throw new Error('Missing AIRTABLE_SOURCE_URL');

const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1200},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});

function safeUrl(raw=''){
  try{const u=new URL(raw);return `${u.origin}${u.pathname}`;}catch{return raw.slice(0,180)}
}

await page.goto(SOURCE_URL,{waitUntil:'domcontentloaded',timeout:45000});
await page.waitForFunction(()=>/Tier\s*A1\s*Price/i.test(document.body?.innerText||''),{timeout:60000}).catch(()=>{});
await page.waitForTimeout(3000);

let openedTitle='';
for(let i=0;i<90&&!openedTitle;i++){
  const found=await page.evaluate(()=>{
    const hasAll=t=>/Quantity\s*Available/i.test(t)&&/Tier\s*A1\s*Price/i.test(t)&&/Tier\s*B1\s*Price/i.test(t)&&/Tier\s*C1\s*Price/i.test(t);
    for(const el of [...document.querySelectorAll('body *')]){
      const txt=(el.innerText||'').trim();
      if(!txt||!hasAll(txt)||txt.length>1800)continue;
      let node=el;
      for(let d=0;d<9&&node;d++,node=node.parentElement){
        const t=(node.innerText||'').trim();if(!hasAll(t)||t.length>3000)continue;
        const q=t.search(/Quantity\s*Available/i),prefix=q>=0?t.slice(0,q).trim():'';
        const title=prefix.split(/\n+/).map(x=>x.trim()).filter(Boolean)[0]||'';
        if(!title)continue;
        const key='diag-'+Math.random().toString(36).slice(2);node.setAttribute('data-diag-open',key);return {title,key};
      }
    }
    return null;
  });
  if(found){
    const card=page.locator(`[data-diag-open="${found.key}"]`).first();
    await card.scrollIntoViewIfNeeded().catch(()=>{});
    await card.click({timeout:1600}).catch(()=>{});
    await page.waitForTimeout(250);
    const hasVideo=await page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').count();
    if(hasVideo){openedTitle=found.title;break;}
    await page.keyboard.press('Escape').catch(()=>{});await page.waitForTimeout(50);
  }
  await page.evaluate(()=>{
    const els=[...document.querySelectorAll('*')].filter(el=>{const s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+100}).sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,5);
    for(const el of els)el.scrollTop=Math.min(el.scrollTop+Math.max(500,el.clientHeight*.7),el.scrollHeight);window.scrollBy(0,800);
  });
  await page.waitForTimeout(120);
}

if(!openedTitle)throw new Error('Could not find an expanded record with a visible video attachment thumbnail');
console.log('FOUND_VIDEO_RECORD='+openedTitle.replace(/\s+/g,' ').slice(0,120));

const thumb=page.locator('img[src*="attachment_thumbnails/video_dark"]:visible').first();
const chain=await thumb.evaluate(img=>{
  const out=[];let n=img;
  for(let i=0;i<6&&n;i++,n=n.parentElement){
    out.push({tag:n.tagName,role:n.getAttribute('role'),aria:n.getAttribute('aria-label'),title:n.getAttribute('title'),href:n.getAttribute('href'),cls:String(n.className||'').slice(0,180),text:(n.innerText||'').trim().slice(0,120),attrs:[...n.attributes].map(a=>a.name).filter(x=>/src|href|url|data|aria|role|title/i.test(x)).slice(0,30)});
  }
  return out;
});
console.log('VIDEO_PARENT_CHAIN='+JSON.stringify(chain.map(x=>({...x,href:x.href?'URL':null}))));

const controls=await page.evaluate(()=>{
  const vis=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>10&&r.height>10&&s.display!=='none'&&s.visibility!=='hidden'};
  return [...document.querySelectorAll('button,a,[role="button"]')].filter(vis).map(el=>({tag:el.tagName,text:(el.innerText||'').trim().slice(0,100),aria:el.getAttribute('aria-label'),title:el.getAttribute('title'),href:el.getAttribute('href')?'URL':null})).filter(x=>x.text||x.aria||x.title||x.href).slice(-80);
});
console.log('VISIBLE_CONTROLS='+JSON.stringify(controls));

const responses=[];
const onResponse=r=>{
  try{
    const u=r.url(),ct=String(r.headers()['content-type']||'').toLowerCase();
    if(/video|octet-stream|mp4|mov|webm|attachment|download|usercontent|airtable/i.test(ct+' '+u))responses.push({status:r.status(),ct:ct.slice(0,100),url:safeUrl(u)});
  }catch{}
};
page.on('response',onResponse);

for(let up=0;up<5;up++){
  const target=up===0?thumb:thumb.locator('xpath='+'../'.repeat(up));
  console.log('TRY_PARENT_LEVEL='+up);
  await target.click({timeout:1200}).catch(()=>{});
  await page.waitForTimeout(700);
  const state=await page.evaluate(()=>({videos:[...document.querySelectorAll('video')].map(v=>({visible:!!(v.offsetWidth||v.offsetHeight),src:v.currentSrc||v.src||v.querySelector('source')?.src||'',poster:v.poster||''})).map(v=>({...v,src:v.src?'URL':null,poster:v.poster?'URL':null})),links:[...document.querySelectorAll('a[href]')].filter(a=>/download|video|mp4|mov|webm/i.test((a.innerText||'')+' '+a.href+' '+(a.getAttribute('aria-label')||''))).map(a=>({text:(a.innerText||'').trim().slice(0,80),aria:a.getAttribute('aria-label'),href:'URL'})).slice(-20)}));
  console.log('AFTER_CLICK_STATE='+JSON.stringify(state));
  if(responses.length)console.log('RESPONSES='+JSON.stringify(responses.slice(-40)));
  const visibleVideo=await page.locator('video:visible').count();
  if(visibleVideo)break;
}
page.off('response',onResponse);

console.log('FINAL_RESPONSE_COUNT='+responses.length);
await browser.close();
