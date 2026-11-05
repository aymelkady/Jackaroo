const { chromium } = await import(process.env.PLAYWRIGHT_MJS || 'playwright');

const BASE = 'http://localhost:3000';
import fs from 'node:fs';
const OUT = process.env.OUT_DIR || '/tmp/jackaroo-shots';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const names = ['Ahmed', 'Sara', 'Omar', 'Lina'];
const pages = [];
for (const n of names) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${n}] PAGE ERROR`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${n}] console.error`, m.text()); });
  await page.goto(BASE);
  pages.push(page);
}
// host creates
await pages[0].fill('#name', names[0]);
await pages[0].evaluate(() => { document.querySelector('.opts').open = true; }); await pages[0].uncheck('#optRandomTeams');
await pages[0].click('#btnCreate');
await pages[0].waitForSelector('#screenLobby:not(.hidden)');
const code = (await pages[0].textContent('#lobbyCode')).trim();
console.log('code', code);
// others join
for (let i = 1; i < 4; i++) {
  await pages[i].fill('#name', names[i]);
  await pages[i].fill('#code', code);
  await pages[i].click('#btnJoin');
  await pages[i].waitForSelector('#screenLobby:not(.hidden)');
}
await pages[0].waitForFunction(() => document.querySelectorAll('#seatGrid .seat .who').length === 4 && [...document.querySelectorAll('#seatGrid .who')].every((e) => !e.textContent.includes('empty')));
// Sara picks seat 3 (swap) to be Ahmed's partner (seat 0 <-> seat 2 are partners) -> move Sara to seat 2
await pages[1].click('#seatGrid .seat:nth-child(3)');
await pages[0].waitForTimeout(300);
await pages[0].screenshot({ path: `${OUT}/01-lobby.png` });
await pages[0].click('#btnStart');
for (const p of pages) await p.waitForSelector('#screenGame:not(.hidden)');
await pages[0].waitForTimeout(600);
await pages[0].screenshot({ path: `${OUT}/02-game-start.png` });

// play up to N turns via the UI: whoever's turn, click a playable card, then follow prompts
async function whoseTurn() {
  return pages[0].evaluate(() => { const w = document.querySelector('#centerText').textContent; if (w.includes('wins')) return w; const t = document.querySelector('.seat-chip.turn'); return t ? t.dataset.name : ''; });
}
let turns = 0, finished = false;
const start = Date.now();
while (turns < 40 && !finished) {
  const txt = await whoseTurn();
  if (txt.includes('wins')) { finished = true; break; }
  const idx = names.findIndex((n) => txt.startsWith(n));
  if (idx < 0) { await pages[0].waitForTimeout(100); continue; }
  const page = pages[idx];
  await page.waitForSelector('.turn-banner.mine', { timeout: 5000 });
  // pick a playable card (prefer non-dead)
  const cards = page.locator('#hand .pcard:not(.dead)');
  const count = await cards.count();
  if (count === 0) { console.log('no cards?!'); break; }
  const k = Math.floor(Math.random() * count);
  await cards.nth(k).click();
  // follow prompts until turn passes (max 6 steps)
  for (let s = 0; s < 6; s++) {
    await page.waitForTimeout(80);
    const stillMine = await page.locator('.turn-banner.mine').count();
    const promptHasSel = await page.locator('#btnCancel').count();
    if (!stillMine || !promptHasSel) break;
    const opts = page.locator('#prompt button[data-v]');
    const picks = page.locator('g.marble.pick');
    if (await opts.count()) { const oc = await opts.count(); await opts.nth(Math.floor(Math.random() * oc)).click(); continue; }
    if (await picks.count()) { const pc = await picks.count(); await picks.nth(Math.floor(Math.random() * pc)).click({ force: true }); continue; }
    break;
  }
  // wait for turn to change
  await pages[0].waitForFunction((prev) => { const t = document.querySelector('.seat-chip.turn'); return (t ? t.dataset.name : '') !== prev; }, txt, { timeout: 5000 }).catch(() => console.log('turn did not advance after', txt));
  turns++;
  if (turns === 25) await pages[idx].screenshot({ path: `${OUT}/03-midgame-player.png` });
}
console.log('turns played', turns, 'finished', finished, 'elapsed', Date.now() - start, 'ms');
await pages[0].screenshot({ path: `${OUT}/04-late.png` });
const log = await pages[0].evaluate(() => [...document.querySelectorAll('#log div')].slice(0, 8).map((d) => d.textContent));
console.log(log.join('\n'));

// reconnection test: reload Sara, she should auto-rejoin by token
await pages[1].reload();
await pages[1].waitForSelector('#screenGame:not(.hidden)', { timeout: 5000 });
console.log('reload rejoin OK:', await pages[1].evaluate(() => document.querySelector('#turnBanner').textContent));
// new device, same name: fresh context, join by name while Sara's old socket is closed
await pages[1].context().close();
const ctx2 = await browser.newContext();
const p2 = await ctx2.newPage();
await p2.goto(`${BASE}/g/${code}`);
await p2.fill('#name', 'sara');
await p2.click('#btnJoin');
await p2.waitForSelector('#screenGame:not(.hidden)', { timeout: 5000 });
console.log('rejoin-by-name OK; players:', await p2.evaluate(() => [...document.querySelectorAll('.seat-chip')].map((e) => e.dataset.name)));
await browser.close();
