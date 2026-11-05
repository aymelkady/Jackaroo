// End-to-end test of the serverless (peer-to-peer) mode:
// local PeerJS signalling server + plain static server serving dist/ (as GitHub Pages would),
// four browser contexts, host creates, three join, they play, host reloads (re-hosts), clients recover.
const { chromium } = await import(process.env.PLAYWRIGHT_MJS || 'playwright');
const { PeerServer } = await import(process.env.PEER_SERVER_MJS || 'peer');
import express from 'express';
import fs from 'node:fs';

const DIST = new URL('../../dist', import.meta.url).pathname;
const OUT = process.env.OUT_DIR || '/tmp/jackaroo-shots';
fs.mkdirSync(OUT, { recursive: true });
// point the page at the local signalling server (production uses the public PeerJS cloud)
fs.writeFileSync(`${DIST}/config.js`, "window.JK_MODE = 'p2p';\nwindow.JK_PEER_OPTS = { host: '127.0.0.1', port: 9100, path: '/peer', secure: false, config: { iceServers: [] } };\n");
const peerServer = PeerServer({ port: 9100, path: '/peer', host: '127.0.0.1' });
const app = express();
app.use('/Jackaroo', express.static(DIST)); // subpath, like username.github.io/Jackaroo/
const web = app.listen(8088, '127.0.0.1');
await new Promise((r) => setTimeout(r, 500));

const BASE = 'http://127.0.0.1:8088/Jackaroo/';
const browser = await chromium.launch();
const names = ['Ahmed', 'Sara', 'Omar', 'Lina'];
const ctxs = [], pages = [];
const errs = [];
for (const n of names) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`[${n}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/vibrate|fonts.googleapis/.test(m.text())) errs.push(`[${n}] ${m.text()}`); });
  await page.goto(BASE);
  ctxs.push(ctx); pages.push(page);
}
await pages[0].fill('#name', names[0]);
await pages[0].evaluate(() => { document.querySelector('.opts').open = true; }); await pages[0].uncheck('#optRandomTeams');
await pages[0].click('#btnCreate');
await pages[0].waitForSelector('#screenLobby:not(.hidden)', { timeout: 15000 });
const code = (await pages[0].textContent('#lobbyCode')).trim();
console.log('code', code, 'status:', await pages[0].textContent('#netStatus'));
for (let i = 1; i < 4; i++) {
  await pages[i].goto(`${BASE}?g=${code}`);
  await pages[i].fill('#name', names[i]);
  await pages[i].click('#btnJoin');
  await pages[i].waitForSelector('#screenLobby:not(.hidden)', { timeout: 20000 });
}
await pages[0].waitForFunction(() => [...document.querySelectorAll('#seatGrid .who')].every((e) => !e.textContent.includes('empty')), null, { timeout: 15000 });
await pages[0].screenshot({ path: `${OUT}/30-p2p-lobby.png` });
await pages[0].click('#btnStart');
for (const p of pages) await p.waitForSelector('#screenGame:not(.hidden)', { timeout: 15000 });

async function turnName() {
  return pages[1].evaluate(() => { const w = document.querySelector('#centerText').textContent; if (w.includes('wins')) return w; const t = document.querySelector('.seat-chip.turn'); return t ? t.dataset.name : ''; });
}
async function playOne(page) {
  await page.waitForSelector('.turn-banner.mine', { timeout: 8000 });
  const cards = page.locator('#hand .pcard:not(.dead)');
  const c = await cards.count();
  await cards.nth(Math.floor(Math.random() * c)).click();
  for (let s = 0; s < 6; s++) {
    await page.waitForTimeout(80);
    if (!(await page.locator('#btnCancel').count())) break;
    const opts = page.locator('#prompt button[data-v]');
    const picks = page.locator('g.marble.pick');
    if (await opts.count()) { await opts.nth(Math.floor(Math.random() * (await opts.count()))).click(); continue; }
    if (await picks.count()) { await picks.nth(Math.floor(Math.random() * (await picks.count()))).click({ force: true }); continue; }
    break;
  }
}
let turns = 0;
const t0 = Date.now();
while (turns < 40 && Date.now() - t0 < 90000) {
  const who = await turnName();
  const idx = names.indexOf(who);
  if (idx < 0) { await pages[1].waitForTimeout(100); continue; }
  await playOne(pages[idx]);
  await pages[1].waitForFunction((prev) => { const t = document.querySelector('.seat-chip.turn'); return (t ? t.dataset.name : '') !== prev; }, who, { timeout: 8000 }).catch(() => console.log('turn stuck after', who));
  turns++;
}
console.log('turns played over WebRTC:', turns);
await pages[2].screenshot({ path: `${OUT}/31-p2p-game.png` });

// host reloads: must re-host from localStorage, clients must recover
const logBefore = await pages[1].evaluate(() => document.querySelector('#log div').textContent);
await pages[0].reload();
await pages[0].waitForSelector('#screenGame:not(.hidden)', { timeout: 20000 });
console.log('host re-hosted after reload; status:', await pages[0].textContent('#netStatus'));
await pages[1].waitForFunction(() => document.querySelector('#connDot').classList.contains('on'), null, { timeout: 30000 });
await pages[1].waitForTimeout(500);
const logAfter = await pages[1].evaluate(() => document.querySelector('#log div').textContent);
console.log('client recovered; same game:', logBefore === logAfter, '| status:', await pages[1].textContent('#netStatus'));
// and keep playing a few turns after the recovery
let more = 0; const t1 = Date.now();
while (more < 6 && Date.now() - t1 < 40000) {
  const who = await turnName(); const idx = names.indexOf(who);
  if (idx < 0) { await pages[1].waitForTimeout(100); continue; }
  await playOne(pages[idx]);
  await pages[1].waitForFunction((prev) => { const t = document.querySelector('.seat-chip.turn'); return (t ? t.dataset.name : '') !== prev; }, who, { timeout: 8000 }).catch(() => console.log('turn stuck after', who));
  more++;
}
console.log('turns after host reload:', more);
console.log('errors:', errs.length ? errs : 'none');
await browser.close(); web.close(); process.exit(0);
