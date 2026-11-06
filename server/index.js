// Jackaroo server: Express for static files, ws for live game traffic.
// All game logic lives in shared/host.js (GameHost); this file only wires sockets to it.

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { storageFromEnv } from './storage.js';
import { GameHost } from '../shared/host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data', 'games');
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS ?? 900);

const storage = storageFromEnv(process.env, DATA_DIR);
const host = new GameHost({ storage, botDelay: BOT_DELAY_MS });

const app = express();
app.disable('x-powered-by');
// tells the client it is talking to a real server (the static build for GitHub Pages says 'p2p')
// Build id: Render sets RENDER_GIT_COMMIT; elsewhere the start time stands in. A page that stays open across a
// deploy compares it with /version and offers a one-tap update (see checkVersion in public/app.js).
const VERSION = process.env.RENDER_GIT_COMMIT || `start-${Date.now()}`;
app.get('/config.js', (req, res) => { res.set('Cache-Control', 'no-store').type('application/javascript').send(`window.JK_MODE = 'server';\nwindow.JK_VERSION = ${JSON.stringify(VERSION)};\n`); });
app.get('/version', (req, res) => res.set('Cache-Control', 'no-store').json({ v: VERSION }));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.json({ ok: true, games: host.size }));
app.get('/api/games/:code/fairness', async (req, res) => {
  const g = await host.loadGame(String(req.params.code).toUpperCase()).catch(() => null);
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json({ current: g.state.deckCommit, revealed: g.state.deckHistory });
});
app.get('/g/:code', (req, res) => res.redirect(`/?g=${encodeURIComponent(String(req.params.code).toUpperCase())}`));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const conn = { send: (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }, game: null, playerId: null };
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return conn.send({ type: 'error', message: 'Bad JSON' }); }
    host.handle(conn, msg);
  });
  ws.on('close', () => host.disconnect(conn));
});

const ping = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(ping));

server.listen(PORT, () => console.log(`Jackaroo listening on http://localhost:${PORT} (storage: ${storage.describe()})`));
