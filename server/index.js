// Jackaroo server: Express for static files, ws for live game traffic,
// JSON files on disk for persistence (games survive restarts).

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { storageFromEnv } from './storage.js';
import * as E from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'games');
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS ?? 900);

const storage = storageFromEnv(process.env, DATA_DIR);
const games = new Map(); // code -> { state, tokens: {token -> playerId}, sockets: Set }

async function loadGame(code) {
  if (games.has(code)) return games.get(code);
  const rec = await storage.load(code);
  if (!rec) return null;
  if (games.has(code)) return games.get(code); // loaded concurrently
  const g = { state: rec.state, tokens: rec.tokens || {}, sockets: new Set(), botTimer: null };
  for (const p of g.state.players) if (!p.isBot) p.connected = false;
  games.set(code, g);
  return g;
}

function save(g) {
  g.state.updatedAt = Date.now();
  // write-behind: the in-memory copy is authoritative, the store is for restarts
  g.saving = (g.saving || Promise.resolve())
    .then(() => storage.save(g.state.code, { state: g.state, tokens: g.tokens }))
    .catch((e) => console.error('save failed', g.state.code, e.message));
}

async function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += alphabet[randomInt(0, alphabet.length)];
    if (!games.has(c) && !(await storage.exists(c))) return c;
  }
}

// ---------- broadcasting ----------

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(g) {
  const pub = E.publicState(g.state);
  for (const ws of g.sockets) {
    const you = ws.playerId ? g.state.players.find((p) => p.id === ws.playerId) : null;
    const priv = you && g.state.phase !== 'lobby' ? E.privateView(g.state, you.seat) : null;
    sendTo(ws, { type: 'state', state: pub, you: you ? { playerId: you.id, seat: you.seat, ...(priv || {}) } : null });
  }
  scheduleBot(g);
}

function scheduleBot(g) {
  const st = g.state;
  if (st.phase !== 'playing') return;
  const cur = st.players.find((p) => p.seat === st.turn);
  if (!cur || !cur.isBot || g.botTimer) return;
  g.botTimer = setTimeout(() => {
    g.botTimer = null;
    try {
      if (g.state.phase !== 'playing') return;
      const now = g.state.players.find((p) => p.seat === g.state.turn);
      if (!now || !now.isBot) return;
      const id = E.chooseBotMove(g.state, now.seat);
      if (id == null) return;
      E.applyMove(g.state, now.seat, id);
      save(g);
      broadcast(g);
    } catch (e) {
      console.error('bot error', e);
    }
  }, BOT_DELAY_MS);
}

// ---------- message handling ----------

function requireHost(g, ws) {
  if (g.state.hostId !== ws.playerId) throw new Error('Only the host can do that');
}

function attach(g, ws, player, token) {
  ws.game = g;
  ws.playerId = player.id;
  player.connected = true;
  g.sockets.add(ws);
  sendTo(ws, { type: 'joined', code: g.state.code, token, playerId: player.id });
}

const handlers = {
  async create(ws, msg) {
    const name = cleanName(msg.name);
    const code = await newCode();
    const playerId = 'p' + randomBytes(6).toString('hex');
    const token = randomBytes(18).toString('hex');
    const state = E.createGame({ code, hostId: playerId, settings: msg.settings });
    const g = { state, tokens: { [token]: playerId }, sockets: new Set(), botTimer: null };
    games.set(code, g);
    const p = E.addPlayer(state, { id: playerId, name });
    attach(g, ws, p, token);
    save(g);
    broadcast(g);
  },

  async join(ws, msg) {
    const code = String(msg.code || '').trim().toUpperCase();
    const g = await loadGame(code);
    if (!g) throw new Error('No game with that code');
    const st = g.state;
    // 1) rejoin by token
    if (msg.token && g.tokens[msg.token]) {
      const p = st.players.find((x) => x.id === g.tokens[msg.token]);
      if (p) { attach(g, ws, p, msg.token); save(g); broadcast(g); return; }
    }
    const name = cleanName(msg.name);
    // 2) reclaim a disconnected seat by name (friends on the same table, after a refresh / new device)
    const sameName = st.players.find((p) => !p.isBot && !p.connected && p.name.toLowerCase() === name.toLowerCase());
    if (sameName) {
      const token = randomBytes(18).toString('hex');
      g.tokens[token] = sameName.id;
      attach(g, ws, sameName, token);
      save(g); broadcast(g); return;
    }
    if (st.phase !== 'lobby') throw new Error('That game already started. Use the same name you joined with to take your seat back.');
    if (st.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error('That name is already taken in this game');
    const playerId = 'p' + randomBytes(6).toString('hex');
    const token = randomBytes(18).toString('hex');
    const p = E.addPlayer(st, { id: playerId, name });
    g.tokens[token] = playerId;
    attach(g, ws, p, token);
    save(g); broadcast(g);
  },

  async spectate(ws, msg) {
    const g = await loadGame(String(msg.code || '').trim().toUpperCase());
    if (!g) throw new Error('No game with that code');
    ws.game = g; ws.playerId = null; g.sockets.add(ws);
    broadcast(g);
  },

  settings(ws, msg) {
    const g = ws.game; requireHost(g, ws);
    if (g.state.phase !== 'lobby') throw new Error('Settings are locked after start');
    const next = E.normalizeSettings({ ...g.state.settings, ...msg.settings });
    if (g.state.players.length > next.players) throw new Error('Remove players first');
    g.state.settings = next;
    // keep seats inside the new range
    g.state.players.forEach((p, i) => { if (p.seat >= next.players) p.seat = i; });
    save(g); broadcast(g);
  },

  addBot(ws) {
    const g = ws.game; requireHost(g, ws);
    const names = ['Bot Salem', 'Bot Noura', 'Bot Faris', 'Bot Dana', 'Bot Omar', 'Bot Layla', 'Bot Ziad'];
    const used = new Set(g.state.players.map((p) => p.name));
    const name = names.find((n) => !used.has(n)) || `Bot ${g.state.players.length + 1}`;
    E.addPlayer(g.state, { id: 'bot' + randomBytes(4).toString('hex'), name, isBot: true });
    save(g); broadcast(g);
  },

  kick(ws, msg) {
    const g = ws.game; requireHost(g, ws);
    if (msg.playerId === g.state.hostId) throw new Error('Host cannot leave');
    E.removePlayer(g.state, msg.playerId);
    for (const s of g.sockets) if (s.playerId === msg.playerId) { s.playerId = null; sendTo(s, { type: 'kicked' }); }
    save(g); broadcast(g);
  },

  seat(ws, msg) {
    const g = ws.game;
    const target = msg.playerId && msg.playerId !== ws.playerId ? (requireHost(g, ws), msg.playerId) : ws.playerId;
    E.setSeat(g.state, target, Number(msg.seat));
    save(g); broadcast(g);
  },

  shuffleSeats(ws) {
    const g = ws.game; requireHost(g, ws);
    E.randomizeSeats(g.state);
    save(g); broadcast(g);
  },

  start(ws) {
    const g = ws.game; requireHost(g, ws);
    E.startGame(g.state);
    save(g); broadcast(g);
  },

  move(ws, msg) {
    const g = ws.game;
    const p = g.state.players.find((x) => x.id === ws.playerId);
    if (!p) throw new Error('You are not seated in this game');
    if (g.state.turn !== p.seat) throw new Error('Not your turn');
    E.applyMove(g.state, p.seat, Number(msg.moveId));
    save(g); broadcast(g);
  },

  rematch(ws) {
    const g = ws.game; requireHost(g, ws);
    if (g.state.phase !== 'finished') throw new Error('Game is still running');
    const st = g.state;
    const keep = { players: st.players.map((p) => ({ ...p })), settings: st.settings, hostId: st.hostId, chat: st.chat, deckHistory: st.deckHistory };
    const fresh = E.createGame({ code: st.code, hostId: keep.hostId, settings: keep.settings });
    fresh.players = keep.players;
    fresh.chat = keep.chat;
    fresh.deckHistory = keep.deckHistory;
    g.state = fresh;
    E.startGame(g.state);
    save(g); broadcast(g);
  },

  chat(ws, msg) {
    const g = ws.game;
    const p = g.state.players.find((x) => x.id === ws.playerId);
    if (!p) throw new Error('Spectators cannot chat');
    const text = String(msg.text || '').slice(0, 200).trim();
    if (!text) return;
    g.state.chat.push({ t: Date.now(), name: p.name, seat: p.seat, text });
    if (g.state.chat.length > 100) g.state.chat.shift();
    save(g); broadcast(g);
  },

  leave(ws) {
    const g = ws.game;
    if (!g) return;
    if (g.state.phase === 'lobby' && ws.playerId && ws.playerId !== g.state.hostId) {
      E.removePlayer(g.state, ws.playerId);
      for (const [t, id] of Object.entries(g.tokens)) if (id === ws.playerId) delete g.tokens[t];
    }
    detach(ws);
    save(g); broadcast(g);
  },
};

function cleanName(n) {
  const name = String(n || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (name.length < 1) throw new Error('Enter a name');
  return name;
}

function detach(ws) {
  const g = ws.game;
  if (!g) return;
  g.sockets.delete(ws);
  if (ws.playerId) {
    const stillConnected = [...g.sockets].some((s) => s.playerId === ws.playerId);
    const p = g.state.players.find((x) => x.id === ws.playerId);
    if (p && !stillConnected) p.connected = false;
  }
  ws.game = null; ws.playerId = null;
}

// ---------- http + ws ----------

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.json({ ok: true, games: games.size }));
app.get('/api/games/:code/fairness', async (req, res) => {
  const g = await loadGame(String(req.params.code).toUpperCase()).catch(() => null);
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json({ current: g.state.deckCommit, revealed: g.state.deckHistory });
});
app.get('/g/:code', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return sendTo(ws, { type: 'error', message: 'Bad JSON' }); }
    const h = handlers[msg.type];
    if (!h) return sendTo(ws, { type: 'error', message: `Unknown message ${msg.type}` });
    try {
      if (!['create', 'join', 'spectate'].includes(msg.type) && !ws.game) throw new Error('Join a game first');
      await h(ws, msg);
    } catch (e) {
      sendTo(ws, { type: 'error', message: e.message });
    }
  });
  ws.on('close', () => {
    const g = ws.game;
    detach(ws);
    if (g) { save(g); broadcast(g); }
  });
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
