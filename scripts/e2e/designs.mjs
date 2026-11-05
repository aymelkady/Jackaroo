const { chromium } = await import(process.env.PLAYWRIGHT_MJS || 'playwright');
import fs from 'node:fs';
const OUT = process.env.OUT_DIR || '/tmp/jackaroo-shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errs = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/vibrate|fonts.googleapis/.test(m.text())) errs.push(m.text()); });
await page.goto('http://localhost:3000');
await page.fill('#name', 'Ayman');
await page.click('#btnCreate');
await page.waitForSelector('#screenLobby:not(.hidden)');
for (let i = 0; i < 3; i++) { await page.click('#btnAddBot'); await page.waitForTimeout(80); }
await page.waitForFunction(() => !document.querySelector('#btnStart').disabled);
await page.click('#btnStart');
await page.waitForSelector('#screenGame:not(.hidden)');
const code = new URL(page.url()).searchParams.get('g');
// let bots play ~8 s so marbles are out
await page.waitForTimeout(8000);
for (const id of ['andalus', 'andalus8', 'ebony', 'oaksq', 'oak']) {
  await page.evaluate((d) => localStorage.setItem('jk.design', d), id);
  await page.evaluate(() => document.querySelector('#btnDesign').click());
  await page.waitForTimeout(150);
  await page.click(`#designGrid button[data-id="${id}"]`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/40-${id}.png` });
}
await page.evaluate(() => document.querySelector('#btnDesign').click());
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/41-picker.png` });
await page.keyboard.press('Escape');
// phone view: same player on a phone, pick a card to show targets; tap a lit hole
await ctx.close();
await new Promise((r) => setTimeout(r, 400));
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await m.newPage();
mp.on('pageerror', (e) => errs.push('mobile ' + e.message));
await mp.goto(`http://localhost:3000/?g=${code}`);
await mp.fill('#name', 'Ayman');
await mp.click('#btnJoin');
await mp.waitForSelector('#screenGame:not(.hidden)');
await mp.evaluate(() => localStorage.setItem('jk.design', 'andalus'));
await mp.waitForSelector('.turn-banner.mine', { timeout: 20000 });
let tapped = false;
for (let tries = 0; tries < 6 && !tapped; tries++) {
  const cards = mp.locator('#hand .pcard:not(.dead)');
  const c = await cards.count();
  if (!c) break;
  await cards.nth(tries % c).click();
  await mp.waitForTimeout(200);
  const targets = mp.locator('circle.target');
  if (await targets.count()) {
    await mp.screenshot({ path: `${OUT}/42-mobile-targets.png` });
    await targets.first().click({ force: true }); // tap the lit hole
    await mp.waitForTimeout(600);
    tapped = !(await mp.locator('.turn-banner.mine').count()) || !(await mp.locator('#btnCancel').count());
  } else { await mp.evaluate(() => document.querySelector('#btnCancel')?.click()); }
}
console.log('tap-a-hole move worked:', tapped);
await mp.screenshot({ path: `${OUT}/43-mobile.png` });
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
