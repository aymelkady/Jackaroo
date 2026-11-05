// Peer-to-peer mode: no server. The browser that creates a table runs the real GameHost (the same
// code the Node server uses) and other players connect to it over WebRTC data channels, using the
// public PeerJS signalling service to find each other. The host's browser keeps the saved game in
// localStorage and re-hosts it when that page is reopened.
import { GameHost, makeCode } from './shared/host.js';

const PEER_PREFIX = 'jackaroo-';
const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    // free public TURN relay so phones on different mobile networks can still connect
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};
const peerOpts = () => ({ debug: 0, config: ICE, ...(window.JK_PEER_OPTS || {}) });
const HOST_KEY = (code) => 'jk.p2p.host.' + code;

class LocalStorageStorage {
  key(code) { return 'jk.p2p.game.' + code; }
  async exists(code) { return localStorage.getItem(this.key(code)) != null; }
  async load(code) { try { return JSON.parse(localStorage.getItem(this.key(code))); } catch { return null; } }
  async save(code, rec) { localStorage.setItem(this.key(code), JSON.stringify(rec)); }
}

export function hostedTables() {
  return Object.keys(localStorage).filter((k) => k.startsWith('jk.p2p.host.')).map((k) => k.slice('jk.p2p.host.'.length));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class P2PTransport {
  /** @param {{onMessage(msg):void, onStatus(state:'on'|'off'|'wait', text?:string):void, onOpen():void}} h */
  constructor(h) {
    this.h = h;
    this.mode = null; // 'host' | 'client'
    this.code = null;
    this.queue = [];
    this.gen = 0; // bumps on teardown so stale callbacks are ignored
  }

  get isHost() { return this.mode === 'host'; }

  send(msg) {
    if (msg.type === 'create') { this.teardown(); return this.startHost(makeCode(), msg); }
    if (msg.type === 'join' || msg.type === 'spectate') {
      const code = String(msg.code || '').trim().toUpperCase();
      if (this.mode && this.code === code) return this.route(msg);
      this.teardown();
      if (localStorage.getItem(HOST_KEY(code))) return this.startHost(code, msg);
      return this.startClient(code, msg);
    }
    if (msg.type === 'leave') { this.route(msg); if (this.mode === 'client') this.teardown(); return; }
    this.route(msg);
  }

  route(msg) {
    if (this.mode === 'host') { this.host.handle(this.localConn, msg); return; }
    if (this.dc && this.dc.open) this.dc.send(msg);
    else this.queue.push(msg);
  }

  teardown() {
    this.gen++;
    try { if (this.dc) this.dc.close(); } catch { /* ignore */ }
    try { if (this.peer) this.peer.destroy(); } catch { /* ignore */ }
    this.dc = null; this.peer = null; this.host = null; this.localConn = null;
    this.mode = null; this.code = null; this.queue = [];
  }

  // ---------- host side ----------
  async startHost(code, firstMsg) {
    const gen = ++this.gen;
    this.mode = 'host'; this.code = code;
    this.host = new GameHost({ storage: new LocalStorageStorage(), allowClientCode: true, onError: (m, e) => console.warn(m, e) });
    this.localConn = { send: (m) => this.h.onMessage(m), game: null, playerId: null };
    this.h.onStatus('wait', 'Opening table…');
    let peer = null;
    for (let attempt = 0; attempt < 8 && gen === this.gen; attempt++) {
      try { peer = await this.openPeer(PEER_PREFIX + code); break; }
      catch (e) {
        if (e && e.type === 'unavailable-id') { this.h.onStatus('wait', 'Table id busy, retrying…'); await sleep(2500); continue; }
        this.h.onStatus('off', 'Signalling server unreachable, retrying…'); await sleep(3000);
      }
    }
    if (gen !== this.gen) return;
    if (!peer) {
      // another tab/device is already hosting this table: join it as a client instead
      localStorage.removeItem(HOST_KEY(code));
      this.mode = null; this.host = null;
      return this.startClient(code, firstMsg);
    }
    localStorage.setItem(HOST_KEY(code), '1');
    this.peer = peer;
    peer.on('connection', (dc) => {
      const conn = { send: (m) => { if (dc.open) dc.send(m); }, game: null, playerId: null, dc };
      dc.on('data', (m) => { if (m && typeof m === 'object') this.host.handle(conn, m); });
      dc.on('close', () => this.host.disconnect(conn));
      dc.on('error', () => this.host.disconnect(conn));
    });
    peer.on('disconnected', () => { if (gen === this.gen) { this.h.onStatus('wait', 'Reconnecting to signalling…'); try { peer.reconnect(); } catch { /* ignore */ } } });
    peer.on('error', (e) => { if (gen === this.gen && e.type !== 'peer-unavailable') console.warn('peer error', e.type); });
    this.h.onStatus('on', 'You are hosting this table. Keep this page open.');
    this.host.handle(this.localConn, { ...firstMsg, code });
    this.h.onOpen();
  }

  openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(id, peerOpts());
      const onErr = (e) => { peer.destroy(); reject(e); };
      peer.once('open', () => { peer.off('error', onErr); resolve(peer); });
      peer.once('error', onErr);
    });
  }

  // ---------- client side ----------
  startClient(code, firstMsg) {
    const gen = ++this.gen;
    this.mode = 'client'; this.code = code;
    this.queue = [firstMsg];
    this.h.onStatus('wait', 'Looking for the table…');
    let delay = 1500;
    const peer = new Peer(undefined, peerOpts());
    this.peer = peer;
    const connect = () => {
      if (gen !== this.gen) return;
      const dc = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
      this.dc = dc;
      dc.on('open', () => {
        if (gen !== this.gen) return;
        delay = 1500;
        this.h.onStatus('on');
        const q = this.queue; this.queue = [];
        if (q.length) for (const m of q) dc.send(m);
        else this.h.onOpen();
      });
      dc.on('data', (m) => { if (gen === this.gen && m && typeof m === 'object') this.h.onMessage(m); });
      dc.on('close', () => {
        if (gen !== this.gen) return;
        this.h.onStatus('off', 'Lost the host. Waiting for it to come back…');
        setTimeout(connect, delay); delay = Math.min(delay * 1.6, 8000);
      });
    };
    peer.on('open', connect);
    peer.on('error', (e) => {
      if (gen !== this.gen) return;
      if (e.type === 'peer-unavailable') { this.h.onStatus('off', 'The host is not online. Waiting…'); setTimeout(connect, 3000); }
      else if (e.type === 'disconnected' || e.type === 'network') { this.h.onStatus('off', 'Signalling lost, reconnecting…'); setTimeout(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 2000); }
      else console.warn('peer error', e.type);
    });
    peer.on('disconnected', () => { if (gen === this.gen) setTimeout(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 1500); });
  }
}
