// GameHost: everything a Jackaroo table needs apart from the transport.
// Runs unchanged inside the Node server (connections are WebSockets) and inside a browser that
// hosts a peer-to-peer table (connections are WebRTC data channels). A "conn" is any object with
// a send(msg) method; the host stores its own bookkeeping on it (conn.game, conn.playerId).

import * as E from './engine.js';
import { randomHex, randomInt } from './rng.js';

export const REACTIONS = ['👏', '😂', '🔥', '😡', '🙏', '🎉', '😱', '🤝'];
const BOT_NAMES = ['Bot Salem', 'Bot Noura', 'Bot Faris', 'Bot Dana', 'Bot Omar', 'Bot Layla', 'Bot Ziad'];

export function cleanName(n) {
  const name = String(n || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (name.length < 1) throw new Error('Enter a name');
  return name;
}

export function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += alphabet[randomInt(0, alphabet.length)];
  return c;
}

export class GameHost {
  /**
   * @param {object} opts
   * @param {{load(code):Promise<any>, save(code, rec):Promise<void>, exists(code):Promise<boolean>}} opts.storage
   * @param {number} [opts.botDelay]  ms a bot "thinks"
   * @param {boolean} [opts.allowClientCode]  let `create` carry its own game code (peer-to-peer mode)
   * @param {(msg:string, err?:Error)=>void} [opts.onError]
   */
  constructor({ storage, botDelay = 900, allowClientCode = false, onError = (m, e) => console.error(m, e) } = {}) {
    this.storage = storage;
    this.botDelay = botDelay;
    this.allowClientCode = allowClientCode;
    this.onError = onError;
    this.games = new Map(); // code -> { state, tokens, conns:Set, botTimer, saving }
  }

  get size() { return this.games.size; }

  async loadGame(code) {
    if (this.games.has(code)) return this.games.get(code);
    const rec = await this.storage.load(code);
    if (!rec) return null;
    if (this.games.has(code)) return this.games.get(code);
    const g = { state: rec.state, tokens: rec.tokens || {}, conns: new Set(), botTimer: null };
    for (const p of g.state.players) if (!p.isBot) p.connected = false;
    this.games.set(code, g);
    return g;
  }

  save(g) {
    g.state.updatedAt = Date.now();
    g.saving = (g.saving || Promise.resolve())
      .then(() => this.storage.save(g.state.code, { state: g.state, tokens: g.tokens }))
      .catch((e) => this.onError(`save failed ${g.state.code}`, e));
  }

  async newCode() {
    for (;;) {
      const c = makeCode();
      if (!this.games.has(c) && !(await this.storage.exists(c))) return c;
    }
  }

  send(conn, msg) {
    try { conn.send(msg); } catch (e) { this.onError('send failed', e); }
  }

  broadcast(g) {
    const pub = E.publicState(g.state);
    for (const conn of g.conns) {
      const you = conn.playerId ? g.state.players.find((p) => p.id === conn.playerId) : null;
      const priv = you && g.state.phase !== 'lobby' ? E.privateView(g.state, you.seat) : null;
      this.send(conn, { type: 'state', state: pub, you: you ? { playerId: you.id, seat: you.seat, ...(priv || {}) } : null });
    }
    this.scheduleBot(g);
  }

  scheduleBot(g) {
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
        this.save(g);
        this.broadcast(g);
      } catch (e) {
        this.onError('bot error', e);
      }
    }, this.botDelay);
  }

  requireHost(g, conn) {
    if (g.state.hostId !== conn.playerId) throw new Error('Only the host can do that');
  }

  attach(g, conn, player, token) {
    conn.game = g;
    conn.playerId = player.id;
    player.connected = true;
    g.conns.add(conn);
    this.send(conn, { type: 'joined', code: g.state.code, token, playerId: player.id });
  }

  detach(conn) {
    const g = conn.game;
    if (!g) return;
    g.conns.delete(conn);
    if (conn.playerId) {
      const stillConnected = [...g.conns].some((s) => s.playerId === conn.playerId);
      const p = g.state.players.find((x) => x.id === conn.playerId);
      if (p && !stillConnected) p.connected = false;
    }
    conn.game = null; conn.playerId = null;
  }

  /** Call when a transport connection closes. */
  disconnect(conn) {
    const g = conn.game;
    this.detach(conn);
    if (g) { this.save(g); this.broadcast(g); }
  }

  /** Handle one message from a connection. Errors are reported back to that connection. */
  async handle(conn, msg) {
    if (!msg || typeof msg !== 'object') return this.send(conn, { type: 'error', message: 'Bad message' });
    const h = this.handlers[msg.type];
    if (!h) return this.send(conn, { type: 'error', message: `Unknown message ${msg.type}` });
    try {
      if (!['create', 'join', 'spectate'].includes(msg.type) && !conn.game) throw new Error('Join a game first');
      await h.call(this, conn, msg);
    } catch (e) {
      this.send(conn, { type: 'error', message: e.message });
    }
  }

  handlers = {
    async create(conn, msg) {
      const name = cleanName(msg.name);
      const wanted = this.allowClientCode && /^[A-Z0-9]{3,12}$/.test(String(msg.code || '')) ? String(msg.code) : null;
      const code = wanted && !this.games.has(wanted) && !(await this.storage.exists(wanted)) ? wanted : await this.newCode();
      const playerId = 'p' + randomHex(6);
      const token = randomHex(18);
      const state = E.createGame({ code, hostId: playerId, settings: msg.settings });
      const g = { state, tokens: { [token]: playerId }, conns: new Set(), botTimer: null };
      this.games.set(code, g);
      const p = E.addPlayer(state, { id: playerId, name });
      this.attach(g, conn, p, token);
      this.save(g);
      this.broadcast(g);
    },

    async join(conn, msg) {
      const code = String(msg.code || '').trim().toUpperCase();
      const g = await this.loadGame(code);
      if (!g) throw new Error('No game with that code');
      const st = g.state;
      if (msg.token && g.tokens[msg.token]) {
        const p = st.players.find((x) => x.id === g.tokens[msg.token]);
        if (p) { this.attach(g, conn, p, msg.token); this.save(g); this.broadcast(g); return; }
      }
      const name = cleanName(msg.name);
      const sameName = st.players.find((p) => !p.isBot && !p.connected && p.name.toLowerCase() === name.toLowerCase());
      if (sameName) {
        const token = randomHex(18);
        g.tokens[token] = sameName.id;
        this.attach(g, conn, sameName, token);
        this.save(g); this.broadcast(g); return;
      }
      if (st.phase !== 'lobby') throw new Error('That game already started. Use the same name you joined with to take your seat back.');
      if (st.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error('That name is already taken in this game');
      const playerId = 'p' + randomHex(6);
      const token = randomHex(18);
      const p = E.addPlayer(st, { id: playerId, name });
      g.tokens[token] = playerId;
      this.attach(g, conn, p, token);
      this.save(g); this.broadcast(g);
    },

    async spectate(conn, msg) {
      const g = await this.loadGame(String(msg.code || '').trim().toUpperCase());
      if (!g) throw new Error('No game with that code');
      conn.game = g; conn.playerId = null; g.conns.add(conn);
      this.broadcast(g);
    },

    settings(conn, msg) {
      const g = conn.game; this.requireHost(g, conn);
      if (g.state.phase !== 'lobby') throw new Error('Settings are locked after start');
      const next = E.normalizeSettings({ ...g.state.settings, ...msg.settings });
      if (g.state.players.length > next.players) throw new Error('Remove players first');
      g.state.settings = next;
      g.state.players.forEach((p, i) => { if (p.seat >= next.players) p.seat = i; });
      this.save(g); this.broadcast(g);
    },

    addBot(conn) {
      const g = conn.game; this.requireHost(g, conn);
      const used = new Set(g.state.players.map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${g.state.players.length + 1}`;
      E.addPlayer(g.state, { id: 'bot' + randomHex(4), name, isBot: true });
      this.save(g); this.broadcast(g);
    },

    kick(conn, msg) {
      const g = conn.game; this.requireHost(g, conn);
      if (msg.playerId === g.state.hostId) throw new Error('Host cannot leave');
      E.removePlayer(g.state, msg.playerId);
      for (const s of g.conns) if (s.playerId === msg.playerId) { s.playerId = null; this.send(s, { type: 'kicked' }); }
      this.save(g); this.broadcast(g);
    },

    seat(conn, msg) {
      const g = conn.game;
      const target = msg.playerId && msg.playerId !== conn.playerId ? (this.requireHost(g, conn), msg.playerId) : conn.playerId;
      E.setSeat(g.state, target, Number(msg.seat));
      this.save(g); this.broadcast(g);
    },

    shuffleSeats(conn) {
      const g = conn.game; this.requireHost(g, conn);
      E.randomizeSeats(g.state);
      this.save(g); this.broadcast(g);
    },

    start(conn) {
      const g = conn.game; this.requireHost(g, conn);
      E.startGame(g.state);
      this.save(g); this.broadcast(g);
    },

    move(conn, msg) {
      const g = conn.game;
      const p = g.state.players.find((x) => x.id === conn.playerId);
      if (!p) throw new Error('You are not seated in this game');
      if (g.state.turn !== p.seat) throw new Error('Not your turn');
      E.applyMove(g.state, p.seat, Number(msg.moveId));
      this.save(g); this.broadcast(g);
    },

    rematch(conn) {
      const g = conn.game; this.requireHost(g, conn);
      if (g.state.phase !== 'finished') throw new Error('Game is still running');
      const st = g.state;
      const fresh = E.createGame({ code: st.code, hostId: st.hostId, settings: st.settings });
      fresh.players = st.players.map((p) => ({ ...p }));
      fresh.chat = st.chat;
      fresh.deckHistory = st.deckHistory;
      g.state = fresh;
      E.startGame(g.state);
      this.save(g); this.broadcast(g);
    },

    chat(conn, msg) {
      const g = conn.game;
      const p = g.state.players.find((x) => x.id === conn.playerId);
      if (!p) throw new Error('Spectators cannot chat');
      const text = String(msg.text || '').slice(0, 200).trim();
      if (!text) return;
      g.state.chat.push({ t: Date.now(), name: p.name, seat: p.seat, text });
      if (g.state.chat.length > 100) g.state.chat.shift();
      this.save(g); this.broadcast(g);
    },

    react(conn, msg) {
      const g = conn.game;
      const p = g.state.players.find((x) => x.id === conn.playerId);
      if (!p) throw new Error('Spectators cannot react');
      if (!REACTIONS.includes(msg.emoji)) return;
      const now = Date.now();
      if (p.lastReact && now - p.lastReact < 1500) return;
      p.lastReact = now;
      for (const s of g.conns) this.send(s, { type: 'react', seat: p.seat, emoji: msg.emoji, name: p.name });
    },

    leave(conn) {
      const g = conn.game;
      if (!g) return;
      if (g.state.phase === 'lobby' && conn.playerId && conn.playerId !== g.state.hostId) {
        E.removePlayer(g.state, conn.playerId);
        for (const [t, id] of Object.entries(g.tokens)) if (id === conn.playerId) delete g.tokens[t];
      }
      this.detach(conn);
      this.save(g); this.broadcast(g);
    },
  };
}
