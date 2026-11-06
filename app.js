/* Jackaroo client. Talks JSON over a WebSocket; the server owns all rules. */
import { armLayout, SPACING } from './shared/layout.js';

(() => {
  const $ = (id) => document.getElementById(id);
  const SEAT_COLORS = ['#d8372a', '#2a6fd8', '#2f9a4a', '#e6b43a', '#f07a1a', '#8e44ad', '#1aa6a0', '#efe6d0']; // red, blue, green, yellow, orange, purple, teal, ivory
  const TEAM_NAMES = ['A', 'B', 'C', 'D'];
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const HINT = {
    A: 'Exit a marble, or move 1 or 11', K: 'Exit a marble, or move 13 and kill on the way', Q: 'Move 12; red Queen may burn a card from the next player', J: 'Swap one of your marbles with another player\'s marble', J11: 'Move 11',
    10: 'Move 10, or make the next player burn a card and lose their turn', 9: 'Move 9', 8: 'Move 8', 7: 'Move 7, or split between two marbles', 6: 'Move 6', 5: 'Move any marble 5 (not one standing on its own base)', 4: 'Move 4 backwards', 3: 'Move 3', 2: 'Move 2', JOKER: 'Play as any card (as a Jack: swap or move 11)',
  };

  let code = null, token = null, playerId = null;
  let state = null, you = null;
  let sel = { cardId: null, picks: [] };
  let hoverMarble = null;
  let boardKey = '';      // geometry cache key
  let geo = null;
  let lastMoveAt = 0, wasMyTurn = false, lastDealNo = 0;
  let lastZones = null;   // marble id -> zone at the previous render (to tell which marbles a move sent home)
  let lastSoundAt = 0;    // when the last move sound started (the turn chime waits for it)
  const baseTitle = document.title;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = baseTitle; });
  let prevPos = new Map(); // marble id -> {owner, zone, pos} as last rendered
  let scrolledFor = null;
  let lastLogT = 0;
  function initials(name) { return String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?'; }
  function toast(text, kill) {
    const box = $('toasts'); if (!box) return;
    const t = document.createElement('div'); t.className = 'toast' + (kill ? ' kill' : ''); t.textContent = text;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.remove(), 4600);
  }

  // ---------- storage ----------
  const store = {
    get name() { return localStorage.getItem('jk.name') || ''; },
    set name(v) { localStorage.setItem('jk.name', v); },
    token(c) { return localStorage.getItem('jk.tok.' + c); },
    setToken(c, t) { localStorage.setItem('jk.tok.' + c, t); const r = this.recent.filter((x) => x !== c); r.unshift(c); localStorage.setItem('jk.recent', JSON.stringify(r.slice(0, 5))); },
    get recent() { try { return JSON.parse(localStorage.getItem('jk.recent') || '[]'); } catch { return []; } },
    get sound() { return localStorage.getItem('jk.sound') !== 'off'; },
    set sound(v) { localStorage.setItem('jk.sound', v ? 'on' : 'off'); },
  };

  // ---------- sound ----------
  let audio = null;
  function tone(freq, dur, type = 'sine', gain = 0.12, delay = 0) {
    if (!store.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, audio.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(gain, audio.currentTime + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + delay + dur);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + delay); o.stop(audio.currentTime + delay + dur + 0.05);
    } catch { /* no audio */ }
  }
  // vibration works even with the sound switched off (a phone on silent still buzzes); Android only, iOS ignores it
  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not supported */ } }
  // spoken alert: Arabic when the device language is Arabic, English otherwise
  function say(en, ar) {
    if (!store.sound || !('speechSynthesis' in window)) return;
    try {
      const arabic = /^ar\b/i.test(navigator.language || '');
      const u = new SpeechSynthesisUtterance(arabic ? ar : en);
      u.lang = arabic ? 'ar-SA' : 'en-US';
      u.rate = 1.05; u.volume = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* no speech */ }
  }
  // browsers only allow audio and speech after a tap: unlock (and re-wake after the phone slept) on every tap
  addEventListener('pointerdown', () => {
    if (!store.sound) return;
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { /* no audio */ }
    try { if ('speechSynthesis' in window) speechSynthesis.getVoices(); } catch { /* no speech */ }
  }, { capture: true, passive: true });
  const sfx = {
    move() { tone(900, 0.07, 'triangle', 0.08); tone(600, 0.09, 'triangle', 0.06, 0.05); },
    kill() { tone(160, 0.25, 'sawtooth', 0.1); tone(90, 0.3, 'square', 0.06, 0.05); },
    // one of YOUR marbles was sent home: heavier sting, long buzz, and a spoken alert naming who did it
    killedMine(byName, count) {
      tone(330, 0.18, 'sawtooth', 0.16); tone(196, 0.22, 'sawtooth', 0.16, 0.16); tone(98, 0.45, 'square', 0.12, 0.34);
      buzz([250, 100, 250, 100, 500]);
      const many = count > 1;
      const en = byName ? `${byName} killed ${many ? count + ' of your marbles' : 'your marble'}` : `${many ? count + ' of your marbles were' : 'Your marble was'} killed`;
      const ar = byName ? `${byName} قتل ${many ? count + ' من أحجارك' : 'حجرك'}` : (many ? `انقتل ${count} من أحجارك` : 'انقتل حجرك');
      setTimeout(() => say(en, ar), 450);
    },
    // a Jack swap: a quick two-tone warble; louder with a buzz when one of the swapped marbles is yours
    swap(mine) {
      const g = mine ? 0.16 : 0.09;
      [587, 880, 587, 880].forEach((f, i) => tone(f, 0.08, 'triangle', g, i * 0.085));
      if (mine) buzz([90, 60, 90]);
    },
    // your turn: three rising notes, loud enough to hear across the room, plus a buzz
    turn() { tone(523, 0.14, 'sine', 0.2); tone(659, 0.14, 'sine', 0.2, 0.15); tone(988, 0.32, 'sine', 0.22, 0.3); buzz([120, 60, 120]); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.12, i * 0.14)); },
    deal() { for (let i = 0; i < 4; i++) tone(1200 + i * 80, 0.04, 'square', 0.03, i * 0.06); },
  };
  $('btnSound').textContent = store.sound ? '🔊' : '🔇';
  $('btnSound').onclick = () => { store.sound = !store.sound; $('btnSound').textContent = store.sound ? '🔊' : '🔇'; if (store.sound) sfx.move(); };

  // ---------- transport: WebSocket to the Node server, or peer-to-peer when hosted statically ----------
  const SERVER_URL = String(window.JK_SERVER || '').replace(/\/$/, '');
  const MODE = window.JK_MODE === 'server' || SERVER_URL ? 'server' : 'p2p';
  let transport = null;
  let pendingJoin = null; // message to send once the connection opens
  function setStatus(state, text) {
    $('connDot').className = 'dot ' + (state === 'on' ? 'on' : state === 'wait' ? '' : 'off');
    $('netStatus').textContent = text || '';
  }
  // A game tab can stay open for hours, across deploys, and keep running old code. When the server's build
  // differs from the one this page loaded, offer a one-tap reload (the seat token and ?g=CODE bring you back).
  const loadedVersion = window.JK_VERSION || null;
  async function checkVersion() {
    if (!loadedVersion || window.JK_MODE !== 'server' || $('updateBar')) return;
    try {
      const r = await fetch('/version', { cache: 'no-store' });
      if (!r.ok) return;
      const { v } = await r.json();
      if (!v || v === loadedVersion) return;
      const b = document.createElement('button');
      b.id = 'updateBar'; b.className = 'update-bar primary';
      b.textContent = 'New version available · tap to update';
      b.onclick = () => location.reload();
      document.body.appendChild(b);
    } catch { /* offline: try again later */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  setInterval(checkVersion, 3 * 60 * 1000);
  function onOpen() {
    checkVersion(); // a deploy restarts the server, so a reconnect is the moment to look
    if (pendingJoin) { const m = pendingJoin; pendingJoin = null; transport.send(m); }
    else if (code && token) transport.send({ type: 'join', code, token, name: store.name || 'Player' });
  }
  function onMessage(msg) {
    if (msg.type === 'joined') {
      code = msg.code; token = msg.token; playerId = msg.playerId;
      store.setToken(code, token);
      history.replaceState(null, '', '?g=' + code);
    } else if (msg.type === 'state') {
      state = msg.state; you = msg.you;
      render();
    } else if (msg.type === 'error') {
      showError(msg.message);
    } else if (msg.type === 'kicked') {
      goHome('You were removed from the game.');
    } else if (msg.type === 'react') {
      showReaction(msg.seat, msg.emoji, msg.name);
    }
  }
  class WsTransport {
    constructor() { this.retry = 0; this.ready = false; this.connect(); }
    connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(SERVER_URL ? SERVER_URL.replace(/^http/, 'ws') + '/ws' : `${proto}://${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => { this.ready = true; this.retry = 0; setStatus('on'); onOpen(); };
      ws.onclose = () => { this.ready = false; setStatus('off', 'Reconnecting…'); setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.retry++)); };
      ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    }
    send(msg) { if (this.ready) this.ws.send(JSON.stringify(msg)); else pendingJoin = msg; }
    get isHost() { return false; }
  }
  async function startTransport() {
    if (MODE === 'server') { transport = new WsTransport(); return; }
    const { P2PTransport } = await import('./p2p.js');
    transport = new P2PTransport({ onMessage, onStatus: setStatus, onOpen });
    setStatus('on', '');
    if (code && token) transport.send({ type: 'join', code, token, name: store.name || 'Player' });
  }
  function send(msg) {
    if (!transport) { pendingJoin = msg; return; }
    transport.send(msg);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && transport && transport.ws && transport.ws.readyState > 1) transport.connect(); });

  function showError(text) {
    const el = state ? (state.phase === 'lobby' ? $('lobbyError') : $('gameError')) : $('homeError');
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000);
  }

  function goHome(msg) {
    state = null; you = null; code = null; token = null;
    document.body.classList.remove('in-game');
    lastLogT = 0;
    history.replaceState(null, '', location.pathname);
    showScreen('Home');
    if (msg) showError(msg);
    renderRecent();
  }

  function showScreen(name) {
    for (const s of ['Home', 'Lobby', 'Game']) $('screen' + s).classList.toggle('hidden', s !== name);
  }

  // ---------- home ----------
  function renderRecent() {
    const r = store.recent;
    $('recent').innerHTML = r.length ? 'Recent games: ' + r.map((c) => `<a href="?g=${c}">${c}</a>`).join('') : '';
  }
  $('name').value = store.name;
  $('btnCreate').onclick = () => {
    const name = $('name').value.trim();
    if (!name) return showError('Enter your name first');
    store.name = name;
    send({ type: 'create', name, settings: { players: Number($('players').value), randomTeams: $('optRandomTeams').checked, kingKills: $('optKing').checked, fiveMovesAny: $('optFive').checked, jumpOwn: $('optJumpOwn').checked, complexCards: $('optComplex').checked, jokers: $('optJokers').checked } });
  };
  $('btnJoin').onclick = () => joinFromForm(false);
  $('btnWatch').onclick = () => joinFromForm(true);
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromForm(false); });
  function joinFromForm(watch) {
    const c = $('code').value.trim().toUpperCase();
    const name = $('name').value.trim();
    if (!c) return showError('Enter the game code');
    if (watch) return send({ type: 'spectate', code: c });
    if (!name) return showError('Enter your name first');
    store.name = name;
    send({ type: 'join', code: c, name, token: store.token(c) });
  }
  $('btnRules').onclick = () => $('rulesDialog').showModal();
  $('btnRulesTop').onclick = () => $('rulesDialog').showModal();
  $('btnHome').onclick = () => { send({ type: 'leave' }); goHome(); };
  $('btnLeave').onclick = () => { send({ type: 'leave' }); goHome(); };

  // ---------- lobby ----------
  $('btnStart').onclick = () => send({ type: 'start' });
  $('btnShuffle').onclick = () => send({ type: 'shuffleSeats' });
  $('btnAddBot').onclick = () => send({ type: 'addBot' });
  $('btnCopy').onclick = async () => { try { await navigator.clipboard.writeText($('shareLink').href); $('btnCopy').textContent = 'copied'; setTimeout(() => ($('btnCopy').textContent = 'copy'), 1500); } catch { /* ignore */ } };
  if (navigator.share) { $('btnShare').classList.remove('hidden'); $('btnShare').onclick = () => navigator.share({ title: 'Jackaroo', text: `Join my Jackaroo game, code ${state ? state.code : ''}`, url: $('shareLink').href }).catch(() => {}); }

  function renderLobby() {
    const n = state.settings.players;
    const isHost = state.hostId === playerId;
    $('lobbyCode').textContent = state.code;
    const link = `${location.origin}${location.pathname.replace(/index\.html$/, '')}?g=${state.code}`;
    $('shareLink').href = link; $('shareLink').textContent = link;
    const grid = $('seatGrid');
    grid.innerHTML = '';
    for (let seat = 0; seat < n; seat++) {
      const p = state.players.find((x) => x.seat === seat);
      const team = seat % (n / 2);
      const div = document.createElement('div');
      div.className = 'seat' + (p && p.id === playerId ? ' me' : '');
      const col = SEAT_COLORS[seat];
      div.style.borderColor = col;
      div.innerHTML = `<div class="av" style="background:${col}">${p ? esc(initials(p.name)) : '·'}</div><div>
        <div class="team" style="color:${col}">Seat ${seat + 1} · Team ${TEAM_NAMES[team]}</div>
        <div class="who">${p ? esc(p.name) : '<span class="muted">empty — tap to sit</span>'}</div>
        <div class="status">${p ? (p.isBot ? 'bot' : p.connected ? 'online' : 'offline') : ''}${p && p.id === state.hostId ? ' · host' : ''}</div></div>`;
      div.onclick = () => { if (!p || p.id !== playerId) send({ type: 'seat', seat }); };
      if (isHost && p && p.id !== playerId) {
        const k = document.createElement('button'); k.className = 'kick'; k.textContent = 'remove';
        k.onclick = (e) => { e.stopPropagation(); send({ type: 'kick', playerId: p.id }); };
        div.appendChild(k);
      }
      grid.appendChild(div);
    }
    const s = state.settings;
    const st = $('lobbySettings');
    if (isHost) {
      st.innerHTML = `<label>Players <select id="lsPlayers">${[4, 6, 8].map((v) => `<option value="${v}" ${v === s.players ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="chk"><input type="checkbox" id="lsRandom" ${s.randomTeams ? 'checked' : ''}/> random teams</label>
        <label class="chk"><input type="checkbox" id="lsKing" ${s.kingKills ? 'checked' : ''}/> King 13 kills</label>
        <label class="chk"><input type="checkbox" id="lsFive" ${s.fiveMovesAny ? 'checked' : ''}/> 5 moves any marble</label>
        <label class="chk"><input type="checkbox" id="lsJumpOwn" ${s.jumpOwn ? 'checked' : ''}/> may jump own marbles</label>
        <label class="chk"><input type="checkbox" id="lsComplex" ${s.complexCards ? 'checked' : ''}/> black J swaps, red Q and 10 burn</label>
        <label class="chk"><input type="checkbox" id="lsJokers" ${s.jokers ? 'checked' : ''}/> jokers</label>`;
      const push = () => send({ type: 'settings', settings: { players: Number($('lsPlayers').value), randomTeams: $('lsRandom').checked, kingKills: $('lsKing').checked, fiveMovesAny: $('lsFive').checked, jumpOwn: $('lsJumpOwn').checked, complexCards: $('lsComplex').checked, jokers: $('lsJokers').checked } });
      for (const id of ['lsPlayers', 'lsRandom', 'lsKing', 'lsFive', 'lsJumpOwn', 'lsComplex', 'lsJokers']) $(id).onchange = push;
    } else {
      st.innerHTML = `<span class="muted">${s.players} players · ${s.randomTeams ? 'random teams' : 'chosen seats'} · King 13 ${s.kingKills ? 'on' : 'off'} · 5 any ${s.fiveMovesAny ? 'on' : 'off'} · jump own ${s.jumpOwn ? 'on' : 'off'} · complex cards ${s.complexCards ? 'on' : 'off'} · jokers ${s.jokers ? 'on' : 'off'}</span>`;
    }
    const full = state.players.length === n;
    $('btnStart').classList.toggle('hidden', !isHost);
    $('btnStart').disabled = !full;
    $('btnShuffle').classList.toggle('hidden', !isHost);
    $('btnAddBot').classList.toggle('hidden', !isHost || full);
    $('lobbyHint').textContent = (full ? (isHost ? 'Everyone is in. Start when ready.' : 'Waiting for the host to start.') : `Waiting for ${n - state.players.length} more player(s). ${s.randomTeams ? 'Seats will be shuffled at start.' : 'Tap a seat to choose your partner (partners sit opposite).'}`) + (MODE === 'p2p' && isHost ? ' This table runs in your browser: keep this page open while you play.' : '');
  }

  // ---------- colors ----------
  function seatColor(seat) { return SEAT_COLORS[seat]; }
  function nameOf(seat) { const p = state.players.find((x) => x.seat === seat); return p ? p.name : `Seat ${seat + 1}`; }
  function shade(hex, k) { // k>0 lighten towards white, k<0 darken
    const n = parseInt(hex.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const f = (c) => Math.max(0, Math.min(255, Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k))));
    return `#${((f(r) << 16) | (f(g) << 8) | f(b)).toString(16).padStart(6, '0')}`;
  }

  // ---------- board designs ----------
  const WOOD_ANDALUS = { wood: ['#9a6a3c', '#6a4322', '#3f2512'], rim: ['#4a2c16', '#1d1008'], accent: '#d9b25c', holeTop: '#2a1a0e', num: 'rgba(245,215,150,.8)', grain: [0.42, 0.27, 0.12] };
  const WOOD_OAK = { wood: ['#c99a63', '#a9743f', '#6e4420'], rim: ['#7a4a22', '#3d2410'], accent: '#ffd369', holeTop: '#3a2614', num: 'rgba(255,228,190,.65)', grain: [0.42, 0.27, 0.12] };
  const WOOD_EBONY = { wood: ['#5a4a40', '#2f2520', '#15100d'], rim: ['#0f0b09', '#3a2e27'], accent: '#e8e2d4', holeTop: '#0d0908', num: 'rgba(232,226,212,.7)', grain: [0.2, 0.15, 0.12] };
  const WOOD_SAUDI = { wood: ['#7d4b2a', '#54301a', '#331c0e'], rim: ['#3a2212', '#17100a'], accent: '#d8ac4e', holeTop: '#1a110a', num: 'rgba(236,206,146,.85)', grain: [0.42, 0.27, 0.12] };
  const WOOD_JJ = { wood: ['#8a5530', '#5e3519', '#3a1f0d'], rim: ['#f0e4c8', '#c7ad80'], accent: '#d9b45e', holeTop: '#1c120a', num: 'rgba(240,214,160,.85)', grain: [0.42, 0.27, 0.12] };
  const DESIGNS = {
    jj: { label: 'JJ round', sub: 'the real JJ board (default)', shape: 'arms', frame: 'round', rope: true, pattern: null, ...WOOD_JJ },
    saudi: { label: 'Saudi board', sub: 'the real board: walnut, gold inlay, handles', shape: 'arms', frame: 'clipped', handles: true, pattern: null, ...WOOD_SAUDI },
    andalus: { label: 'Andalus walnut', sub: 'brass inlay, square frame', shape: 'arms', frame: 'square', pattern: 'girih', ...WOOD_ANDALUS },
    andalus8: { label: 'Andalus octagon', sub: 'brass inlay, octagon frame', shape: 'arms', frame: 'octagon', pattern: 'girih', ...WOOD_ANDALUS },
    ebony: { label: 'Ebony & pearl', sub: 'mother-of-pearl, square frame', shape: 'arms', frame: 'square', pattern: 'pearl', ...WOOD_EBONY },
    oaksq: { label: 'Plain oak', sub: 'no inlay, square frame', shape: 'arms', frame: 'square', pattern: null, ...WOOD_OAK },
    oak: { label: 'Classic round', sub: 'oak, round frame', shape: 'arms', frame: 'round', pattern: null, ...WOOD_OAK },
  };
  function designId() { const d = localStorage.getItem('jk.design'); return DESIGNS[d] ? d : 'jj'; }
  function design() { return DESIGNS[designId()]; }

  // ---------- geometry ----------
  // Body frames (square, octagon, clipped corners) as rounded polygons, used by the board outline.
  function shapeVertices(shape, half) {
    const cx = 500, cy = 500;
    if (shape === 'square') return { r: half * 0.3, v: [[cx - half, cy + half], [cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half]] };
    if (shape === 'clipped') { // clipped-corner square body (Saudi board)
      const c = half * 0.34;
      return { r: 8, v: [[cx - half + c, cy + half], [cx - half, cy + half - c], [cx - half, cy - half + c], [cx - half + c, cy - half], [cx + half - c, cy - half], [cx + half, cy - half + c], [cx + half, cy + half - c], [cx + half - c, cy + half]] };
    }
    if (shape === 'octagon') {
      const v = []; for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + Math.PI / 2 + (k * Math.PI) / 4; v.push([cx + half * Math.cos(a), cy + half * Math.sin(a)]); }
      return { r: half * 0.09, v };
    }
    return { r: half, v: [[cx, cy + half], [cx - half, cy], [cx, cy - half], [cx + half, cy]] }; // round: 4 corners, radius = half -> circle
  }
  function roundedPolyPath(shape, half) {
    const { r, v } = shapeVertices(shape, half);
    if (shape === 'round') return `M ${500} ${500 + half} A ${half} ${half} 0 1 1 ${500} ${500 - half} A ${half} ${half} 0 1 1 ${500} ${500 + half} Z`;
    const n = v.length; let d = '';
    for (let i = 0; i < n; i++) {
      const p = v[i], q = v[(i + 1) % n], o = v[(i - 1 + n) % n];
      const u1 = unit(o, p), u2 = unit(p, q);
      const a = [p[0] - u1[0] * r, p[1] - u1[1] * r], b = [p[0] + u2[0] * r, p[1] + u2[1] * r];
      d += (i === 0 ? `M ${a[0]} ${a[1]} ` : `L ${a[0]} ${a[1]} `) + `Q ${p[0]} ${p[1]} ${b[0]} ${b[1]} `;
    }
    return d + 'Z';
  }
  function unit(a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; }
  function computeGeometry(s, mySeat) {
    // real Saudi / JJ board: one U-shaped arm per seat, see shared/layout.js (every design uses it)
    const lay = armLayout(s, mySeat);
    const n = s.players, cpp = s.cellsPerPlayer, L = n * cpp;
    const rc = lay.rc, gap = rc * 2.45;
    return { L, cx: 500, cy: 500, rc, gap, half: lay.R1, shape: 'arms', lay, track: lay.track, safe: lay.safe, home: lay.home, label: lay.label, cpp, n };
  }
  function geometry() {
    const s = state.settings;
    const mySeat = you ? you.seat : 0;
    const key = `${s.players}-${s.cellsPerPlayer}-${s.safeCells}-${mySeat}-${designId()}`;
    if (boardKey === key) return geo;
    geo = computeGeometry(s, mySeat);
    boardKey = key;
    return geo;
  }

  function cellPos(owner, zone, pos) {
    const g = geometry();
    if (zone === 'track') return g.track[(owner * g.cpp + pos) % g.L];
    return g.safe[owner][pos];
  }
  function marblePos(m) {
    const g = geometry();
    if (m.zone === 'home') return g.home[m.owner][Number(m.id.split('_')[1])];
    return cellPos(m.owner, m.zone, m.pos);
  }

  function patternDef(id, kind, accent) {
    if (kind === 'girih') {
      // eight-pointed star (khatim) lattice, brass lines
      return `<pattern id="${id}" width="96" height="96" patternUnits="userSpaceOnUse">
        <g fill="none" stroke="${accent}" stroke-width="1.4" stroke-opacity=".55">
          <polygon points="48,8 58,38 88,48 58,58 48,88 38,58 8,48 38,38"/>
          <polygon points="48,22 66,30 74,48 66,66 48,74 30,66 22,48 30,30"/>
          <path d="M0 0 L20 20 M96 0 L76 20 M0 96 L20 76 M96 96 L76 76"/>
          <circle cx="48" cy="48" r="7"/>
        </g></pattern>`;
    }
    if (kind === 'pearl') {
      return `<pattern id="${id}" width="64" height="64" patternUnits="userSpaceOnUse">
        <g fill="${accent}" fill-opacity=".22" stroke="${accent}" stroke-opacity=".35" stroke-width=".8">
          <polygon points="32,6 36,28 58,32 36,36 32,58 28,36 6,32 28,28"/>
          <circle cx="0" cy="0" r="3"/><circle cx="64" cy="0" r="3"/><circle cx="0" cy="64" r="3"/><circle cx="64" cy="64" r="3"/>
        </g></pattern>`;
    }
    return '';
  }

  function boardDefs(g, d, idp, seatColorOf) {
    let h = `<defs>
      <radialGradient id="${idp}woodGrad" cx="45%" cy="40%" r="70%"><stop offset="0" stop-color="${d.wood[0]}"/><stop offset=".55" stop-color="${d.wood[1]}"/><stop offset="1" stop-color="${d.wood[2]}"/></radialGradient>
      <linearGradient id="${idp}rimGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${d.rim[0]}"/><stop offset=".5" stop-color="${d.rim[1]}"/><stop offset="1" stop-color="${d.rim[0]}"/></linearGradient>
      <radialGradient id="${idp}holeGrad" cx="40%" cy="35%" r="65%"><stop offset="0" stop-color="${d.holeTop}"/><stop offset=".6" stop-color="#120b06"/><stop offset="1" stop-color="${shade(d.wood[2], -0.2)}"/></radialGradient>
      <linearGradient id="${idp}cardBack" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8e2b2b"/><stop offset="1" stop-color="#5a1414"/></linearGradient>
      <linearGradient id="${idp}brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(d.accent, 0.35)}"/><stop offset=".5" stop-color="${d.accent}"/><stop offset="1" stop-color="${shade(d.accent, -0.35)}"/></linearGradient>
      <filter id="${idp}woodgrain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.004 0.13" numOctaves="5" seed="11" result="noise"/>
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 ${d.grain[0]}  0 0 0 0 ${d.grain[1]}  0 0 0 0 ${d.grain[2]}  0 0 0 0.8 0" result="grain"/>
        <feComposite in="grain" in2="SourceGraphic" operator="in" result="clipped"/>
        <feBlend in="SourceGraphic" in2="clipped" mode="multiply"/>
      </filter>
      <filter id="${idp}inset" x="-20%" y="-20%" width="140%" height="140%">
        <feOffset dx="0" dy="2" in="SourceAlpha" result="o"/><feGaussianBlur in="o" stdDeviation="1.5" result="b"/>
        <feComposite in="b" in2="SourceAlpha" operator="out" result="s"/><feFlood flood-color="#000" flood-opacity=".7"/><feComposite in2="s" operator="in" result="sh"/>
        <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="sh"/></feMerge>
      </filter>
      <filter id="${idp}mshadow" x="-60%" y="-60%" width="240%" height="240%"><feDropShadow dx="1.5" dy="3" stdDeviation="1.6" flood-color="#000" flood-opacity=".55"/></filter>
      <filter id="${idp}glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      ${d.pattern ? patternDef(idp + 'inlay', d.pattern, d.accent) : ''}`;
    for (let seat = 0; seat < g.n; seat++) {
      const c = seatColorOf(seat);
      h += `<radialGradient id="${idp}mg${seat}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="${shade(c, 0.75)}"/><stop offset=".25" stop-color="${shade(c, 0.25)}"/><stop offset=".7" stop-color="${c}"/><stop offset="1" stop-color="${shade(c, -0.55)}"/></radialGradient>`;
    }
    return h;
  }

  // ---------- board (all designs share the real U-arm layout; they differ in frame, wood and inlay) ----------
  const f1 = (v) => v.toFixed(1);
  function armBoardMarkup(g, d, idp, seatColorOf) {
    const lay = g.lay, n = g.n, sp = lay.sp, rc = g.rc, R1 = lay.R1, dd = lay.d;
    const band = 0.56 * sp; // half width of the U outline around the track holes
    const at = (s, a, b) => { const f = lay.frames[s]; return { x: 500 + f.l.x * a + f.o.x * b, y: 500 + f.l.y * a + f.o.y * b }; };
    const rotOf = (s) => Math.atan2(lay.frames[s].o.y, lay.frames[s].o.x) * 180 / Math.PI;
    const pill = (c, len, wid, rot, extra) => `<rect x="${f1(c.x - len / 2)}" y="${f1(c.y - wid / 2)}" width="${f1(len)}" height="${f1(wid)}" rx="${f1(Math.min(len, wid) / 2)}" transform="rotate(${f1(rot)} ${f1(c.x)} ${f1(c.y)})" ${extra}/>`;
    // one closed outline along the whole 76-hole track (columns, ring, outer rows)
    const loops = ['M ' + g.track.map((p) => `${f1(p.x)} ${f1(p.y)}`).join(' L ') + ' Z'];
    let h = boardDefs(g, d, idp, seatColorOf);
    h += `<mask id="${idp}armMask" maskUnits="userSpaceOnUse" x="-30" y="-30" width="1060" height="1060">`;
    for (const lp of loops) h += `<path d="${lp}" fill="none" stroke="#fff" stroke-width="${f1(band * 2 + 3)}" stroke-linejoin="round"/>`;
    for (const lp of loops) h += `<path d="${lp}" fill="none" stroke="#000" stroke-width="${f1(band * 2)}" stroke-linejoin="round"/>`;
    h += `</mask></defs>`;
    // body
    const R = lay.R;
    const poly = d.frame !== 'round';
    // polygon frames: `ex` is the offset from the body edge; the octagon is sized by its apothem (flat sides on the axes)
    const polyPath = (ex) => roundedPolyPath(d.frame, d.frame === 'octagon' ? (R - 5 + ex) / Math.cos(Math.PI / 8) : R - 5 + ex);
    if (!poly) {
      h += `<circle cx="500" cy="500" r="${R + 10}" fill="url(#${idp}rimGrad)"/>`;
      h += `<circle cx="500" cy="500" r="${R - 8}" fill="url(#${idp}woodGrad)" filter="url(#${idp}woodgrain)"/>`;
      if (d.pattern) h += `<circle cx="500" cy="500" r="${R - 8}" fill="url(#${idp}inlay)"/>`;
      h += `<circle cx="500" cy="500" r="${R - 8}" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="3"/>`;
      // thin engraved gold lines
      for (const r of [R - 18, R - 23]) h += `<circle cx="500" cy="500" r="${r}" fill="none" stroke="${d.accent}" stroke-width=".9" stroke-opacity=".7"/>`;
    } else {
      const half = R - 5;
      h += `<path d="${polyPath(14)}" fill="url(#${idp}rimGrad)"/>`;
      h += `<path d="${polyPath(0)}" fill="url(#${idp}woodGrad)" filter="url(#${idp}woodgrain)"/>`;
      if (d.pattern) h += `<path d="${polyPath(0)}" fill="url(#${idp}inlay)"/>`;
      h += `<path d="${polyPath(-6)}" fill="none" stroke="url(#${idp}brass)" stroke-width="2.5" stroke-opacity=".9"/>`;
      h += `<path d="${polyPath(-13)}" fill="none" stroke="${d.accent}" stroke-width="1" stroke-opacity=".4"/>`;
      // carrying handles cut into the sides, like the real Saudi board
      if (d.handles) for (const sx of [-1, 1]) h += `<rect x="${500 + sx * (half - 30) - 9}" y="${500 - 40}" width="18" height="80" rx="9" fill="#0d0805" stroke="${d.accent}" stroke-opacity=".6"/>`;
    }
    // centre circle
    const cR = lay.centerR;
    if (d.rope) {
      h += `<circle cx="500" cy="500" r="${cR}" fill="rgba(0,0,0,.22)" stroke="${d.accent}" stroke-width="1" stroke-opacity=".8"/>`;
      // rope ring: alternating red / white dashes
      const rr = cR + 7, circ = 2 * Math.PI * rr, k = Math.round(circ / 14) * 2, dash = circ / k;
      h += `<circle cx="500" cy="500" r="${f1(rr)}" fill="none" stroke="#f4efe4" stroke-width="7"/>`;
      h += `<circle cx="500" cy="500" r="${f1(rr)}" fill="none" stroke="#b8262b" stroke-width="7" stroke-dasharray="${dash.toFixed(3)} ${dash.toFixed(3)}" transform="rotate(-90 500 500)"/>`;
      h += `<circle cx="500" cy="500" r="${f1(rr + 4.5)}" fill="none" stroke="${d.accent}" stroke-width=".9" stroke-opacity=".7"/>`;
    } else {
      h += `<circle cx="500" cy="500" r="${cR + 6}" fill="url(#${idp}brass)" stroke="${shade(d.accent, -0.45)}" stroke-width="2"/>`;
      h += `<circle cx="500" cy="500" r="${cR}" fill="${d.wood[2]}" stroke="rgba(255,240,200,.45)" stroke-width="1"/>`;
    }
    // engraved circles just inside and outside the central ring of holes
    for (const r of [lay.Rr - 0.95 * sp, lay.Rr + 0.95 * sp]) h += `<circle cx="500" cy="500" r="${f1(r)}" fill="none" stroke="${d.accent}" stroke-width=".8" stroke-opacity=".35"/>`;
    // outline along the track holes (fill + 1.5px accent edges via the mask)
    for (const lp of loops) h += `<path d="${lp}" fill="none" stroke="rgba(0,0,0,.15)" stroke-width="${f1(band * 2)}" stroke-linejoin="round"/>`;
    h += `<rect x="-30" y="-30" width="1060" height="1060" fill="${d.accent}" mask="url(#${idp}armMask)"/>`;
    const ring = `stroke:${d.accent};stroke-width:1.2;`;
    const hole = (p, r, extra = '') => `<circle class="hole" cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(r)}" fill="url(#${idp}holeGrad)" filter="url(#${idp}inset)" style="${ring}" ${extra}/>`;
    const fs = Math.max(9, 0.46 * sp);
    let nums = '';
    const num = (p, txt, extra = '') => `<text class="num" x="${f1(p.x)}" y="${f1(p.y + fs * 0.36)}" style="font-size:${f1(fs)}px;fill:${d.num}${extra}">${txt}</text>`;
    for (let s = 0; s < n; s++) {
      const c = seatColorOf(s), rot = rotOf(s);
      // home lane outline in the seat colour: hole 17 (the entrance, on the outer row) plus the safe column above it
      const sa = at(s, 0, R1 - sp * 1.94);
      h += pill(sa, sp * 5.06, sp, rot, `fill="rgba(0,0,0,.15)" stroke="${c}" stroke-width="1.5"`);
      // pen plate + suit glyph
      const pc = at(s, dd + 2.6 * sp, R1 - 1.7 * sp);
      const ps = 1.1 * sp + 2 * rc * 0.95 + 0.25 * sp;
      h += `<rect x="${f1(pc.x - ps / 2)}" y="${f1(pc.y - ps / 2)}" width="${f1(ps)}" height="${f1(ps)}" rx="${f1(sp * 0.4)}" transform="rotate(${f1(rot)} ${f1(pc.x)} ${f1(pc.y)})" fill="rgba(0,0,0,.2)" stroke="${d.accent}" stroke-width="1.5"/>`;
      g.home[s].forEach((p) => { h += hole(p, rc * 0.95); });
      const sg = lay.suit[s], redSuit = sg.glyph === '♥' || sg.glyph === '♦';
      h += `<text class="suit" x="${f1(sg.x)}" y="${f1(sg.y + sp * 0.4)}" style="font-size:${f1(sp * 1.15)}px;fill:${redSuit ? '#d24b3e' : d.accent};text-anchor:middle;pointer-events:none">${sg.glyph}</text>`;
      g.safe[s].forEach((p, k) => {
        h += hole(p, rc).replace(`style="${ring}`, `style="stroke:${c};stroke-width:2;`);
        nums += `<text class="num" x="${f1(p.x)}" y="${f1(p.y + rc * 0.34)}" style="font-size:${f1(rc * 0.85)}px;fill:${c};opacity:.75">${k + 1}</text>`;
      });
      const lp = g.label[s];
      h += `<text id="${idp}lbl${s}" class="lbl" x="${f1(lp.x)}" y="${f1(lp.y + 7)}" style="fill:${c};font-size:${f1(Math.max(14, rc * 1.15))}px"></text>`;
    }
    g.track.forEach((p, i) => {
      if (p.k === 0) { // star = this seat's base
        const c = seatColorOf(p.seg);
        h += hole(p, rc * 1.12).replace(`style="${ring}`, `style="stroke:${c};stroke-width:3;`);
        nums += `<text class="num" x="${f1(p.x)}" y="${f1(p.y + rc * 0.42)}" style="font-size:${f1(rc * 1.15)}px;fill:${c};opacity:.95">★</text>`;
        return;
      }
      if (p.k === 17) { // the entrance to the owner's safe column (the arm belongs to seat seg+1): ring it in their colour
        const c = seatColorOf((p.seg + 1) % n);
        h += hole(p, rc, `data-abs="${i}"`).replace(`style="${ring}`, `style="stroke:${c};stroke-width:2;`);
        nums += num({ x: p.x, y: p.y - fs * 0.06 }, p.label, `;fill:${c};opacity:.9`);
        return;
      }
      h += hole(p, rc, `data-abs="${i}"`);
      nums += num({ x: p.lx, y: p.ly }, p.label);
    });
    h += nums;
    return h;
  }

  function drawBoardStatic() {
    const g = geometry();
    const d = design();
    const svg = $('board');
    let h = armBoardMarkup(g, d, '', seatColor);
    // centre: status text and piles
    // pile geometry: scales with the centre circle (bigger boards, bigger piles)
    const cR = g.lay.centerR;
    const cw = Math.round(cR * 0.36), ch = Math.round(cw * 1.4), pg = 0.09 * cw; // gap between piles = 0.18*cw
    const py = 500 - ch / 2 + cR * 0.12;
    const cntFs = Math.round(cw * 0.34), txtFs = Math.round(cw * 0.42);
    const ty = py - cR * 0.16;
    // inside the centre circle: status text above the deck and discard piles
    h += `<text id="centerText" class="center-text" x="500" y="${ty.toFixed(1)}" style="fill:${shade(d.accent, 0.3)};font-size:20px"></text><text id="centerSub" class="center-sub" x="500" y="${(ty + 20).toFixed(1)}" style="font-size:13px"></text>`;
    const fs = (px) => ` style="font-size:${px}px"`;
    h += `<g id="piles">
      <rect class="pile-card" x="${500 - cw - pg + 3}" y="${py + 3}" width="${cw}" height="${ch}" rx="6" opacity=".6" fill="url(#cardBack)"/>
      <rect class="pile-card" x="${500 - cw - pg}" y="${py}" width="${cw}" height="${ch}" rx="6" fill="url(#cardBack)"/>
      <rect x="${500 - cw - pg + 5}" y="${py + 5}" width="${cw - 10}" height="${ch - 10}" rx="4" fill="none" stroke="rgba(255,220,180,.5)" stroke-dasharray="3 2"/>
      <text id="stockCnt" class="pile-cnt" x="${500 - cw / 2 - pg}" y="${py + ch / 2 + cntFs * 0.38}"${fs(cntFs)}></text>
      <rect id="discardCard" class="pile-face" x="${500 + pg}" y="${py}" width="${cw}" height="${ch}" rx="6" opacity="0"/>
      <text id="discardTxt" class="pile-txt" x="${500 + pg + cw / 2}" y="${py + ch / 2 + txtFs * 0.36}"${fs(txtFs)}></text>
    </g>`;
    h += `<radialGradient id="spotGrad"><stop offset="0" stop-color="#ffd977" stop-opacity=".55"/><stop offset=".6" stop-color="#ffd977" stop-opacity=".12"/><stop offset="1" stop-color="#ffd977" stop-opacity="0"/></radialGradient>
      <circle id="spot" class="spot" r="${(g.gap * 4.2).toFixed(0)}" cx="500" cy="500" fill="url(#spotGrad)" style="mix-blend-mode:screen;pointer-events:none"/>
      <circle id="turnRing" class="turn-ring" r="20" cx="-100" cy="-100"/><g id="targets"></g><g id="fx"></g><g id="marbles"></g><g id="bubbles"></g>`;
    svg.innerHTML = h;
    svg.dataset.key = boardKey;
  }

  // ---------- design picker ----------
  function previewMarkup(id, idp) {
    const d = DESIGNS[id];
    const g = computeGeometry({ players: 4, cellsPerPlayer: 19, safeCells: 4, marblesPerPlayer: 4 }, 0);
    let h = armBoardMarkup(g, d, idp, seatColor);
    const sample = [[0, 'track', 0], [0, 'track', 5], [1, 'track', 3], [2, 'track', 9], [3, 'track', 0], [1, 'safe', 0]];
    for (const [owner, zone, pos] of sample) {
      const p = zone === 'track' ? g.track[(owner * g.cpp + pos) % g.L] : g.safe[owner][pos];
      h += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(g.rc * 0.92).toFixed(1)}" fill="url(#${idp}mg${owner})" stroke="rgba(0,0,0,.35)"/>`;
    }
    return h;
  }
  function openDesignPicker() {
    const grid = $('designGrid');
    grid.innerHTML = Object.keys(DESIGNS).map((id, i) => `<button type="button" class="design${id === designId() ? ' sel' : ''}" data-id="${id}">
        <svg viewBox="-30 -30 1060 1060">${previewMarkup(id, `pv${i}_`)}</svg>
        <span class="dn">${DESIGNS[id].label}</span><span class="ds">${DESIGNS[id].sub}</span></button>`).join('');
    grid.querySelectorAll('button.design').forEach((b) => (b.onclick = () => {
      localStorage.setItem('jk.design', b.dataset.id);
      grid.querySelectorAll('button.design').forEach((x) => x.classList.toggle('sel', x === b));
      if (state && state.phase !== 'lobby') { boardKey = ''; prevPos = new Map(); renderGame(); }
    }));
    $('designDialog').showModal();
  }
  $('btnDesign').onclick = openDesignPicker;
  // ---------- board zoom ----------
  // zoomLevel scales .board-stage (width = zoom * 100% of .board-wrap, which scrolls). 1 = whole board fits.
  const ZOOM_LEVELS = [1, 1.4, 1.9, 2.6];
  const ZOOM_MIN = 1, ZOOM_MAX = 2.6;
  const boardWrap = document.querySelector('.board-wrap');
  let zoomLevel = 1;
  let lastUserScrollAt = 0;
  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  // the zoom choice is remembered per layout mode ('portrait' / 'side'), see fitLayout below
  let layoutMode = '', layoutBoardSide = 0, layoutCoarse = false;
  const zoomKey = () => `jk.zoomLevel.${layoutMode || 'portrait'}`;
  function storedZoom() {
    let z = NaN;
    try {
      z = parseFloat(localStorage.getItem(zoomKey()));
      if (!Number.isFinite(z) && layoutMode === 'portrait') {
        const old = localStorage.getItem('jk.zoomLevel'); // migrate the old single key to portrait
        const toggle = localStorage.getItem('jk.zoom'); // and the older on/off toggle
        z = old !== null ? parseFloat(old) : toggle === '1' ? 1.9 : toggle === '0' ? 1 : NaN;
      }
    } catch { /* storage blocked */ }
    return Number.isFinite(z) ? clampZoom(z) : NaN;
  }
  // default zoom from tap comfort: on a touch screen aim for ~26 CSS px between neighbouring holes; with a mouse show the whole board
  function defaultZoom() {
    if (!layoutCoarse || !layoutBoardSide) return 1;
    const n = state && state.settings ? state.settings.players : 4;
    const spacing = (layoutBoardSide * (SPACING[n] || 24)) / 1060;
    const z = Math.round(Math.min(2.6, Math.max(1, 26 / spacing)) * 100) / 100;
    return z < 1.1 ? 1 : z; // a barely zoomed board only adds scrolling
  }
  function loadZoom() { const z = storedZoom(); return Number.isFinite(z) ? z : defaultZoom(); }
  const saveZoom = (z) => { try { localStorage.setItem(zoomKey(), String(Math.round(z * 100) / 100)); } catch { /* ignore */ } };
  function updateZoomButtons() {
    $('btnZoomIn').disabled = zoomLevel >= ZOOM_MAX - 0.01;
    $('btnZoomOut').disabled = zoomLevel <= ZOOM_MIN + 0.01;
  }
  // fx, fy: focal point in boardWrap client coordinates (kept fixed while the scale changes); default is the view centre
  function applyZoom(z, fx, fy, save = true) {
    z = clampZoom(z);
    const w = boardWrap, stage = w.firstElementChild;
    if (fx === undefined) fx = w.clientWidth / 2;
    if (fy === undefined) fy = w.clientHeight / 2;
    const oldW = stage.offsetWidth || 1;
    const cx = (w.scrollLeft + fx) / oldW, cy = (w.scrollTop + fy) / oldW; // fractions of the (square) stage
    zoomLevel = z;
    w.style.setProperty('--zoom', z);
    w.classList.toggle('zoomed', z > 1.001);
    const newW = stage.offsetWidth;
    if (z > 1.001) { w.scrollLeft = cx * newW - fx; w.scrollTop = cy * newW - fy; } else { w.scrollLeft = 0; w.scrollTop = 0; }
    updateZoomButtons();
    if (save) saveZoom(z);
  }
  function setZoom(z) { applyZoom(z); }
  function stepZoom(dir) {
    const next = dir > 0 ? ZOOM_LEVELS.find((l) => l > zoomLevel + 0.01) : [...ZOOM_LEVELS].reverse().find((l) => l < zoomLevel - 0.01);
    if (next !== undefined) setZoom(next);
  }
  $('btnZoomIn').onclick = () => stepZoom(1);
  $('btnZoomOut').onclick = () => stepZoom(-1);

  // scroll so the board point (SVG coords) is centred in the viewport; instant=true skips the animation
  function scrollToSvg(x, y, instant) {
    const w = boardWrap, sw = w.firstElementChild.offsetWidth;
    const px = ((x + 30) / 1060) * sw, py = ((y + 30) / 1060) * sw;
    const left = Math.max(0, Math.min(w.scrollWidth - w.clientWidth, px - w.clientWidth / 2));
    const top = Math.max(0, Math.min(w.scrollHeight - w.clientHeight, py - w.clientHeight / 2));
    w.scrollTo({ left, top, behavior: instant || reducedMotion ? 'auto' : 'smooth' });
  }
  function revealMySide(instant) {
    if (zoomLevel <= 1.001) return;
    const w = boardWrap, left = (w.scrollWidth - w.clientWidth) / 2, top = w.scrollHeight - w.clientHeight;
    w.scrollTo({ left, top, behavior: instant || reducedMotion ? 'auto' : 'smooth' });
  }
  function revealMove(lm) {
    if (!lm || zoomLevel <= 1.001 || !state) return;
    if (Date.now() - lastUserScrollAt < 2500) return;
    const w = boardWrap, sw = w.firstElementChild.offsetWidth;
    const pts = [lm.marbleId, lm.targetId].filter(Boolean).map(marbleById).filter(Boolean).map((m) => marblePos(m)).filter(Boolean);
    if (!pts.length) return;
    const toPx = (p) => ({ x: ((p.x + 30) / 1060) * sw, y: ((p.y + 30) / 1060) * sw });
    const m = (sw / 1060) * 30; // margin so a marble is not cut by the edge
    const inView = (p) => { const q = toPx(p); return q.x >= w.scrollLeft + m && q.x <= w.scrollLeft + w.clientWidth - m && q.y >= w.scrollTop + m && q.y <= w.scrollTop + w.clientHeight - m; };
    if (pts.every(inView)) return;
    let c = pts[0];
    if (pts.length > 1) {
      const a = toPx(pts[0]), b = toPx(pts[1]);
      const fits = Math.abs(a.x - b.x) < w.clientWidth - 2 * m && Math.abs(a.y - b.y) < w.clientHeight - 2 * m;
      c = fits ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[1];
    }
    scrollToSvg(c.x, c.y, false);
  }
  // user input: remember it (so revealMove does not fight a hand on the board); pinch / ctrl+wheel zoom
  ['pointerdown', 'wheel', 'touchmove'].forEach((ev) => boardWrap.addEventListener(ev, () => { lastUserScrollAt = Date.now(); }, { passive: true }));
  let pinch = null;
  const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
  const touchMid = (t) => { const r = boardWrap.getBoundingClientRect(); return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top }; };
  boardWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinch = { d0: touchDist(e.touches), z0: zoomLevel, overflow: boardWrap.style.overflow };
      boardWrap.style.overflow = 'hidden'; // stop a native pan already in flight from fighting the pinch
      lastUserScrollAt = Date.now();
    }
  }, { passive: true });
  boardWrap.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const mid = touchMid(e.touches);
    applyZoom(pinch.z0 * (touchDist(e.touches) / pinch.d0), mid.x, mid.y, false);
  }, { passive: false });
  const endPinch = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    boardWrap.style.overflow = pinch.overflow;
    pinch = null;
    saveZoom(zoomLevel);
    lastUserScrollAt = Date.now();
  };
  boardWrap.addEventListener('touchend', endPinch, { passive: true });
  boardWrap.addEventListener('touchcancel', endPinch, { passive: true });
  boardWrap.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = boardWrap.getBoundingClientRect();
    applyZoom(zoomLevel * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // keep the zoom buttons over the board's lower-right corner (not the page's), whatever the board's size
  const zoomCtl = document.querySelector('.zoom-ctl');
  function placeZoomCtl() {
    // phones: publish the hand dock's height so the CSS sizes the board to the room that is really left. The prompt's
    // extra lines and choice buttons come and go, so only one prompt line is counted (keeps the board from jumping).
    const dockEl = document.querySelector('.side-top'), prEl = $('prompt');
    if (dockEl.offsetHeight && layoutMode === 'portrait') {
      const base = Math.round(dockEl.offsetHeight - (prEl ? prEl.offsetHeight : 0) + 40); // 40: one prompt line
      if (document.documentElement.style.getPropertyValue('--dock-h') !== base + 'px') document.documentElement.style.setProperty('--dock-h', base + 'px');
    }
    const w = boardWrap;
    if (!w.offsetWidth) return;
    zoomCtl.style.right = 'auto'; zoomCtl.style.bottom = 'auto';
    zoomCtl.style.left = `${w.offsetLeft + w.offsetWidth - zoomCtl.offsetWidth - 10}px`;
    const wr = w.getBoundingClientRect();
    let bottom = wr.bottom;
    if (layoutMode === 'portrait') bottom = Math.min(bottom, dockEl.getBoundingClientRect().top); // stay above the hand dock
    zoomCtl.style.top = `${w.offsetTop + (bottom - wr.top) - zoomCtl.offsetHeight - 10}px`;
  }
  if (window.ResizeObserver) { const ro = new ResizeObserver(placeZoomCtl); ro.observe(boardWrap); ro.observe(document.querySelector('.side-top')); }

  // ---------- layout: measure the screen, derive card / board / panel sizes ----------
  // portrait (usable height > 1.15 * width): board on top, hand dock at the bottom.
  // side (any other shape): square board on the left, HUD + turn banner + prompt + hand in a column on the right.
  const layoutProbe = document.createElement('div'); // its padding is the safe-area insets (CSS vars fall back to env())
  layoutProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)';
  document.body.appendChild(layoutProbe);
  const coarseMQ = window.matchMedia ? matchMedia('(pointer: coarse)') : null;
  const root = document.documentElement;
  function fitLayout(force) {
    const vv = window.visualViewport, sc = vv && vv.scale ? vv.scale : 1; // scale: undo a browser pinch zoom
    const W = Math.round(vv ? vv.width * sc : innerWidth), H = Math.round(vv ? vv.height * sc : innerHeight);
    if (!W || !H) return;
    const cs = getComputedStyle(layoutProbe);
    const st = parseFloat(cs.paddingTop) || 0, sr = parseFloat(cs.paddingRight) || 0, sb = parseFloat(cs.paddingBottom) || 0, sl = parseFloat(cs.paddingLeft) || 0;
    const uw = W - sl - sr, uh = H - st - sb; // usable area
    const coarse = !!(coarseMQ && coarseMQ.matches);
    const mode = uh > uw * 1.15 ? 'portrait' : 'side';
    const CAP = coarse ? 84 : 100, MIN = 54, FAN = 4.7; // FAN: panel width in cards for five fanned cards plus padding (4.56) with a little air
    const clampCard = (v) => Math.floor(Math.max(MIN, Math.min(CAP, v)));
    let cw, S, v;
    if (mode === 'portrait') {
      cw = clampCard(Math.min(76, (uw - 24) / FAN, (0.28 * uh - 66) / 1.76)); // fits the width; the dock stays under ~28% of the height; 76: a bigger fan only steals board
      const dockH = parseFloat(root.style.getPropertyValue('--dock-h')) || 1.76 * cw + 88;
      S = Math.max(120, Math.min(uw, 980, H - st - 56 - dockH)); // board side at zoom 1 (CSS does the real sizing)
      v = { '--card-w': cw + 'px' };
    } else {
      const cwMax = Math.min(CAP, 0.24 * uh); // cards at most ~24% of the height
      S = Math.floor(Math.max(200, Math.min(uh, 980, uw - (FAN * MIN + 24)))); // the board takes all the height it can
      const panelW = Math.floor(Math.min(uw - S, FAN * cwMax + 24));
      cw = clampCard(Math.min(cwMax, (panelW - 24) / FAN));
      const left = sl + Math.max(0, (uw - S - panelW) / 2); // centre the pair on very wide screens
      v = { '--card-w': cw + 'px', '--board-side': S + 'px', '--board-left': left + 'px', '--board-top': st + Math.max(0, (uh - S) / 2) + 'px', '--panel-left': left + S + 'px', '--panel-w': panelW + 'px' };
    }
    const changed = mode !== layoutMode;
    // zoomed in: remember which board point is at the centre of the view, to restore it after the resize
    let keep = null;
    if (!changed && !force && zoomLevel > 1.001 && boardWrap.offsetWidth) {
      const sw = boardWrap.firstElementChild.offsetWidth || 1;
      keep = { x: (boardWrap.scrollLeft + boardWrap.clientWidth / 2) / sw, y: (boardWrap.scrollTop + boardWrap.clientHeight / 2) / sw };
    }
    for (const k in v) root.style.setProperty(k, v[k]);
    document.body.classList.toggle('layout-portrait', mode === 'portrait');
    document.body.classList.toggle('layout-side', mode === 'side');
    const hud = document.querySelector('.hud');
    if (mode === 'side' && hud.offsetHeight) root.style.setProperty('--hud-h', hud.offsetHeight + 'px');
    layoutMode = mode; layoutBoardSide = S; layoutCoarse = coarse;
    if (changed || force) {
      applyZoom(loadZoom(), undefined, undefined, false);
      requestAnimationFrame(() => revealMySide(true)); // start on your own side
    } else if (keep) {
      const sw = boardWrap.firstElementChild.offsetWidth;
      boardWrap.scrollLeft = keep.x * sw - boardWrap.clientWidth / 2; boardWrap.scrollTop = keep.y * sw - boardWrap.clientHeight / 2;
    }
    if (!changed && !force && !Number.isFinite(storedZoom()) && Math.abs(defaultZoom() - zoomLevel) > 0.15) applyZoom(defaultZoom(), undefined, undefined, false); // no user choice yet: follow the new size
    placeZoomCtl();
  }
  let fitQueued = false;
  const queueFit = () => { if (fitQueued) return; fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitLayout(); }); };
  addEventListener('resize', queueFit);
  addEventListener('orientationchange', () => { queueFit(); setTimeout(queueFit, 300); }); // iOS reports the old size at first
  if (window.visualViewport) visualViewport.addEventListener('resize', queueFit);
  fitLayout(true);

  // ---------- move selection ----------
  function candidateMoves() {
    if (!you || !you.legalMoves) return [];
    return you.legalMoves.filter((m) => m.cardId === sel.cardId && sel.picks.every((p, i) => m.picks[i] && m.picks[i].value === p));
  }
  function nextPicks() {
    const cands = candidateMoves();
    const depth = sel.picks.length;
    const seen = new Map();
    for (const m of cands) { const p = m.picks[depth]; if (p && !seen.has(p.type + p.value)) seen.set(p.type + p.value, p); }
    return [...seen.values()];
  }
  function tryCommit() {
    const cands = candidateMoves();
    if (cands.length === 1 && sel.picks.length >= cands[0].picks.length) {
      const cardEl = $('hand').querySelector('.pcard.sel');
      if (cardEl && cands[0].kind !== 'burn') flyCard(cardEl);
      send({ type: 'move', moveId: cands[0].id });
      sel = { cardId: null, picks: [] };
      return true;
    }
    return false;
  }
  function pick(value) {
    sel.picks.push(value);
    hoverMarble = null;
    if (!tryCommit()) renderGame();
  }

  function marbleById(id) { return state.marbles.find((m) => m.id === id); }
  // a 7's picks are [marble A, steps, marble B?], after a Joker's 'as:7' prefix if any; this is the depth within them
  function sevenDepth(mv, depth) { return depth - (mv.picks.length - (mv.parts.length === 2 ? 3 : 2)); }
  // holes to light for a move at the current pick depth. A 7 is picked step by step:
  // nothing while choosing the first marble, then where the first part stops, then where the second part stops.
  function destinationsOf(mv, depth) {
    const out = [];
    const kills = new Set(mv.kills || []);
    const add = (owner, to, viaMarble, steps) => { if (to) out.push({ owner, zone: to.zone, pos: to.pos, kill: kills.size > 0 && viaMarble, steps }); };
    if (mv.kind === 'jack') { add(marbleById(mv.marbleId).owner, { zone: 'track', pos: mv.toA }); add(marbleById(mv.targetId).owner, { zone: 'track', pos: mv.toB }); }
    else if (mv.kind === 'seven') {
      const d = sevenDepth(mv, depth);
      const part = d === 1 ? mv.parts[0] : d === 2 ? mv.parts[1] : null;
      if (part) add(marbleById(part.marbleId).owner, part.to, true, part.steps);
    }
    else if (mv.marbleId && mv.to) add(marbleById(mv.marbleId).owner, mv.to, true);
    return out;
  }

  function renderTargets() {
    const grp = $('targets');
    if (!grp) return;
    let cands = candidateMoves().filter((m) => m.kind !== 'burn');
    const depth = sel.picks.length;
    if (hoverMarble) cands = cands.filter((m) => m.picks[depth] && m.picks[depth].type === 'marble' && m.picks[depth].value === hoverMarble);
    const g = geometry();
    const seen = new Set();
    let h = '';
    for (const mv of cands) {
      for (const d of destinationsOf(mv, depth)) {
        const k = `${d.owner}-${d.zone}-${d.pos}`;
        if (seen.has(k)) continue; seen.add(k);
        const p = cellPos(d.owner, d.zone, d.pos);
        const circle = `<circle class="target${d.kill ? ' kill' : ''}" data-owner="${d.owner}" data-zone="${d.zone}" data-pos="${d.pos}"${d.steps ? ` data-steps="${d.steps}"` : ''} cx="${p.x}" cy="${p.y}" r="${g.rc * 1.45}" filter="url(#glow)"/>`;
        h += d.steps ? `<g>${circle}<text class="target-steps" x="${p.x}" y="${p.y}" dy="0.35em">${d.steps}</text></g>` : circle;
      }
    }
    grp.innerHTML = h;
    // tapping a lit hole plays the move that ends there (when that is unambiguous)
    grp.querySelectorAll('circle.target').forEach((c) => (c.onclick = () => tapTarget(Number(c.dataset.owner), c.dataset.zone, Number(c.dataset.pos))));
    // on phones, bring the lit holes into view once per card selection
    if (sel.cardId && scrolledFor !== sel.cardId) {
      scrolledFor = sel.cardId;
      const first = grp.querySelector('circle.target');
      if (first) {
        const r = first.getBoundingClientRect();
        if (zoomLevel > 1.001) { // zoomed: scroll the board itself so the lit hole is in view
          const wr = boardWrap.getBoundingClientRect();
          if (r.left < wr.left + 20 || r.right > wr.right - 20 || r.top < wr.top + 20 || r.bottom > wr.bottom - 20) scrollToSvg(+first.getAttribute('cx'), +first.getAttribute('cy'), false);
        } else if (layoutMode === 'portrait') {
          const visibleBottom = innerHeight - 180;
          if (r.top < 60 || r.bottom > visibleBottom) window.scrollBy({ top: r.top - visibleBottom / 2, behavior: 'smooth' });
        }
      }
    }
  }
  function tapTarget(owner, zone, pos) {
    const depth = sel.picks.length;
    // track holes are compared by their shared index: a destination is numbered from the MOVING marble's base,
    // a marble sitting there (tapped for a kill) from its own owner's base
    const g = geometry();
    const same = (d) => d.zone === zone && (zone === 'track'
      ? (d.owner * g.cpp + d.pos) % g.L === (owner * g.cpp + pos) % g.L
      : d.owner === owner && d.pos === pos);
    const cands = candidateMoves().filter((mv) => destinationsOf(mv, depth).some(same));
    if (!cands.length) return;
    // a 7 advances one pick per tap (marble A's hole picks the steps, marble B's hole picks B), so the split stays visible
    if (cands.length === 1 && cands[0].kind !== 'seven') { sel.picks = cands[0].picks.map((p) => p.value); if (!tryCommit()) renderGame(); return; }
    const next = cands[0].picks[depth];
    if (next && cands.every((mv) => mv.picks[depth] && mv.picks[depth].value === next.value)) pick(next.value);
  }

  function pathPoints(prev, m) {
    // intermediate hole positions for a hop animation (forward or backward along the track, into the safe zone)
    const g = geometry();
    const L = g.L;
    if (!prev || prev.zone === 'home' || m.zone === 'home') return null;
    if (prev.zone === 'safe' && m.zone === 'safe') {
      const pts = []; for (let k = prev.pos + 1; k <= m.pos; k++) pts.push(g.safe[m.owner][k]); return pts.length ? pts : null;
    }
    if (prev.zone !== 'track') return null;
    if (m.zone === 'safe') {
      const pts = []; for (let d = prev.pos + 1; d <= L - 2; d++) pts.push(g.track[(m.owner * g.cpp + d) % L]);
      for (let k = 0; k <= m.pos; k++) pts.push(g.safe[m.owner][k]);
      return pts.length <= 20 ? pts : null;
    }
    const fwd = (m.pos - prev.pos + L) % L, back = (prev.pos - m.pos + L) % L;
    if (fwd >= 1 && fwd <= 13) { const pts = []; for (let k = 1; k <= fwd; k++) pts.push(g.track[(m.owner * g.cpp + prev.pos + k) % L]); return pts; }
    if (back >= 1 && back <= 4) { const pts = []; for (let k = 1; k <= back; k++) pts.push(g.track[(m.owner * g.cpp + prev.pos - k + L) % L]); return pts; }
    return null; // jack swap and other jumps: straight slide
  }

  function animateMarble(el, m, p) {
    const prev = prevPos.get(m.id);
    const target = `translate(${p.x}px, ${p.y}px)`;
    const changed = prev && (prev.zone !== m.zone || prev.pos !== m.pos);
    if (!changed || !prev) { el.style.transform = target; return; }
    el.getAnimations().forEach((a) => a.cancel());
    const from = marblePos(prev.zone === 'home' ? { ...m, zone: 'home' } : { ...m, zone: prev.zone, pos: prev.pos });
    const fromT = `translate(${from.x}px, ${from.y}px)`;
    el.style.transition = 'none';
    if (m.zone === 'home' && prev.zone !== 'home') {
      // killed: knocked off the hole away from the centre, spinning and fading, then drops back into home
      const dx = from.x - 500, dy = from.y - 500, dl = Math.hypot(dx, dy) || 1;
      const kx = from.x + (dx / dl) * 70, ky = from.y + (dy / dl) * 70 - 30;
      el.style.transform = fromT;
      fxBurst(from, '#ff6b5e');
      const a = el.animate([
        { transform: `${fromT} scale(1) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${kx}px, ${ky}px) scale(1.25) rotate(260deg)`, opacity: .9, offset: .55 },
        { transform: `translate(${kx + (dx / dl) * 30}px, ${ky + 60}px) scale(.4) rotate(420deg)`, opacity: 0 },
      ], { duration: 620, easing: 'cubic-bezier(.3,.6,.6,1)' });
      a.onfinish = () => { el.style.transform = target; el.animate([{ transform: `${target} translateY(-40px) scale(1.2)`, opacity: 0 }, { transform: `${target} translateY(0) scale(1)`, opacity: 1, offset: .6 }, { transform: `${target} scale(1.15, .85)`, offset: .75 }, { transform: `${target} scale(1)` }], { duration: 480, easing: 'ease-out' }); };
      return;
    }
    const pts = pathPoints(prev, m);
    if (pts) {
      // one visible jump per hole: the marble rises and grows (closer to the eye), then lands with a squash
      const frames = [{ transform: `${fromT} scale(1)` }];
      let last = from;
      for (const q of pts) {
        frames.push({ transform: `translate(${(last.x + q.x) / 2}px, ${(last.y + q.y) / 2 - 16}px) scale(1.45)`, easing: 'ease-in' });
        frames.push({ transform: `translate(${q.x}px, ${q.y}px) scale(1.12, .9)`, easing: 'ease-out' });
        last = q;
      }
      frames.push({ transform: `${target} scale(1)` });
      const dur = Math.min(1500, 90 + pts.length * 115);
      el.style.transform = target;
      const a = el.animate(frames, { duration: dur, easing: 'linear' });
      a.onfinish = () => { fxRipple(p); if (m.zone === 'safe') fxSparkle(p); };
      return;
    }
    // exit from home, swap, or anything else: an arc with a lift, then a ripple
    el.style.transform = target;
    const a = el.animate([{ transform: `${fromT} scale(1)` }, { transform: `translate(${(from.x + p.x) / 2}px, ${(from.y + p.y) / 2 - 24}px) scale(1.5)` }, { transform: `${target} scale(1.1, .9)`, offset: .9 }, { transform: `${target} scale(1)` }], { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)' });
    a.onfinish = () => fxRipple(p);
  }

  // ---------- board effects (SVG) ----------
  const NS = 'http://www.w3.org/2000/svg';
  function fxRipple(p) {
    const fx = $('fx'); if (!fx || reducedMotion) return;
    const g = geometry();
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', g.rc); c.setAttribute('fill', 'none'); c.setAttribute('stroke', '#ffe6a8'); c.setAttribute('stroke-width', '3');
    fx.appendChild(c);
    c.animate([{ r: g.rc, opacity: .9 }, { r: g.rc * 2.6, opacity: 0 }], { duration: 520, easing: 'ease-out' }).onfinish = () => c.remove();
  }
  function fxSparkle(p) {
    const fx = $('fx'); if (!fx || reducedMotion) return;
    for (let i = 0; i < 6; i++) {
      const t = document.createElementNS(NS, 'text');
      t.textContent = '✦'; t.setAttribute('x', p.x); t.setAttribute('y', p.y); t.setAttribute('fill', '#ffe08a'); t.setAttribute('font-size', 14 + Math.random() * 10); t.setAttribute('text-anchor', 'middle');
      fx.appendChild(t);
      const a = (i / 6) * Math.PI * 2 + Math.random();
      t.animate([{ transform: 'translate(0,0) scale(.4)', opacity: 1 }, { transform: `translate(${Math.cos(a) * 46}px, ${Math.sin(a) * 46 - 20}px) scale(1.2)`, opacity: 0 }], { duration: 800 + Math.random() * 300, easing: 'ease-out' }).onfinish = () => t.remove();
    }
  }
  function fxBurst(p, color) {
    const fx = $('fx'); if (!fx || reducedMotion) return;
    for (let i = 0; i < 10; i++) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 3 + Math.random() * 3); c.setAttribute('fill', color);
      fx.appendChild(c);
      const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 40;
      c.animate([{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d}px)`, opacity: 0 }], { duration: 500 + Math.random() * 300, easing: 'ease-out' }).onfinish = () => c.remove();
    }
  }
  function moveSpot(seat) {
    const sp = $('spot'); if (!sp) return;
    const g = geometry();
    const b = g.track[(seat * g.cpp) % g.L];
    sp.style.transition = reducedMotion ? 'none' : 'transform .7s cubic-bezier(.2,.8,.2,1)';
    sp.style.transform = `translate(${b.x - 500}px, ${b.y - 500}px)`;
  }

  function renderMarbles() {
    const g = geometry();
    const grp = $('marbles');
    const picks = nextPicks().filter((p) => p.type === 'marble').map((p) => p.value);
    const pickSet = new Set(picks);
    const last = state.lastMove ? new Set([state.lastMove.marbleId, state.lastMove.targetId].filter(Boolean)) : new Set();
    const existing = new Map([...grp.querySelectorAll('g.marble')].map((el) => [el.dataset.id, el]));
    for (const m of state.marbles) {
      const p = marblePos(m);
      let el = existing.get(m.id);
      if (!el) {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        el.classList.add('marble'); el.dataset.id = m.id;
        const r = g.rc * 0.92;
        el.innerHTML = `<circle class="hit" r="${g.rc * 1.9}" fill="transparent"/><circle class="halo" r="0" fill="none" stroke="#ffd369" stroke-width="3"/>
          <circle class="ring" r="${g.rc * 1.1}" fill="none" stroke="none"/>
          <g filter="url(#mshadow)"><circle class="body" r="${r}" fill="url(#mg${m.owner})"/></g>
          <ellipse rx="${r * .32}" ry="${r * .2}" cx="${-r * .35}" cy="${-r * .42}" fill="rgba(255,255,255,.85)" transform="rotate(-30 ${-r * .35} ${-r * .42})"/>
          <circle r="${r * .1}" cx="${r * .3}" cy="${r * .35}" fill="rgba(255,255,255,.35)"/>`;
        el.onclick = () => {
          const cur = marbleById(m.id);
          if (!cur) return;
          if (el.classList.contains('pick')) pick(cur.id);
          // not pickable: the marble covers its hole, so treat the tap as a tap on that hole (e.g. a lit kill destination)
          else if (cur.zone !== 'home') tapTarget(cur.owner, cur.zone, cur.pos);
        };
        el.onmouseenter = () => { if (el.classList.contains('pick')) { hoverMarble = m.id; renderTargets(); } };
        el.onmouseleave = () => { if (hoverMarble === m.id) { hoverMarble = null; renderTargets(); } };
        grp.appendChild(el);
      }
      animateMarble(el, m, p);
      el.classList.toggle('pick', pickSet.has(m.id));
      el.classList.toggle('last', last.has(m.id));
      existing.delete(m.id);
    }
    for (const el of existing.values()) el.remove();
    for (const id of picks) { const el = grp.querySelector(`g.marble[data-id="${id}"]`); if (el) grp.appendChild(el); }
    prevPos = new Map(state.marbles.map((m) => [m.id, { owner: m.owner, zone: m.zone, pos: m.pos }]));
  }

  // ---------- reactions, confetti, card flight ----------
  const EMOJIS = ['👏', '😂', '🔥', '😡', '🙏', '🎉', '😱', '🤝'];
  function showReaction(seat, emoji, name) {
    const g = state && state.phase !== 'lobby' ? geometry() : null;
    const grp = $('bubbles');
    if (g && grp) {
      const lp = g.label[seat];
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('class', 'bubble'); t.setAttribute('x', lp.x); t.setAttribute('y', lp.y - 18);
      t.style.transformOrigin = `${lp.x}px ${lp.y}px`; t.style.transformBox = 'view-box';
      t.textContent = emoji;
      grp.appendChild(t);
      setTimeout(() => t.remove(), 2300);
    }
    tone(520 + seat * 40, 0.08, 'sine', 0.05);
  }
  $('reactions').innerHTML = EMOJIS.map((e) => `<button type="button" data-e="${e}" title="react">${e}</button>`).join('');
  $('reactions').querySelectorAll('button').forEach((b) => (b.onclick = () => { send({ type: 'react', emoji: b.dataset.e }); $('reactions').classList.add('hidden'); }));
  $('btnReact').onclick = () => $('reactions').classList.toggle('hidden');

  function confetti(ms = 3500) {
    const c = $('confetti'); const ctx = c.getContext('2d');
    c.width = innerWidth; c.height = innerHeight; c.classList.remove('hidden');
    const cols = ['#ffd369', '#d8372a', '#2a6fd8', '#2f9a4a', '#fff', '#ff8a7a'];
    const ps = Array.from({ length: 160 }, () => ({ x: Math.random() * c.width, y: -20 - Math.random() * c.height * .5, vx: (Math.random() - .5) * 2, vy: 2 + Math.random() * 3.5, s: 6 + Math.random() * 8, r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3, col: cols[Math.floor(Math.random() * cols.length)] }));
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const p of ps) { p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.col; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); }
      if (t - t0 < ms) requestAnimationFrame(frame); else { c.classList.add('hidden'); ctx.clearRect(0, 0, c.width, c.height); }
    })(t0);
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Jacks: black Jacks are SWAP cards; red Jacks move 11 (with complex cards off every Jack swaps)
  function jackKind(c) {
    if (c.rank !== 'J') return null;
    const red = c.suit === 'H' || c.suit === 'D';
    const complex = !state || !state.settings || state.settings.complexCards !== false;
    return red && complex ? 'eleven' : 'swap';
  }
  function cardHint(c) {
    const jk = jackKind(c);
    if (jk === 'swap') return HINT.J;
    if (jk === 'eleven') return HINT.J11;
    return HINT[c.rank] || '';
  }
  function cardInner(c) {
    if (c.rank === 'JOKER') return `<div class="r">★</div><div class="s">JOKER</div><div class="b">★</div>`;
    const jk = jackKind(c);
    if (jk === 'swap') return `<div class="r">J</div><div class="s swap"><span class="g">⇄</span><span class="w">SWAP</span></div><div class="b">J</div>`;
    if (jk === 'eleven') return `<div class="r">J<span class="eleven">11</span></div><div class="s">${SUIT[c.suit]}</div><div class="b">J</div>`;
    return `<div class="r">${c.rank}</div><div class="s">${SUIT[c.suit]}</div><div class="b">${c.rank}</div>`;
  }
  function cardFaceHTML(c) {
    const red = c.suit === 'H' || c.suit === 'D';
    return `<div class="pcard${red ? ' red' : ''}${c.rank === 'JOKER' ? ' joker' : ''}${jackKind(c) === 'swap' ? ' swapcard' : ''}" style="margin:0">${cardInner(c)}</div>`;
  }
  function rectOfSeat(seat) {
    const chip = document.querySelector(`.seat-chip[data-seat="${seat}"]`);
    return chip ? chip.getBoundingClientRect() : null;
  }
  function rectOfDeck() { const r = document.querySelector('#piles rect.pile-card:nth-of-type(2)'); return r ? r.getBoundingClientRect() : null; }
  // a card back flies from one rect to another; optional flip reveals `card` halfway
  function flyBetween(from, to, { card = null, delay = 0, duration = 600, fade = false, size = 1 } = {}) {
    if (!from || !to || reducedMotion) return;
    const w = 52 * size, h = 74 * size;
    const el = document.createElement('div');
    el.className = 'flycard cardback';
    el.style.cssText = `left:${from.left + from.width / 2 - w / 2}px;top:${from.top + from.height / 2 - h / 2}px;width:${w}px;height:${h}px;transition:none;opacity:0`;
    $('flyLayer').appendChild(el);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const rot = (Math.random() - .5) * 30;
    setTimeout(() => {
      el.style.opacity = '1';
      const a = el.animate([
        { transform: 'translate(0,0) rotate(0deg) scaleX(1)' },
        { transform: `translate(${dx * .5}px, ${dy * .5 - 40}px) rotate(${rot / 2}deg) scaleX(${card ? 0 : 1})`, offset: .5 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg) scaleX(1)`, opacity: fade ? .15 : 1 },
      ], { duration, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
      if (card) setTimeout(() => { el.classList.remove('cardback'); el.innerHTML = cardFaceHTML(card); }, duration * .5);
      a.onfinish = () => setTimeout(() => el.remove(), 120);
    }, delay);
  }
  function dealAnimation(perSeat) {
    const deck = rectOfDeck(); if (!deck || reducedMotion) return;
    const mySeat = you ? you.seat : -1;
    let k = 0;
    const n = state.settings.players;
    for (let round = 0; round < perSeat; round++) {
      for (let i = 1; i <= n; i++) {
        const seat = (state.dealer + i) % n;
        if (seat === mySeat) {
          const cardEl = $('hand').children[round];
          if (cardEl) flyBetween(deck, cardEl.getBoundingClientRect(), { delay: k * 70, duration: 520, size: 1 });
        } else {
          flyBetween(deck, rectOfSeat(seat), { delay: k * 70, duration: 520, fade: true, size: .6 });
        }
        k++;
      }
    }
    sfx.deal();
  }
  function flyCard(cardEl) {
    const from = cardEl.getBoundingClientRect();
    const pile = $('discardCard'); if (!pile) return;
    const to = pile.getBoundingClientRect();
    const clone = cardEl.cloneNode(true);
    clone.classList.remove('sel'); clone.classList.add('flycard');
    clone.style.left = from.left + 'px'; clone.style.top = from.top + 'px'; clone.style.width = from.width + 'px'; clone.style.height = from.height + 'px'; clone.style.margin = 0;
    $('flyLayer').appendChild(clone);
    requestAnimationFrame(() => {
      const sx = to.width / from.width, sy = to.height / from.height;
      clone.style.transform = `translate(${to.left - from.left + (to.width - from.width) / 2}px, ${to.top - from.top + (to.height - from.height) / 2}px) scale(${sx}, ${sy}) rotate(${(Math.random() - .5) * 20}deg)`;
      clone.style.opacity = '0.2';
    });
    setTimeout(() => clone.remove(), 600);
  }

  function renderGame() {
    const n = state.settings.players;
    if ($('board').dataset.key !== boardKey || !$('marbles')) { geometry(); drawBoardStatic(); }
    for (let seat = 0; seat < n; seat++) {
      const t = $('lbl' + seat);
      const p = state.players.find((x) => x.seat === seat);
      t.textContent = (p ? p.name : '') + (p && p.finished ? ' ✓' : '');
      t.classList.toggle('turn', state.phase === 'playing' && state.turn === seat);
    }
    const mySeat = you ? you.seat : null;
    const myTurn = you && state.phase === 'playing' && state.turn === mySeat;
    $('centerText').textContent = state.phase === 'finished' ? `Team ${TEAM_NAMES[state.winner]} wins` : (state.phase === 'playing' ? (myTurn ? 'Your turn' : `${nameOf(state.turn)}'s turn`) : '');
    $('centerSub').textContent = state.phase === 'finished' ? state.players.filter((p) => p.team === state.winner).map((p) => p.name).join(' & ') : `Deal ${state.dealNo}`;
    $('stockCnt').textContent = state.stockCount;
    const ring = $('turnRing');
    if (state.phase === 'playing') { const bp = geometry().track[(state.turn * geometry().cpp) % geometry().L]; ring.setAttribute('cx', bp.x); ring.setAttribute('cy', bp.y); ring.style.display = ''; } else ring.style.display = 'none';
    const dt = state.discardTop;
    $('discardCard').setAttribute('opacity', dt ? 1 : 0);
    $('discardTxt').textContent = dt ? (dt.rank === 'JOKER' ? '★' : dt.rank + SUIT[dt.suit]) : '';
    $('discardTxt').setAttribute('fill', dt && (dt.suit === 'H' || dt.suit === 'D') ? '#c0392b' : '#1a1a1a');

    const banner = $('turnBanner');
    if (state.phase === 'finished') { banner.textContent = `Game over. Team ${TEAM_NAMES[state.winner]} wins!`; banner.className = 'turn-banner'; }
    else if (!you) { banner.textContent = `Watching. ${nameOf(state.turn)} to play.`; banner.className = 'turn-banner'; }
    else if (myTurn) { banner.textContent = you.controls !== mySeat ? `Your turn — you move ${nameOf(you.controls)}'s marbles` : 'Your turn'; banner.className = 'turn-banner mine'; }
    else { banner.textContent = `${nameOf(state.turn)} is thinking`; banner.className = 'turn-banner thinking'; }

    // seat chips: avatar, name, cards left, turn glow; placed over the board's name plates
    const g = geometry();
    const seatsEl = $('seats');
    seatsEl.innerHTML = '';
    for (let seat = 0; seat < n; seat++) {
      const p = state.players.find((x) => x.seat === seat);
      const lp = g.label[seat];
      const d = document.createElement('div');
      d.className = 'seat-chip' + (state.turn === seat && state.phase === 'playing' ? ' turn' : '') + (p && !p.isBot && !p.connected ? ' off' : '') + (p && p.finished ? ' done' : '');
      d.style.left = `${((lp.x + 30) / 1060 * 100).toFixed(2)}%`;
      d.style.top = `${((lp.y + 30) / 1060 * 100).toFixed(2)}%`;
      d.title = `Team ${TEAM_NAMES[seat % (n / 2)]}${p && p.isBot ? ' · bot' : ''}`;
      d.dataset.name = p ? p.name : '';
      d.dataset.seat = seat;
      if (lp.rot != null) { if (lp.rot) d.style.transform = `translate(-50%, -50%) rotate(${lp.rot}deg)`; }
      else if (lp.angle != null && !lp.horizontal) d.style.transform = `translate(-50%, -50%) rotate(${lp.angle < 0 ? -90 : 90}deg)`;
      d.innerHTML = `<span class="av" style="background:${seatColor(seat)}">${esc(p ? initials(p.name) : '')}</span><span class="nm">${esc(p ? (seat === mySeat ? 'You' : p.name) : '')}</span><span class="team">${TEAM_NAMES[seat % (n / 2)]}</span><span class="cnt">${state.handCounts[seat] ?? 0}</span>`;
      seatsEl.appendChild(d);
      $('lbl' + seat).textContent = '';
    }
    $('hudCode').textContent = state.code;

    // hand
    const hand = $('hand');
    hand.innerHTML = '';
    const pr = $('prompt');
    let promptSet = false;
    if (you && you.hand) {
      const playable = new Set((you.legalMoves || []).map((m) => m.cardId));
      const onlyBurn = (you.legalMoves || []).length > 0 && you.legalMoves.every((m) => m.kind === 'burn');
      const fresh = state.dealNo !== lastDealNo;
      you.hand.forEach((c, idx) => {
        const el = document.createElement('div');
        const red = c.suit === 'H' || c.suit === 'D';
        if (fresh && !reducedMotion) { el.classList.add('dealin'); el.style.animationDelay = `${420 + idx * 70 * n}ms`; }
        el.className += ' pcard' + (red ? ' red' : '') + (c.rank === 'JOKER' ? ' joker' : '') + (jackKind(c) === 'swap' ? ' swapcard' : '') + (sel.cardId === c.id ? ' sel' : '') + (myTurn && !playable.has(c.id) ? ' dead' : '');
        el.title = cardHint(c);
        el.innerHTML = cardInner(c);
        el.onclick = () => {
          if (!myTurn || !playable.has(c.id)) return;
          sel = sel.cardId === c.id ? { cardId: null, picks: [] } : { cardId: c.id, picks: [] };
          hoverMarble = null;
          if (!(sel.cardId && tryCommit())) renderGame();
        };
        hand.appendChild(el);
      });
      const cards = [...hand.children];
      cards.forEach((el, i) => { const k = i - (cards.length - 1) / 2; el.style.transform = `rotate(${(k * 4).toFixed(1)}deg) translateY(${(Math.abs(k) * 4).toFixed(1)}px)`; });
      if (onlyBurn && myTurn && !sel.cardId) {
        pr.innerHTML = state.pendingBurn === mySeat ? '<b>A 10 was played on you.</b> Pick a card to burn. Your turn is then over.' : '<b>No legal move.</b> Pick a card to burn.';
        promptSet = true;
      }
    }

    // prompt
    if (myTurn && sel.cardId) {
      const picks = nextPicks();
      const marblePicks = picks.filter((p) => p.type === 'marble');
      const optPicks = picks.filter((p) => p.type === 'option');
      const card = you.hand.find((c) => c.id === sel.cardId);
      let html = `<b>${card ? (card.rank === 'JOKER' ? 'Joker' : card.rank + SUIT[card.suit]) : ''}</b>`;
      const cands = candidateMoves().filter((m) => m.kind !== 'burn');
      const sevenD = cands.length && cands.every((m) => m.kind === 'seven') ? sevenDepth(cands[0], sel.picks.length) : -1;
      if (sevenD === 0) html = '<b>7</b> · tap the first marble (you can split the 7)';
      else if (sevenD === 1) html = '<b>7</b> · tap where it stops (the rest goes to another marble)';
      else if (sevenD === 2) html = `<b>7</b> · now tap the second marble (it moves ${cands[0].parts[1].steps})`;
      else {
        if (marblePicks.length) html += ' · ' + (sel.picks.length === 0 ? 'tap a glowing marble or a lit hole' : 'now tap the second marble');
        if (optPicks.length) html += `<div class="opts">${optPicks.map((p) => `<button class="secondary" data-v="${esc(p.value)}">${esc(p.label)}</button>`).join('')}</div>`;
      }
      html += ` <button class="link" id="btnCancel">cancel</button>`;
      pr.innerHTML = html;
      pr.querySelectorAll('button[data-v]').forEach((b) => (b.onclick = () => pick(b.dataset.v)));
      $('btnCancel').onclick = () => { sel = { cardId: null, picks: [] }; hoverMarble = null; renderGame(); };
    } else if (!promptSet) {
      pr.innerHTML = myTurn ? 'Pick a card. Dimmed cards have no legal move.' : '';
    }

    renderMarbles();
    renderTargets();

    // log & chat
    $('log').innerHTML = state.log.slice(-60).reverse().map((l) => `<div class="${/sends .* home|wins!/.test(l.text) ? 'kill' : ''}">${esc(l.text)}</div>`).join('');
    if (lastLogT) {
      for (const l of state.log) if (l.t > lastLogT && /sends .* home|wins!|^Deal |must burn|burns .* from|forced by/.test(l.text)) toast(l.text, /sends .* home|wins!/.test(l.text));
    }
    lastLogT = state.log.length ? state.log[state.log.length - 1].t : lastLogT;


    renderFairness();
    $('btnRematch').classList.toggle('hidden', !(state.phase === 'finished' && state.hostId === playerId));

    // sounds
    if (state.lastMove && state.lastMove.at !== lastMoveAt) {
      if (lastMoveAt) {
        const txt = state.log.length ? state.log[state.log.length - 1].text : '';
        const lm = state.lastMove;
        // which marbles this move sent home (compare zones with the previous render; the old "last two log lines"
        // check also fired on the move AFTER a kill)
        const sentHome = lastZones ? state.marbles.filter((m) => m.zone === 'home' && lastZones.has(m.id) && lastZones.get(m.id) !== 'home') : [];
        const killed = lastZones ? sentHome.length > 0 : state.log.slice(-1).some((l) => /sends .* home/.test(l.text));
        if (lm.seat !== mySeat && lm.kind !== 'tenBurn' && lm.kind !== 'queenBurn') flyBetween(rectOfSeat(lm.seat), $('discardCard').getBoundingClientRect(), { card: lm.card, duration: 650, fade: lm.kind === 'burn', size: .9 });
        if (lm.kind === 'queenBurn' && lm.burned) flyBetween(rectOfSeat(nextSeatOf(lm.seat)), $('discardCard').getBoundingClientRect(), { card: lm.burned, duration: 700, fade: true, size: .9 });
        // marbles of mine (or of the partner I am playing for) that this move sent home
        const isMine = (owner) => you && (owner === mySeat || owner === you.controls);
        const killedMine = sentHome.filter((m) => isMine(m.owner));
        const swapMine = lm.kind === 'jack' && [lm.marbleId, lm.targetId].some((id) => { const m = state.marbles.find((x) => x.id === id); return m && isMine(m.owner); });
        if (state.phase === 'finished') { sfx.win(); confetti(); showWin(); }
        else if (killedMine.length) sfx.killedMine(lm.seat === mySeat ? '' : nameOf(lm.seat), killedMine.length);
        else if (killed) sfx.kill();
        else if (lm.kind === 'jack') sfx.swap(swapMine);
        else if (/^Deal /.test(txt)) { sfx.move(); setTimeout(() => dealAnimation(you && you.hand ? you.hand.length : 4), 250); }
        else sfx.move();
        lastSoundAt = Date.now();
        for (const e of [$('discardCard'), $('discardTxt')]) { e.classList.remove('discard-pop'); void e.getBoundingClientRect(); e.classList.add('discard-pop'); }
        // zoomed in on a phone: bring someone else's move into view
        if (lm.seat !== mySeat && typeof revealMove === 'function') revealMove(lm);
      }
      lastMoveAt = state.lastMove.at;
    }
    const moveJustSounded = lastZones && state.lastMove && state.lastMove.at === lastMoveAt && Date.now() - lastSoundAt < 200;
    lastZones = new Map(state.marbles.map((m) => [m.id, m.zone]));
    if (myTurn && !wasMyTurn && lastMoveAt) {
      // let the last move's sound (and buzz) finish first, so the two do not blur into one
      setTimeout(sfx.turn, moveJustSounded ? 650 : 0);
      if (document.hidden) document.title = '▶ Your turn · Jackaroo';
      if (typeof revealMySide === 'function') setTimeout(revealMySide, 1800); // give the player time to see the last move first
    }
    wasMyTurn = !!myTurn;
    if (state.phase === 'playing') moveSpot(state.turn);
    if (state.dealNo !== lastDealNo && lastDealNo === 0 && state.phase === 'playing') setTimeout(() => dealAnimation(you && you.hand ? you.hand.length : 5), 700);
    lastDealNo = state.dealNo;
  }
  function nextSeatOf(seat) { return (seat + 1) % state.settings.players; }
  function showWin() {
    const t = state.winner;
    const names = state.players.filter((p) => p.team === t).map((p) => p.name).join(' & ');
    const mine = you && (you.seat % (state.settings.players / 2)) === t;
    const el = document.createElement('div');
    el.className = 'win-banner';
    el.innerHTML = `<div class="trophy">🏆</div><div class="wt">${mine ? 'You win!' : `Team ${TEAM_NAMES[t]} wins`}</div><div class="wn">${esc(names)}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 5000);
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function renderFairness() {
    const f = $('fairness');
    let h = `<p>The server shuffles every deck with a cryptographic random generator and publishes <code>SHA-256(salt:order)</code> before dealing. When the deck is used up the salt and order are revealed, so anyone can check the deal was fixed in advance and never changed.</p>`;
    if (state.deckCommit) h += `<div class="deck"><b>Current deck</b> (${state.deckCommit.cards} cards)<br/>commitment <code>${state.deckCommit.hash}</code></div>`;
    state.deckHistory.slice().reverse().forEach((d, i) => {
      h += `<div class="deck"><b>Revealed deck</b> <code>${d.hash.slice(0, 16)}…</code> <button class="link" data-i="${i}">verify</button> <span id="ver${i}"></span><br/><code>${esc(d.order)}</code></div>`;
    });
    f.innerHTML = h;
    f.querySelectorAll('button[data-i]').forEach((b) => (b.onclick = async () => {
      const d = state.deckHistory.slice().reverse()[Number(b.dataset.i)];
      const hash = await sha256(`${d.salt}:${d.order}`);
      $('ver' + b.dataset.i).innerHTML = hash === d.hash ? '<span class="ok">✓ matches</span>' : '<span class="error">✗ MISMATCH</span>';
    }));
  }

  $('btnRematch').onclick = () => send({ type: 'rematch' });
  function openPanel(tab) {
    $('panel').classList.remove('hidden');
    document.querySelectorAll('.panel-tabs .tab').forEach((b) => b.classList.toggle('sel', b.dataset.tab === tab));
    $('tabLog').classList.toggle('hidden', tab !== 'log');
    $('tabFair').classList.toggle('hidden', tab !== 'fair');
  }
  $('btnPanel').onclick = () => { if ($('panel').classList.contains('hidden')) openPanel('log'); else $('panel').classList.add('hidden'); };
  $('btnPanelClose').onclick = () => $('panel').classList.add('hidden');
  document.querySelectorAll('.panel-tabs .tab').forEach((b) => (b.onclick = () => openPanel(b.dataset.tab)));

  function render() {
    if (!state) return;
    document.body.classList.toggle('in-game', state.phase !== 'lobby');
    if (state.phase === 'lobby') { showScreen('Lobby'); renderLobby(); }
    else {
      const wasHidden = $('screenGame').classList.contains('hidden');
      showScreen('Game');
      if (wasHidden) { const st = document.querySelector('.board-stage'); st.classList.remove('intro'); void st.offsetWidth; st.classList.add('intro'); setTimeout(() => st.classList.remove('intro'), 1400); }
      if (state.phase !== 'playing' || !you || state.turn !== you.seat) { sel = { cardId: null, picks: [] }; hoverMarble = null; }
      renderGame();
      if (wasHidden) requestAnimationFrame(() => fitLayout(true)); // sizes need the visible screen (and the player count)
    }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- boot ----------
  renderRecent();
  try { $('homeArt').innerHTML = previewMarkup('jj', 'home_'); } catch { /* decorative */ }
  const qg = new URLSearchParams(location.search).get('g') || (location.pathname.match(/\/g\/([A-Za-z0-9]{3,12})/) || [])[1];
  if (qg) {
    const c = qg.toUpperCase();
    $('code').value = c;
    const t = store.token(c);
    if (t) { code = c; token = t; } // auto-rejoin on open
  }
  if (/iphone|ipad|android/i.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches) $('installHint').classList.remove('hidden');
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (MODE === 'p2p') $('p2pNote').classList.remove('hidden');
  startTransport();
})();
