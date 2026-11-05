// Reviewer checks: jj at 4 and 8 players, saudi at 6, phone view with a card picked, no page errors.
const { chromium } = await import(process.env.PLAYWRIGHT_MJS || 'playwright');
import fs from 'node:fs';
const OUT = process.env.OUT_DIR || '/tmp/jackaroo-shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errs = [];
async function table(players, design, shot, { phone = false } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`${shot}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/vibrate|fonts.googleapis/.test(m.text())) errs.push(`${shot}: ${m.text()}`); });
  await page.goto('http://localhost:3000');
  await page.evaluate((d) => localStorage.setItem('jk.design', d), design);
  await page.fill('#name', 'Ayman');
  await page.selectOption('#players', String(players));
  await page.click('#btnCreate');
  await page.waitForSelector('#screenLobby:not(.hidden)');
  for (let i = 0; i < players - 1; i++) { await page.click('#btnAddBot'); await page.waitForTimeout(60); }
  await page.waitForFunction(() => !document.querySelector('#btnStart').disabled);
  await page.click('#btnStart');
  await page.waitForSelector('#screenGame:not(.hidden)');
  await page.waitForTimeout(phone ? 2500 : 5000);
  if (phone) {
    await page.waitForSelector('.turn-banner.mine', { timeout: 30000 }).catch(() => {});
    const c = page.locator('#hand .pcard:not(.dead)'); if (await c.count()) await c.first().click();
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${OUT}/${shot}.png` });
  // chip overlap check: no seat chip box should contain a track hole centre of its own arm
  const overlap = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.seat-chip')].map((c) => c.getBoundingClientRect());
    const holes = [...document.querySelectorAll('#board circle.hole')].map((h) => h.getBoundingClientRect());
    let n = 0;
    for (const c of chips) for (const h of holes) { const hx = h.left + h.width / 2, hy = h.top + h.height / 2; if (hx > c.left && hx < c.right && hy > c.top && hy < c.bottom) n++; }
    return n;
  });
  console.log(shot, 'chips covering holes:', overlap);
  await ctx.close();
}
await table(4, 'jj', '80-jj-4');
await table(8, 'jj', '81-jj-8');
await table(6, 'saudi', '82-saudi-6');
await table(4, 'jj', '83-jj-phone', { phone: true });
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
