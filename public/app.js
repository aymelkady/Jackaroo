/* Jackaroo client. Talks JSON over a WebSocket; the server owns all rules. */
(() => {
  const $ = (id) => document.getElementById(id);
  const TEAM_COLORS = [['#d8372a', '#ff8a7a'], ['#2a6fd8', '#8fbcff'], ['#2f9a4a', '#9be0a8'], ['#e6b43a', '#fff0a0']];
  const TEAM_NAMES = ['A', 'B', 'C', 'D'];
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const HINT = {
    A: 'Exit a marble, or move 1 or 11', K: 'Exit a marble, or move 13 and kill on the way', Q: 'Move 12; red Queen may burn a card from the next player', J: 'Black: swap with another player\'s marble. Red: move 11',
    10: 'Move 10, or make the next player burn a card', 9: 'Move 9', 8: 'Move 8', 7: 'Move 7, or split between two marbles', 6: 'Move 6', 5: 'Move any marble 5', 4: 'Move 4 backwards', 3: 'Move 3', 2: 'Move 2', JOKER: 'Play as any card',
  };

  let code = null, token = null, playerId = null;
  let state = null, you = null;
  let sel = { cardId: null, picks: [] };
  let hoverMarble = null;
  let boardKey = '';      // geometry cache key
  let geo = null;
  let lastMoveAt = 0, wasMyTurn = false, lastDealNo = 0;
  let prevPos = new Map(); // marble id -> {owner, zone, pos} as last rendered
  let scrolledFor = null;
  let lastLogT = 0, seenChat = 0;
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
  const sfx = {
    move() { tone(900, 0.07, 'triangle', 0.08); tone(600, 0.09, 'triangle', 0.06, 0.05); },
    kill() { tone(160, 0.25, 'sawtooth', 0.1); tone(90, 0.3, 'square', 0.06, 0.05); },
    turn() { tone(660, 0.12, 'sine', 0.1); tone(990, 0.18, 'sine', 0.1, 0.12); if (navigator.vibrate) navigator.vibrate([60, 40, 60]); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.12, i * 0.14)); },
    deal() { for (let i = 0; i < 4; i++) tone(1200 + i * 80, 0.04, 'square', 0.03, i * 0.06); },
  };
  $('btnSound').textContent = store.sound ? '🔊' : '🔇';
  $('btnSound').onclick = () => { store.sound = !store.sound; $('btnSound').textContent = store.sound ? '🔊' : '🔇'; if (store.sound) sfx.move(); };

  // ---------- transport: WebSocket to the Node server, or peer-to-peer when hosted statically ----------
  const MODE = window.JK_MODE === 'server' ? 'server' : 'p2p';
  let transport = null;
  let pendingJoin = null; // message to send once the connection opens
  function setStatus(state, text) {
    $('connDot').className = 'dot ' + (state === 'on' ? 'on' : state === 'wait' ? '' : 'off');
    $('netStatus').textContent = text || '';
  }
  function onOpen() {
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
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
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
    lastLogT = 0; seenChat = 0;
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
      div.style.borderColor = TEAM_COLORS[team][seat < n / 2 ? 0 : 1];
      const col = TEAM_COLORS[team][seat < n / 2 ? 0 : 1];
      div.innerHTML = `<div class="av" style="background:${col}">${p ? esc(initials(p.name)) : '·'}</div><div>
        <div class="team" style="color:${TEAM_COLORS[team][0]}">Seat ${seat + 1} · Team ${TEAM_NAMES[team]}</div>
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
  function seatColor(seat) { const n = state.settings.players; return TEAM_COLORS[seat % (n / 2)][seat < n / 2 ? 0 : 1]; }
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
  const DESIGNS = {
    saudi: { label: 'Saudi cross', sub: 'the real board: walnut, gold inlay', shape: 'cross', pattern: null, center: 'oval', ...WOOD_SAUDI },
    andalus: { label: 'Andalus walnut', sub: 'square, brass inlay', shape: 'square', pattern: 'girih', ...WOOD_ANDALUS },
    andalus8: { label: 'Andalus octagon', sub: 'eight sides, brass inlay', shape: 'octagon', pattern: 'girih', ...WOOD_ANDALUS },
    ebony: { label: 'Ebony & pearl', sub: 'square, mother-of-pearl', shape: 'square', pattern: 'pearl', ...WOOD_EBONY },
    oaksq: { label: 'Plain oak', sub: 'square, no inlay', shape: 'square', pattern: null, ...WOOD_OAK },
    oak: { label: 'Classic round', sub: 'the original board', shape: 'round', pattern: null, ...WOOD_OAK },
  };
  function designId() { const d = localStorage.getItem('jk.design'); return DESIGNS[d] ? d : 'saudi'; }
  function design() { return DESIGNS[designId()]; }

  // ---------- geometry ----------
  // The track is a closed rounded polygon; cells sit at equal arc-length steps along it,
  // starting at the bottom centre (the viewer's own base) and running clockwise.
  function shapeVertices(shape, half) {
    const cx = 500, cy = 500;
    if (shape === 'square') return { r: half * 0.3, v: [[cx - half, cy + half], [cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half]] };
    if (shape === 'cross') { // clipped-corner square body
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
  const CROSS_W = 0.34; // arm half-width as a fraction of the arm length
  function plusVertices(half) {
    const A = half, w = Math.round(half * CROSS_W), c = 500;
    return [[c, c + A], [c - w, c + A], [c - w, c + w], [c - A, c + w], [c - A, c - w], [c - w, c - w], [c - w, c - A], [c + w, c - A], [c + w, c - w], [c + A, c - w], [c + A, c + w], [c + w, c + w], [c + w, c + A]];
  }
  function plusPath(half, r = 14) {
    const v = plusVertices(half); const n = v.length; let d = '';
    for (let i = 0; i < n; i++) {
      const p = v[i], q = v[(i + 1) % n], o = v[(i - 1 + n) % n];
      const u1 = unit(o, p), u2 = unit(p, q);
      // concave corners stay sharp, convex ones get a small radius
      const cross = u1[0] * u2[1] - u1[1] * u2[0];
      const rr = cross > 0 ? r : 0;
      const a = [p[0] - u1[0] * rr, p[1] - u1[1] * rr], b = [p[0] + u2[0] * rr, p[1] + u2[1] * rr];
      d += (i === 0 ? `M ${a[0]} ${a[1]} ` : `L ${a[0]} ${a[1]} `) + (rr ? `Q ${p[0]} ${p[1]} ${b[0]} ${b[1]} ` : '');
    }
    return d + 'Z';
  }
  function unit(a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; }
  function densePath(shape, half) {
    const pts = [];
    if (shape === 'round') {
      for (let i = 0; i < 2000; i++) { const a = Math.PI / 2 + (i / 2000) * 2 * Math.PI; pts.push([500 + half * Math.cos(a), 500 + half * Math.sin(a)]); }
    } else if (shape === 'cross') {
      const v = plusVertices(half); const n = v.length;
      for (let i = 0; i < n; i++) { const p = v[i], q = v[(i + 1) % n]; for (let k = 0; k < 120; k++) { const t = k / 120; pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); } }
    } else {
      const { r, v } = shapeVertices(shape, half);
      const n = v.length;
      for (let i = 0; i < n; i++) {
        const p = v[i], q = v[(i + 1) % n], o = v[(i - 1 + n) % n];
        const u1 = unit(o, p), u2 = unit(p, q);
        const a = [p[0] - u1[0] * r, p[1] - u1[1] * r], b = [p[0] + u2[0] * r, p[1] + u2[1] * r];
        for (let k = 0; k < 40; k++) { const t = k / 40; pts.push([(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * p[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * p[1] + t * t * b[1]]); }
        const c = [q[0] - u2[0] * r, q[1] - u2[1] * r];
        for (let k = 0; k < 200; k++) { const t = k / 200; pts.push([b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t]); }
      }
      // rotate so the path starts at the bottom centre
      let best = 0, bd = Infinity;
      pts.forEach((p, i) => { const d = Math.hypot(p[0] - 500, p[1] - (500 + half)); if (d < bd) { bd = d; best = i; } });
      pts.push(...pts.splice(0, best));
    }
    const cum = [0];
    for (let i = 1; i <= pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i % pts.length][0] - pts[i - 1][0], pts[i % pts.length][1] - pts[i - 1][1]));
    return { pts, cum, P: cum[pts.length] };
  }
  function frameAt(dp, s) {
    const { pts, cum, P } = dp;
    s = ((s % P) + P) % P;
    let lo = 0, hi = pts.length;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[(lo + 1) % pts.length];
    const seg = cum[lo + 1] - cum[lo] || 1, t = (s - cum[lo]) / seg;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    const c = pts[(lo + 8) % pts.length], o = pts[(lo - 8 + pts.length) % pts.length];
    let tx = c[0] - o[0], ty = c[1] - o[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    let nx = -ty, ny = tx; // inward normal
    if ((500 - x) * nx + (500 - y) * ny < 0) { nx = -nx; ny = -ny; }
    return { x, y, tx, ty, nx, ny };
  }
  function computeGeometry(s, mySeat, shape) {
    const n = s.players, cpp = s.cellsPerPlayer, L = n * cpp;
    const half = shape === 'round' ? 400 : shape === 'octagon' ? 452 : shape === 'cross' ? 430 : 425;
    const dp = densePath(shape, half);
    const spacing = dp.P / L;
    const rc = Math.min(22, spacing * 0.44);
    const gap = rc * 2.45;
    const sAt = (i) => (i - mySeat * cpp) * spacing;
    const track = [], frames = [];
    for (let i = 0; i < L; i++) { const f = frameAt(dp, sAt(i)); track.push({ x: f.x, y: f.y }); frames.push(f); }
    const safe = [], home = [], label = [];
    if (shape === 'cross') {
      // real board: base at the tip of each arm, safe column down the arm's middle, start pen on the
      // diagonal between this arm and the next, name plate between the column and the centre oval
      const w = Math.round(half * CROSS_W);
      for (let seat = 0; seat < n; seat++) {
        const fb = frames[seat * cpp];
        const at = (inward, ahead) => ({ x: fb.x + fb.nx * inward + fb.tx * ahead, y: fb.y + fb.ny * inward + fb.ty * ahead });
        safe.push(Array.from({ length: s.safeCells }, (_, k) => at(gap * (k + 1.1), 0)));
        const corner = at(half - w, w); // concave corner ahead (clockwise) of this arm
        const ux = (fb.tx - fb.nx) / Math.SQRT2, uy = (fb.ty - fb.ny) / Math.SQRT2; // outward diagonal
        const vx = (fb.tx + fb.nx) / Math.SQRT2, vy = (fb.ty + fb.ny) / Math.SQRT2; // along the pen
        const pc = { x: corner.x + ux * gap * 2.95, y: corner.y + uy * gap * 2.95 };
        home.push([0, 1, 2, 3].map((k) => ({ x: pc.x + vx * (k - 1.5) * gap * 0.92, y: pc.y + vy * (k - 1.5) * gap * 0.92 })));
        const inwardDist = (gap * 5.1 + (half - w)) / 2; // midway between column end (5.1 gap from tip) and the centre square edge
        label.push({ ...at(inwardDist, 0), horizontal: Math.abs(fb.ty) > 0.7, angle: Math.atan2(fb.ty, fb.tx) * 180 / Math.PI });
      }
      return { L, cx: 500, cy: 500, rc, gap, half, shape, track, frames, safe, home, label, cpp, n, w };
    }
    for (let seat = 0; seat < n; seat++) {
      // the safe zone branches off the hole just BEFORE the base (where a marble enters after its lap),
      // so the base itself is never on the way into the safe zone
      const fe = frames[(seat * cpp - 1 + L) % L];
      const fb = frames[seat * cpp];
      const atE = (inward, ahead) => ({ x: fe.x + fe.nx * inward + fe.tx * ahead, y: fe.y + fe.ny * inward + fe.ty * ahead });
      const atB = (inward, ahead) => ({ x: fb.x + fb.nx * inward + fb.tx * ahead, y: fb.y + fb.ny * inward + fb.ty * ahead });
      safe.push(Array.from({ length: s.safeCells }, (_, k) => atE(gap * (k + 1), 0)));
      // home tray: inside the board, just ahead of the base
      home.push([atB(gap * 1.15, gap * 1.4), atB(gap * 1.15, gap * 2.4), atB(gap * 2.15, gap * 1.4), atB(gap * 2.15, gap * 2.4)]);
      label.push({ ...atB(gap * 3.35, gap * 1.9), horizontal: Math.abs(fb.ty) > 0.7 });
    }
    return { L, cx: 500, cy: 500, rc, gap, half, shape, track, frames, safe, home, label, cpp, n };
  }
  function geometry() {
    const s = state.settings;
    const mySeat = you ? you.seat : 0;
    const key = `${s.players}-${s.cellsPerPlayer}-${s.safeCells}-${mySeat}-${designId()}`;
    if (boardKey === key) return geo;
    const shape = design().shape === 'cross' && s.players !== 4 ? 'octagon' : design().shape; // the cross board is a 4-player board
    geo = computeGeometry(s, mySeat, shape);
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

  function boardMarkup(g, d, idp, seatColorOf) {
    const n = g.n;
    const shapeHalf = g.half + g.rc * 3.2;
    const bodyPath = roundedPolyPath(g.shape, shapeHalf);
    const rimPath = roundedPolyPath(g.shape, shapeHalf + 14);
    const innerPath = roundedPolyPath(g.shape, shapeHalf - 4);
    const isCross = g.shape === 'cross';
    const trackPath = isCross ? plusPath(g.half) : roundedPolyPath(g.shape, g.half);
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
    for (let seat = 0; seat < n; seat++) {
      const c = seatColorOf(seat);
      h += `<radialGradient id="${idp}mg${seat}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="${shade(c, 0.75)}"/><stop offset=".25" stop-color="${shade(c, 0.25)}"/><stop offset=".7" stop-color="${c}"/><stop offset="1" stop-color="${shade(c, -0.55)}"/></radialGradient>`;
    }
    h += `</defs>`;
    // body
    h += `<path d="${rimPath}" fill="url(#${idp}rimGrad)"/>`;
    h += `<path d="${bodyPath}" fill="url(#${idp}woodGrad)" filter="url(#${idp}woodgrain)"/>`;
    if (d.pattern) h += `<path d="${bodyPath}" fill="url(#${idp}inlay)"/>`;
    h += `<path d="${innerPath}" fill="none" stroke="url(#${idp}brass)" stroke-width="2.5" stroke-opacity=".85"/>`;
    h += `<path d="${roundedPolyPath(g.shape, shapeHalf - 11)}" fill="none" stroke="${d.accent}" stroke-width="1" stroke-opacity=".35"/>`;
    if (isCross) {
      // carrying handles cut into the sides, like the real board
      for (const sx of [-1, 1]) h += `<rect x="${500 + sx * (shapeHalf - 34) - 10}" y="${500 - 42}" width="20" height="84" rx="10" fill="#0d0805" stroke="${d.accent}" stroke-opacity=".6"/>`;
      // gold inlay outline on both sides of the track
      h += `<path d="${trackPath}" fill="none" stroke="url(#${idp}brass)" stroke-width="${g.rc * 3.3}" stroke-linejoin="round"/>`;
      h += `<path d="${trackPath}" fill="none" stroke="${d.wood[1]}" stroke-width="${g.rc * 3.3 - 4}" stroke-linejoin="round"/>`;
      h += `<path d="${trackPath}" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="${g.rc * 2.6}" stroke-linejoin="round"/>`;
      // centre oval
      h += `<ellipse cx="500" cy="500" rx="${(g.w * 0.92).toFixed(0)}" ry="${(g.w * 0.68).toFixed(0)}" fill="url(#${idp}brass)" stroke="${shade(d.accent, -0.45)}" stroke-width="2"/>`;
      h += `<ellipse cx="500" cy="500" rx="${(g.w * 0.92 - 6).toFixed(0)}" ry="${(g.w * 0.68 - 6).toFixed(0)}" fill="none" stroke="rgba(255,240,200,.45)" stroke-width="1"/>`;
    } else {
      // track groove (wider band, slightly darker) + hairline
      h += `<path d="${trackPath}" fill="none" stroke="rgba(0,0,0,.2)" stroke-width="${g.rc * 2.9}" stroke-linejoin="round"/>`;
      h += `<path d="${trackPath}" fill="none" stroke="${d.accent}" stroke-opacity=".18" stroke-width="1"/>`;
      // centre medallion
      const R1 = Math.min(175, g.half - g.gap * 4.8), R2 = R1 * 0.42;
      let star = '';
      for (let k = 0; k < 16; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 8, r = k % 2 ? R2 : R1; star += `${(500 + r * Math.cos(a)).toFixed(1)},${(500 + r * Math.sin(a)).toFixed(1)} `; }
      h += `<polygon points="${star}" fill="rgba(0,0,0,.14)" stroke="url(#${idp}brass)" stroke-width="2" stroke-opacity=".7"/>`;
      h += `<circle cx="500" cy="500" r="${R1 * 1.08}" fill="none" stroke="${d.accent}" stroke-width="1" stroke-opacity=".35" stroke-dasharray="6 5"/>`;
    }
    // holes
    let nums = '';
    const ring = isCross ? `stroke:${d.accent};stroke-width:1.4;` : '';
    const hole = (p, r, extra = '') => `<circle class="hole" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="url(#${idp}holeGrad)" filter="url(#${idp}inset)" style="${ring}" ${extra}/>`;
    g.track.forEach((p, i) => {
      const isBase = i % g.cpp === 0;
      const seat = i / g.cpp;
      h += isBase ? hole(p, g.rc * 1.12).replace('style="', `style="stroke:${seatColorOf(seat)};stroke-width:3;`) : hole(p, g.rc, `data-abs="${i}"`);
      if (!isBase) nums += `<text class="num" x="${p.x.toFixed(1)}" y="${(p.y + g.rc * 0.38).toFixed(1)}" style="font-size:${(g.rc * 0.95).toFixed(1)}px;fill:${d.num}">${i % g.cpp}</text>`;
      else nums += `<text class="num" x="${p.x.toFixed(1)}" y="${(p.y + g.rc * 0.45).toFixed(1)}" style="font-size:${(g.rc * 1.1).toFixed(1)}px;fill:${seatColorOf(seat)};opacity:.9">★</text>`;
    });
    for (let seat = 0; seat < n; seat++) {
      const c = seatColorOf(seat);
      if (isCross) {
        // inlay outlines around the safe column and the start pen
        const sc = g.safe[seat], f = g.frames[seat * g.cpp];
        const mid = { x: (sc[0].x + sc[3].x) / 2, y: (sc[0].y + sc[3].y) / 2 };
        const len = Math.hypot(sc[3].x - sc[0].x, sc[3].y - sc[0].y) + g.rc * 3.4, wid = g.rc * 3.2;
        const rot = Math.atan2(f.ny, f.nx) * 180 / Math.PI;
        h += `<rect x="${(mid.x - len / 2).toFixed(1)}" y="${(mid.y - wid / 2).toFixed(1)}" width="${len.toFixed(1)}" height="${wid.toFixed(1)}" rx="${(wid / 2).toFixed(1)}" fill="rgba(0,0,0,.18)" stroke="url(#${idp}brass)" stroke-width="2" transform="rotate(${rot.toFixed(1)} ${mid.x.toFixed(1)} ${mid.y.toFixed(1)})"/>`;
        const hp = g.home[seat];
        const hm = { x: (hp[0].x + hp[3].x) / 2, y: (hp[0].y + hp[3].y) / 2 };
        const hl = Math.hypot(hp[3].x - hp[0].x, hp[3].y - hp[0].y) + g.rc * 3.2;
        const hr = Math.atan2(hp[3].y - hp[0].y, hp[3].x - hp[0].x) * 180 / Math.PI;
        h += `<rect x="${(hm.x - hl / 2).toFixed(1)}" y="${(hm.y - wid / 2).toFixed(1)}" width="${hl.toFixed(1)}" height="${wid.toFixed(1)}" rx="${(wid / 2).toFixed(1)}" fill="rgba(0,0,0,.18)" stroke="url(#${idp}brass)" stroke-width="2" transform="rotate(${hr.toFixed(1)} ${hm.x.toFixed(1)} ${hm.y.toFixed(1)})"/>`;
        hp.forEach((p) => { h += hole(p, g.rc * 0.95); });
        // name plate: gold tablet between the column and the centre
        const lp = g.label[seat];
        const pw = g.gap * 2.9, ph = g.rc * 2.3;
        const prot = Math.abs(f.ny) > 0.7 ? 0 : (f.nx > 0 ? -90 : 90);
        h += `<rect x="${(lp.x - pw / 2).toFixed(1)}" y="${(lp.y - ph / 2).toFixed(1)}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" rx="${(ph / 2).toFixed(1)}" fill="url(#${idp}brass)" stroke="${shade(d.accent, -0.45)}" stroke-width="1.5" transform="rotate(${prot} ${lp.x.toFixed(1)} ${lp.y.toFixed(1)})"/>`;
        h += `<text id="${idp}lbl${seat}" class="lbl plate" x="${lp.x.toFixed(1)}" y="${(lp.y + 6).toFixed(1)}" transform="rotate(${prot} ${lp.x.toFixed(1)} ${lp.y.toFixed(1)})" style="fill:#2a1709;stroke:none;font-size:${(g.rc * 0.95).toFixed(1)}px"></text>`;
        g.safe[seat].forEach((p, k) => { h += hole(p, g.rc).replace('style="', `style="stroke:${c};stroke-width:2;`); nums += `<text class="num" x="${p.x.toFixed(1)}" y="${(p.y + g.rc * 0.38).toFixed(1)}" style="font-size:${(g.rc * 0.85).toFixed(1)}px;fill:${c};opacity:.75">${k + 1}</text>`; });
        continue;
      }
      g.safe[seat].forEach((p, k) => { h += hole(p, g.rc).replace('style="', `style="stroke:${c};stroke-width:1.8;`); nums += `<text class="num" x="${p.x.toFixed(1)}" y="${(p.y + g.rc * 0.38).toFixed(1)}" style="font-size:${(g.rc * 0.85).toFixed(1)}px;fill:${c};opacity:.75">${k + 1}</text>`; });
      const hp = g.home[seat];
      const mx = (hp[0].x + hp[3].x) / 2, my = (hp[0].y + hp[3].y) / 2;
      const f = g.frames[seat * g.cpp];
      const rot = Math.atan2(f.ty, f.tx) * 180 / Math.PI;
      const w = g.gap * 2.1, hgt = g.gap * 2.1;
      h += `<rect x="${(mx - w / 2).toFixed(1)}" y="${(my - hgt / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${hgt.toFixed(1)}" rx="${(g.rc * 0.9).toFixed(1)}" fill="rgba(0,0,0,.22)" stroke="${c}" stroke-opacity=".5" transform="rotate(${rot.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)})"/>`;
      hp.forEach((p) => { h += hole(p, g.rc * 0.95); });
      const lp = g.label[seat];
      h += `<text id="${idp}lbl${seat}" class="lbl" x="${lp.x.toFixed(1)}" y="${(lp.y + 7).toFixed(1)}" style="fill:${c};font-size:${Math.max(14, g.rc * 1.15).toFixed(1)}px"></text>`;
    }
    h += nums;
    return h;
  }

  function drawBoardStatic() {
    const g = geometry();
    const d = design();
    const svg = $('board');
    let h = boardMarkup(g, d, '', seatColor);
    // centre: title, status, piles
    const oval = d.center === 'oval' && g.shape === 'cross';
    if (oval) h += `<text class="center-title" x="500" y="452" style="fill:#2a1709;fill-opacity:.55;font-size:18px;letter-spacing:3px">JACKAROO</text>`;
    else h += `<text class="center-title" x="500" y="430" style="fill:${d.accent};fill-opacity:.6">JACKAROO</text>`;
    h += oval
      ? `<text id="centerText" class="center-text" x="500" y="482" style="fill:#2a1709;stroke:none;font-size:22px"></text><text id="centerSub" class="center-sub" x="500" y="502" style="fill:#4a2d14;stroke:none;font-size:13px"></text>`
      : `<text id="centerText" class="center-text" x="500" y="478"></text><text id="centerSub" class="center-sub" x="500" y="506"></text>`;
    const cw = oval ? 44 : 54, ch = oval ? 62 : 76, py = oval ? 512 : 536;
    h += `<g id="piles">
      <rect class="pile-card" x="${500 - cw - 10 + 3}" y="${py + 3}" width="${cw}" height="${ch}" rx="6" opacity=".6" fill="url(#cardBack)"/>
      <rect class="pile-card" x="${500 - cw - 10}" y="${py}" width="${cw}" height="${ch}" rx="6" fill="url(#cardBack)"/>
      <rect x="${500 - cw - 10 + 5}" y="${py + 5}" width="${cw - 10}" height="${ch - 10}" rx="4" fill="none" stroke="rgba(255,220,180,.5)" stroke-dasharray="3 2"/>
      <text id="stockCnt" class="pile-cnt" x="${500 - cw / 2 - 10}" y="${py + ch / 2 + 5}"></text>
      <rect id="discardCard" class="pile-face" x="${500 + 10}" y="${py}" width="${cw}" height="${ch}" rx="6" opacity="0"/>
      <text id="discardTxt" class="pile-txt" x="${500 + 10 + cw / 2}" y="${py + ch / 2 + 8}"></text>
    </g>`;
    h += `<circle id="turnRing" class="turn-ring" r="20" cx="-100" cy="-100"/><g id="targets"></g><g id="marbles"></g><g id="bubbles"></g>`;
    svg.innerHTML = h;
    svg.dataset.key = boardKey;
  }

  // ---------- design picker ----------
  function previewMarkup(id, idp) {
    const d = DESIGNS[id];
    const g = computeGeometry({ players: 4, cellsPerPlayer: 19, safeCells: 4, marblesPerPlayer: 4 }, 0, d.shape);
    const col = (seat) => TEAM_COLORS[seat % 2][seat < 2 ? 0 : 1];
    let h = boardMarkup(g, d, idp, col);
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
  function setZoom(on) {
    const w = document.querySelector('.board-wrap');
    w.classList.toggle('zoomed', on);
    localStorage.setItem('jk.zoom', on ? '1' : '0');
    if (on) requestAnimationFrame(() => { w.scrollLeft = (w.scrollWidth - w.clientWidth) / 2; w.scrollTop = w.scrollHeight - w.clientHeight; });
  }
  $('btnZoom').onclick = () => setZoom(!document.querySelector('.board-wrap').classList.contains('zoomed'));
  if (innerWidth <= 900 && localStorage.getItem('jk.zoom') !== '0') setZoom(true); // phones start zoomed on your own side

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
  function destinationsOf(mv) {
    const out = [];
    const kills = new Set(mv.kills || []);
    const add = (owner, to, viaMarble) => { if (to) out.push({ owner, zone: to.zone, pos: to.pos, kill: kills.size > 0 && viaMarble }); };
    if (mv.kind === 'jack') { add(marbleById(mv.marbleId).owner, { zone: 'track', pos: mv.toA }); add(marbleById(mv.targetId).owner, { zone: 'track', pos: mv.toB }); }
    else if (mv.kind === 'seven') for (const p of mv.parts) add(marbleById(p.marbleId).owner, p.to, true);
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
      for (const d of destinationsOf(mv)) {
        const k = `${d.owner}-${d.zone}-${d.pos}`;
        if (seen.has(k)) continue; seen.add(k);
        const p = cellPos(d.owner, d.zone, d.pos);
        h += `<circle class="target${d.kill ? ' kill' : ''}" data-owner="${d.owner}" data-zone="${d.zone}" data-pos="${d.pos}" cx="${p.x}" cy="${p.y}" r="${g.rc * 1.45}" filter="url(#glow)"/>`;
      }
    }
    grp.innerHTML = h;
    // tapping a lit hole plays the move that ends there (when that is unambiguous)
    grp.querySelectorAll('circle.target').forEach((c) => (c.onclick = () => tapTarget(Number(c.dataset.owner), c.dataset.zone, Number(c.dataset.pos))));
    // on phones, bring the lit holes into view once per card selection
    if (sel.cardId && scrolledFor !== sel.cardId && innerWidth <= 900) {
      scrolledFor = sel.cardId;
      const first = grp.querySelector('circle.target');
      if (first) {
        const r = first.getBoundingClientRect();
        const visibleBottom = innerHeight - 180;
        if (r.top < 60 || r.bottom > visibleBottom) window.scrollBy({ top: r.top - visibleBottom / 2, behavior: 'smooth' });
      }
    }
  }
  function tapTarget(owner, zone, pos) {
    const depth = sel.picks.length;
    const cands = candidateMoves().filter((mv) => destinationsOf(mv).some((d) => d.owner === owner && d.zone === zone && d.pos === pos));
    if (!cands.length) return;
    if (cands.length === 1) { sel.picks = cands[0].picks.map((p) => p.value); if (!tryCommit()) renderGame(); return; }
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
      const pts = []; for (let d = prev.pos + 1; d <= L - 1; d++) pts.push(g.track[(m.owner * g.cpp + d) % L]);
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
      // killed: shrink away where it stood, then reappear at home
      el.style.transform = fromT;
      const a = el.animate([{ transform: `${fromT} scale(1)`, opacity: 1 }, { transform: `${fromT} scale(0)`, opacity: 0 }], { duration: 320, easing: 'ease-in' });
      a.onfinish = () => { el.style.transform = target; el.animate([{ transform: `${target} scale(0)` }, { transform: `${target} scale(1)` }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' }); };
      return;
    }
    const pts = pathPoints(prev, m);
    if (pts) {
      const frames = [{ transform: `${fromT} scale(1)` }];
      let last = from;
      for (const q of pts) {
        frames.push({ transform: `translate(${(last.x + q.x) / 2}px, ${(last.y + q.y) / 2 - 6}px) scale(1.28)` });
        frames.push({ transform: `translate(${q.x}px, ${q.y}px) scale(1)` });
        last = q;
      }
      const dur = Math.min(1400, 70 + pts.length * 95);
      el.style.transform = target;
      el.animate(frames, { duration: dur, easing: 'linear' });
      return;
    }
    // exit from home, swap, or anything else: smooth slide with a lift
    el.style.transform = target;
    el.animate([{ transform: `${fromT} scale(1)` }, { transform: `translate(${(from.x + p.x) / 2}px, ${(from.y + p.y) / 2}px) scale(1.35)` }, { transform: `${target} scale(1)` }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
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
        el.onclick = () => { if (el.classList.contains('pick')) pick(m.id); };
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
    const chat = $('chat');
    if (chat) { chat.insertAdjacentHTML('beforeend', `<div><b>${esc(name)}</b> ${emoji}</div>`); chat.scrollTop = chat.scrollHeight; }
    tone(520 + seat * 40, 0.08, 'sine', 0.05);
  }
  $('reactions').innerHTML = EMOJIS.map((e) => `<button type="button" data-e="${e}" title="react">${e}</button>`).join('');
  $('reactions').querySelectorAll('button').forEach((b) => (b.onclick = () => send({ type: 'react', emoji: b.dataset.e })));

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
      if (lp.angle != null && !lp.horizontal) d.style.transform = `translate(-50%, -50%) rotate(${lp.angle < 0 ? -90 : 90}deg)`;
      d.innerHTML = `<span class="av" style="background:${seatColor(seat)}">${esc(p ? initials(p.name) : '')}</span><span class="nm">${esc(p ? (seat === mySeat ? 'You' : p.name) : '')}</span><span class="cnt">${state.handCounts[seat] ?? 0}</span>`;
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
        if (fresh) { el.classList.add('dealin'); el.style.animationDelay = `${idx * 90}ms`; }
        el.className += ' pcard' + (red ? ' red' : '') + (c.rank === 'JOKER' ? ' joker' : '') + (sel.cardId === c.id ? ' sel' : '') + (myTurn && !playable.has(c.id) ? ' dead' : '');
        el.title = HINT[c.rank] || '';
        el.innerHTML = c.rank === 'JOKER' ? `<div class="r">★</div><div class="s">JOKER</div><div class="b">★</div>` : `<div class="r">${c.rank}</div><div class="s">${SUIT[c.suit]}</div><div class="b">${c.rank}</div>`;
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
        pr.innerHTML = state.pendingBurn === mySeat ? '<b>A 10 was played on you.</b> Pick a card to burn, then you play.' : '<b>No legal move.</b> Pick a card to burn.';
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
      if (marblePicks.length) html += ' · ' + (sel.picks.length === 0 ? 'tap a glowing marble or a lit hole' : 'now tap the second marble');
      if (optPicks.length) html += `<div class="opts">${optPicks.map((p) => `<button class="secondary" data-v="${esc(p.value)}">${esc(p.label)}</button>`).join('')}</div>`;
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
      for (const l of state.log) if (l.t > lastLogT) toast(l.text, /sends .* home|wins!/.test(l.text));
    }
    lastLogT = state.log.length ? state.log[state.log.length - 1].t : lastLogT;
    if ($('panel').classList.contains('hidden') && state.chat.length > seenChat) { $('chatBadge').textContent = state.chat.length - seenChat; $('chatBadge').classList.remove('hidden'); }
    const chat = $('chat');
    const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 10;
    chat.innerHTML = state.chat.map((c) => `<div><b style="color:${seatColor(c.seat)}">${esc(c.name)}:</b>${esc(c.text)}</div>`).join('');
    if (atBottom) chat.scrollTop = chat.scrollHeight;

    renderFairness();
    $('btnRematch').classList.toggle('hidden', !(state.phase === 'finished' && state.hostId === playerId));

    // sounds
    if (state.lastMove && state.lastMove.at !== lastMoveAt) {
      if (lastMoveAt) {
        const txt = state.log.length ? state.log[state.log.length - 1].text : '';
        const killed = state.log.slice(-2).some((l) => /sends .* home/.test(l.text));
        if (state.phase === 'finished') { sfx.win(); confetti(); }
        else if (killed) sfx.kill();
        else if (/^Deal /.test(txt)) { sfx.move(); sfx.deal(); }
        else sfx.move();
        for (const e of [$('discardCard'), $('discardTxt')]) { e.classList.remove('discard-pop'); void e.getBoundingClientRect(); e.classList.add('discard-pop'); }
      }
      lastMoveAt = state.lastMove.at;
    }
    if (myTurn && !wasMyTurn && lastMoveAt) sfx.turn();
    wasMyTurn = !!myTurn;
    lastDealNo = state.dealNo;
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

  $('chatForm').onsubmit = (e) => { e.preventDefault(); const t = $('chatInput').value.trim(); if (t) send({ type: 'chat', text: t }); $('chatInput').value = ''; };
  $('btnRematch').onclick = () => send({ type: 'rematch' });
  function openPanel(tab) {
    $('panel').classList.remove('hidden');
    document.querySelectorAll('.panel-tabs .tab').forEach((b) => b.classList.toggle('sel', b.dataset.tab === tab));
    $('tabLog').classList.toggle('hidden', tab !== 'log');
    $('tabChat').classList.toggle('hidden', tab !== 'chat');
    $('tabFair').classList.toggle('hidden', tab !== 'fair');
    if (tab === 'chat' && state) { seenChat = state.chat.length; $('chatBadge').classList.add('hidden'); const c = $('chat'); c.scrollTop = c.scrollHeight; }
  }
  $('btnPanel').onclick = () => { if ($('panel').classList.contains('hidden')) openPanel($('chatBadge').classList.contains('hidden') ? 'log' : 'chat'); else $('panel').classList.add('hidden'); };
  $('btnPanelClose').onclick = () => $('panel').classList.add('hidden');
  document.querySelectorAll('.panel-tabs .tab').forEach((b) => (b.onclick = () => openPanel(b.dataset.tab)));

  function render() {
    if (!state) return;
    document.body.classList.toggle('in-game', state.phase !== 'lobby');
    if (state.phase === 'lobby') { showScreen('Lobby'); renderLobby(); }
    else {
      const wasHidden = $('screenGame').classList.contains('hidden');
      showScreen('Game');
      if (state.phase !== 'playing' || !you || state.turn !== you.seat) { sel = { cardId: null, picks: [] }; hoverMarble = null; }
      renderGame();
      if (wasHidden) requestAnimationFrame(() => { const w = document.querySelector('.board-wrap'); if (w.classList.contains('zoomed')) { w.scrollLeft = (w.scrollWidth - w.clientWidth) / 2; w.scrollTop = w.scrollHeight - w.clientHeight; } });
    }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- boot ----------
  renderRecent();
  try { $('homeArt').innerHTML = previewMarkup('saudi', 'home_'); } catch { /* decorative */ }
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
