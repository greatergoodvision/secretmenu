import { chromium } from 'playwright';

const targets = [
  { name: 'menu', url: 'https://greatergoodvision.github.io/secretmenu/' },
  { name: 'landing', url: 'https://poundsdistrict.com/poundsparadise' },
];

const browser = await chromium.launch({ headless: true });
try {
  for (const t of targets) {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    let response;
    try {
      response = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      console.log(`TARGET=${t.name}`);
      console.log(`STATUS=${response?.status() ?? 'none'}`);
      console.log(`FINAL_URL=${page.url()}`);
      console.log(`TITLE=${await page.title()}`);
      const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500);
      console.log(`BODY=${body}`);
      const links = await page.locator('a[href]').evaluateAll(as => as.slice(0, 30).map(a => ({ text: (a.textContent || '').trim().replace(/\s+/g, ' '), href: a.href })));
      console.log(`LINKS=${JSON.stringify(links)}`);
      if (t.name === 'menu') {
        const hasMenu = body.includes('LIVE MENU') || body.includes('Live Menu');
        const hasCardsOrLoading = body.includes('products') || body.includes('Loading current catalog') || body.includes('Search inventory');
        console.log(`MENU_RENDER_OK=${hasMenu && hasCardsOrLoading}`);
      }
      if (t.name === 'landing') {
        const liveMenuLink = links.find(l => /LIVE MENU|ENTER LIVE MENU|OPEN LIVE MENU/i.test(l.text));
        console.log(`LANDING_CTA=${liveMenuLink ? JSON.stringify(liveMenuLink) : 'NONE'}`);
      }
    } catch (err) {
      console.log(`TARGET=${t.name}`);
      console.log(`ERROR=${err?.message || err}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
