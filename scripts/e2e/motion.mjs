// Capture frames mid-animation: dealing, a bot's card flying to the pile, marble jumps.
const { chromium } = await import(process.env.PLAYWRIGHT_MJS || 'playwright');
import fs from 'node:fs';
const OUT = process.env.OUT_DIR || '/tmp/jackaroo-shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
const errs = [];
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
await page.waitForTimeout(1050);
await page.screenshot({ path: `${OUT}/70-dealing.png` });
// wait for a bot move and catch the flying card
await page.waitForFunction(() => document.querySelectorAll('#flyLayer .flycard').length > 0, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/71-flying-card.png` });
// play until a marble animation is running, catch mid-jump
let got = 0;
const t0 = Date.now();
while (Date.now() - t0 < 40000 && got < 2) {
  if (await page.locator('.turn-banner.mine').count()) {
    const cards = page.locator('#hand .pcard:not(.dead)');
    const c = await cards.count();
    if (c) await cards.nth(Math.floor(Math.random() * c)).click();
    for (let s = 0; s < 6; s++) {
      await page.waitForTimeout(60);
      if (!(await page.locator('#btnCancel').count())) break;
      const opts = page.locator('#prompt button[data-v]');
      const picks = page.locator('g.marble.pick');
      if (await opts.count()) { await opts.nth(Math.floor(Math.random() * (await opts.count()))).click(); continue; }
      if (await picks.count()) { await picks.nth(Math.floor(Math.random() * (await picks.count()))).click({ force: true }); continue; }
      break;
    }
  }
  const running = await page.evaluate(() => document.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('marble') && a.effect.getComputedTiming().duration > 400));
  if (running) { await page.waitForTimeout(180); await page.screenshot({ path: `${OUT}/72-jump-${got}.png` }); got++; }
  await page.waitForTimeout(80);
}
console.log('jump frames:', got, 'errors:', errs.length ? errs : 'none');
await browser.close();
