/* Jackaroo client. Talks JSON over a WebSocket; the server owns all rules. */
(() => {
  const $ = (id) => document.getElementById(id);
  const TEAM_COLORS = [['#d8372a', '#ff8a7a'], ['#2a6fd8', '#8fbcff'], ['#2f9a4a', '#9be0a8'], ['#e6b43a', '#fff0a0']];
  const TEAM_NAMES = ['A', 'B', 'C', 'D'];
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const HINT = {
    A: 'Exit a marble, or move 1 or 11', K: 'Exit a marble, or move 13 and kill on the way', Q: 'Move 12', J: 'Swap with another player\'s marble',
    10: 'Move 10', 9: 'Move 9', 8: 'Move 8', 7: 'Move 7, or split between two marbles', 6: 'Move 6', 5: 'Move any marble 5', 4: 'Move 4 backwards', 3: 'Move 3', 2: 'Move 2', JOKER: 'Play as any card',
  };

  let code = null, token = null, playerId = null;
  let state = null, you = null;
  let sel = { cardId: null, picks: [] };
  let hoverMarble = null;
  let boardKey = '';      // geometry cache key
  let geo = null;
  let lastMoveAt = 0, wasMyTurn = false, lastDealNo = 0;
  let prevPos = new Map(); // marble id -> {owner, zone, pos} as last rendered

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
    send({ type: 'create', name, settings: { players: Number($('players').value), randomTeams: $('optRandomTeams').checked, kingKills: $('optKing').checked, fiveMovesAny: $('optFive').checked, jokers: $('optJokers').checked } });
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
      div.innerHTML = `<div class="team" style="color:${TEAM_COLORS[team][0]}">Seat ${seat + 1} · Team ${TEAM_NAMES[team]}</div>
        <div class="who">${p ? esc(p.name) : '<span class="muted">empty — tap to sit</span>'}</div>
        <div class="status">${p ? (p.isBot ? 'bot' : p.connected ? 'online' : 'offline') : ''}${p && p.id === state.hostId ? ' · host' : ''}</div>`;
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
        <label class="chk"><input type="checkbox" id="lsJokers" ${s.jokers ? 'checked' : ''}/> jokers</label>`;
      const push = () => send({ type: 'settings', settings: { players: Number($('lsPlayers').value), randomTeams: $('lsRandom').checked, kingKills: $('lsKing').checked, fiveMovesAny: $('lsFive').checked, jokers: $('lsJokers').checked } });
      for (const id of ['lsPlayers', 'lsRandom', 'lsKing', 'lsFive', 'lsJokers']) $(id).onchange = push;
    } else {
      st.innerHTML = `<span class="muted">${s.players} players · ${s.randomTeams ? 'random teams' : 'chosen seats'} · King 13 ${s.kingKills ? 'on' : 'off'} · 5 any ${s.fiveMovesAny ? 'on' : 'off'} · jokers ${s.jokers ? 'on' : 'off'}</span>`;
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

  // ---------- geometry ----------
  function geometry() {
    const s = state.settings;
    const n = s.players, cpp = s.cellsPerPlayer, L = n * cpp;
    const mySeat = you ? you.seat : 0;
    const key = `${n}-${cpp}-${s.safeCells}-${mySeat}`;
    if (boardKey === key) return geo;
    const cx = 500, cy = 500, Rt = 380;
    const step = (2 * Math.PI) / L;
    const rc = Math.min(14.5, (Rt * step) * 0.44);
    // rotate the board so the viewer's own base sits at the bottom
    const ang = (i) => Math.PI / 2 + (i - mySeat * cpp) * step;
    const pt = (a, r) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    const track = [];
    for (let i = 0; i < L; i++) track.push(pt(ang(i), Rt));
    const safe = [], home = [], label = [];
    const gap = rc * 2.6;
    for (let seat = 0; seat < n; seat++) {
      const a = ang(seat * cpp);
      safe.push(Array.from({ length: s.safeCells }, (_, k) => pt(a, Rt - gap * (k + 1))));
      const spread = Math.min(step * 1.6, 0.11);
      const homeR = Rt + Math.max(24, rc * 2.4);
      home.push(Array.from({ length: s.marblesPerPlayer }, (_, k) => pt(a + (k - 1.5) * spread, homeR)));
      label.push(pt(a, homeR + rc * 2 + 24));
    }
    geo = { L, cx, cy, Rt, rc, track, safe, home, label, cpp };
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

  function drawBoardStatic() {
    const g = geometry();
    const svg = $('board');
    const n = state.settings.players;
    const R = g.Rt + Math.max(24, g.rc * 2.4) + g.rc * 2 + 48; // board edge
    let h = `<defs>
      <radialGradient id="woodGrad" cx="45%" cy="40%" r="70%"><stop offset="0" stop-color="#c99a63"/><stop offset=".55" stop-color="#a9743f"/><stop offset="1" stop-color="#6e4420"/></radialGradient>
      <linearGradient id="rimGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a4a22"/><stop offset=".5" stop-color="#3d2410"/><stop offset="1" stop-color="#6a3f1c"/></linearGradient>
      <radialGradient id="holeGrad" cx="40%" cy="35%" r="65%"><stop offset="0" stop-color="#3a2614"/><stop offset=".6" stop-color="#1b110a"/><stop offset="1" stop-color="#4a3118"/></radialGradient>
      <linearGradient id="cardBack" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8e2b2b"/><stop offset="1" stop-color="#5a1414"/></linearGradient>
      <filter id="woodgrain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.004 0.13" numOctaves="5" seed="11" result="noise"/>
        <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.27  0 0 0 0 0.12  0 0 0 0.8 0" result="grain"/>
        <feComposite in="grain" in2="SourceGraphic" operator="in" result="clipped"/>
        <feBlend in="SourceGraphic" in2="clipped" mode="multiply"/>
      </filter>
      <filter id="inset" x="-20%" y="-20%" width="140%" height="140%">
        <feOffset dx="0" dy="2" in="SourceAlpha" result="o"/><feGaussianBlur in="o" stdDeviation="1.5" result="b"/>
        <feComposite in="b" in2="SourceAlpha" operator="out" result="s"/><feFlood flood-color="#000" flood-opacity=".7"/><feComposite in2="s" operator="in" result="sh"/>
        <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="sh"/></feMerge>
      </filter>
      <filter id="mshadow" x="-60%" y="-60%" width="240%" height="240%"><feDropShadow dx="1.5" dy="3" stdDeviation="1.6" flood-color="#000" flood-opacity=".55"/></filter>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
    for (let seat = 0; seat < n; seat++) {
      const c = seatColor(seat);
      h += `<radialGradient id="mg${seat}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="${shade(c, 0.75)}"/><stop offset=".25" stop-color="${shade(c, 0.25)}"/><stop offset=".7" stop-color="${c}"/><stop offset="1" stop-color="${shade(c, -0.55)}"/></radialGradient>`;
    }
    h += `</defs>`;
    // board body
    h += `<circle cx="${g.cx}" cy="${g.cy}" r="${R + 14}" fill="url(#rimGrad)"/>`;
    h += `<circle cx="${g.cx}" cy="${g.cy}" r="${R}" fill="url(#woodGrad)" filter="url(#woodgrain)"/>`;
    h += `<circle cx="${g.cx}" cy="${g.cy}" r="${R - 3}" fill="none" stroke="rgba(255,220,170,.25)" stroke-width="2"/>`;
    // track groove
    h += `<circle cx="${g.cx}" cy="${g.cy}" r="${g.Rt}" fill="none" stroke="rgba(0,0,0,.16)" stroke-width="${g.rc * 2.8}"/>`;
    h += `<circle cx="${g.cx}" cy="${g.cy}" r="${g.Rt}" fill="none" stroke="rgba(255,235,200,.12)" stroke-width="1"/>`;
    // holes
    let nums = '';
    g.track.forEach((p, i) => {
      const isBase = i % g.cpp === 0;
      const seat = i / g.cpp;
      h += `<circle class="hole${isBase ? ' base-ring' : ''}" data-abs="${i}" cx="${p.x}" cy="${p.y}" r="${isBase ? g.rc * 1.12 : g.rc}" ${isBase ? `style="stroke:${seatColor(seat)}"` : ''} filter="url(#inset)"/>`;
      if (!isBase) nums += `<text class="num" x="${p.x}" y="${p.y + g.rc * 0.38}" style="font-size:${(g.rc * 0.95).toFixed(1)}px">${i % g.cpp}</text>`;
      else nums += `<text class="num" x="${p.x}" y="${p.y + g.rc * 0.45}" style="font-size:${(g.rc * 1.1).toFixed(1)}px;fill:${seatColor(seat)};opacity:.9">★</text>`;
    });
    for (let seat = 0; seat < n; seat++) {
      const c = seatColor(seat);
      g.safe[seat].forEach((p, k) => { h += `<circle class="hole" cx="${p.x}" cy="${p.y}" r="${g.rc}" style="stroke:${c};stroke-width:1.8" filter="url(#inset)"/>`; nums += `<text class="num" x="${p.x}" y="${p.y + g.rc * 0.38}" style="font-size:${(g.rc * 0.85).toFixed(1)}px;fill:${c};opacity:.7">${k + 1}</text>`; });
      // home tray
      const hp = g.home[seat];
      const mx = (hp[0].x + hp[3].x) / 2, my = (hp[0].y + hp[3].y) / 2;
      const len = Math.hypot(hp[3].x - hp[0].x, hp[3].y - hp[0].y) + g.rc * 3.2;
      const rot = Math.atan2(hp[3].y - hp[0].y, hp[3].x - hp[0].x) * 180 / Math.PI;
      h += `<rect x="${mx - len / 2}" y="${my - g.rc * 1.6}" width="${len}" height="${g.rc * 3.2}" rx="${g.rc * 1.6}" fill="rgba(0,0,0,.22)" stroke="${c}" stroke-opacity=".45" transform="rotate(${rot} ${mx} ${my})"/>`;
      hp.forEach((p) => { h += `<circle class="hole" cx="${p.x}" cy="${p.y}" r="${g.rc * .95}" filter="url(#inset)"/>`; });
      const lp = g.label[seat];
      h += `<text id="lbl${seat}" class="lbl" x="${lp.x}" y="${lp.y + 7}" style="fill:${c}"></text>`;
    }
    h += nums;
    // centre: title, status, piles
    h += `<text class="center-title" x="${g.cx}" y="${g.cy - 70}">JACKAROO</text>`;
    h += `<text id="centerText" class="center-text" x="${g.cx}" y="${g.cy - 22}"></text><text id="centerSub" class="center-sub" x="${g.cx}" y="${g.cy + 6}"></text>`;
    const cw = 54, ch = 76, py = g.cy + 36;
    h += `<g id="piles">
      <rect class="pile-card" x="${g.cx - cw - 10 + 3}" y="${py + 3}" width="${cw}" height="${ch}" rx="6" opacity=".6"/>
      <rect class="pile-card" x="${g.cx - cw - 10}" y="${py}" width="${cw}" height="${ch}" rx="6"/>
      <rect x="${g.cx - cw - 10 + 5}" y="${py + 5}" width="${cw - 10}" height="${ch - 10}" rx="4" fill="none" stroke="rgba(255,220,180,.5)" stroke-dasharray="3 2"/>
      <text id="stockCnt" class="pile-cnt" x="${g.cx - cw / 2 - 10}" y="${py + ch / 2 + 5}"></text>
      <rect id="discardCard" class="pile-face" x="${g.cx + 10}" y="${py}" width="${cw}" height="${ch}" rx="6" opacity="0"/>
      <text id="discardTxt" class="pile-txt" x="${g.cx + 10 + cw / 2}" y="${py + ch / 2 + 8}"></text>
    </g>`;
    h += `<circle id="turnRing" class="turn-ring" r="20" cx="-100" cy="-100"/><g id="targets"></g><g id="marbles"></g><g id="bubbles"></g>`;
    svg.innerHTML = h;
    svg.dataset.key = boardKey;
  }

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
        h += `<circle class="target${d.kill ? ' kill' : ''}" cx="${p.x}" cy="${p.y}" r="${g.rc * 1.35}" filter="url(#glow)"/>`;
      }
    }
    grp.innerHTML = h;
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
        const r = g.rc * 0.86;
        el.innerHTML = `<circle class="halo" r="0" fill="none" stroke="#ffd369" stroke-width="3"/>
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

    // players
    const pl = $('playersList');
    pl.innerHTML = '';
    for (let seat = 0; seat < n; seat++) {
      const p = state.players.find((x) => x.seat === seat);
      const d = document.createElement('div');
      d.className = 'player' + (state.turn === seat && state.phase === 'playing' ? ' turn' : '') + (p && !p.isBot && !p.connected ? ' off' : '');
      d.innerHTML = `<span class="sw" style="background:${seatColor(seat)}"></span><span class="nm" title="Team ${TEAM_NAMES[seat % (n / 2)]}">${esc(p ? p.name : '')}${seat === mySeat ? ' (you)' : ''}${p && p.finished ? ' ✓' : ''}</span><span class="cnt">${state.handCounts[seat] ?? 0}🂠</span>`;
      pl.appendChild(d);
    }

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
      if (onlyBurn && myTurn && !sel.cardId) { pr.innerHTML = '<b>No legal move.</b> Pick a card to burn.'; promptSet = true; }
    }

    // prompt
    if (myTurn && sel.cardId) {
      const picks = nextPicks();
      const marblePicks = picks.filter((p) => p.type === 'marble');
      const optPicks = picks.filter((p) => p.type === 'option');
      const card = you.hand.find((c) => c.id === sel.cardId);
      let html = `<b>${card ? (card.rank === 'JOKER' ? 'Joker' : card.rank + SUIT[card.suit]) : ''}</b> · `;
      if (marblePicks.length) html += sel.picks.length === 0 ? 'tap a glowing marble (lit holes show where it can go)' : 'now tap the second marble';
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
    $('log').innerHTML = state.log.slice(-40).reverse().map((l) => `<div class="${/sends .* home|wins!/.test(l.text) ? 'kill' : ''}">${esc(l.text)}</div>`).join('');
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

  function render() {
    if (!state) return;
    $('topInfo').textContent = `Game ${state.code} · ${state.settings.players} players`;
    if (state.phase === 'lobby') { showScreen('Lobby'); renderLobby(); }
    else { showScreen('Game'); if (state.phase !== 'playing' || !you || state.turn !== you.seat) { sel = { cardId: null, picks: [] }; hoverMarble = null; } renderGame(); }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- boot ----------
  renderRecent();
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
