/* Jackaroo client. Talks JSON over a WebSocket; the server owns all rules. */
(() => {
  const $ = (id) => document.getElementById(id);
  const TEAM_COLORS = [['#d32f2f', '#ff8a80'], ['#1565c0', '#82b1ff'], ['#2e7d32', '#a5d6a7'], ['#f9a825', '#fff59d']];
  const TEAM_NAMES = ['A', 'B', 'C', 'D'];
  const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const HINT = {
    A: 'Exit a marble, or move 1 or 11', K: 'Exit a marble, or move 13 and kill on the way', Q: 'Move 12', J: 'Swap with another player\'s marble',
    10: 'Move 10', 9: 'Move 9', 8: 'Move 8', 7: 'Move 7, or split between two marbles', 6: 'Move 6', 5: 'Move any marble 5', 4: 'Move 4 backwards', 3: 'Move 3', 2: 'Move 2', JOKER: 'Play as any card',
  };

  let ws = null, wsReady = false, retry = 0;
  let code = null, token = null, playerId = null;
  let state = null, you = null;
  let sel = { cardId: null, picks: [] };
  let pendingJoin = null; // message to send once the socket opens
  let boardKey = '';      // geometry cache key
  let geo = null;

  // ---------- storage ----------
  const store = {
    get name() { return localStorage.getItem('jk.name') || ''; },
    set name(v) { localStorage.setItem('jk.name', v); },
    token(c) { return localStorage.getItem('jk.tok.' + c); },
    setToken(c, t) { localStorage.setItem('jk.tok.' + c, t); const r = this.recent.filter((x) => x !== c); r.unshift(c); localStorage.setItem('jk.recent', JSON.stringify(r.slice(0, 5))); },
    get recent() { try { return JSON.parse(localStorage.getItem('jk.recent') || '[]'); } catch { return []; } },
  };

  // ---------- socket ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      wsReady = true; retry = 0; $('connDot').className = 'dot on';
      if (pendingJoin) { ws.send(JSON.stringify(pendingJoin)); pendingJoin = null; }
      else if (code && token) ws.send(JSON.stringify({ type: 'join', code, token, name: store.name || 'Player' }));
    };
    ws.onclose = () => {
      wsReady = false; $('connDot').className = 'dot off';
      const wait = Math.min(8000, 500 * 2 ** retry++);
      setTimeout(connect, wait);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'joined') {
        code = msg.code; token = msg.token; playerId = msg.playerId;
        store.setToken(code, token);
        history.replaceState(null, '', '/g/' + code);
      } else if (msg.type === 'state') {
        state = msg.state; you = msg.you;
        render();
      } else if (msg.type === 'error') {
        showError(msg.message);
      } else if (msg.type === 'kicked') {
        goHome('You were removed from the game.');
      }
    };
  }
  function send(msg) {
    if (wsReady) ws.send(JSON.stringify(msg));
    else pendingJoin = msg;
  }

  function showError(text) {
    const el = state ? (state.phase === 'lobby' ? $('lobbyError') : $('gameError')) : $('homeError');
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 5000);
  }

  function goHome(msg) {
    state = null; you = null; code = null; token = null;
    history.replaceState(null, '', '/');
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
    $('recent').innerHTML = r.length ? 'Recent games: ' + r.map((c) => `<a href="/g/${c}">${c}</a>`).join('') : '';
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

  function renderLobby() {
    const n = state.settings.players;
    const isHost = state.hostId === playerId;
    $('lobbyCode').textContent = state.code;
    const link = `${location.origin}/g/${state.code}`;
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
    $('lobbyHint').textContent = full ? (isHost ? 'Everyone is in. Start when ready.' : 'Waiting for the host to start.') : `Waiting for ${n - state.players.length} more player(s). ${s.randomTeams ? 'Seats will be shuffled at start.' : 'Tap a seat to choose your partner (partners sit opposite).'}`;
  }

  // ---------- game ----------
  function seatColor(seat) { const n = state.settings.players; return TEAM_COLORS[seat % (n / 2)][seat < n / 2 ? 0 : 1]; }
  function nameOf(seat) { const p = state.players.find((x) => x.seat === seat); return p ? p.name : `Seat ${seat + 1}`; }

  function geometry() {
    const s = state.settings;
    const n = s.players, cpp = s.cellsPerPlayer, L = n * cpp;
    const mySeat = you ? you.seat : 0;
    const key = `${n}-${cpp}-${s.safeCells}-${mySeat}`;
    if (boardKey === key) return geo;
    const cx = 500, cy = 500, Rt = 385;
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
      const homeR = Rt + Math.max(22, rc * 2.3);
      home.push(Array.from({ length: s.marblesPerPlayer }, (_, k) => pt(a + (k - 1.5) * spread, homeR)));
      label.push(pt(a, homeR + rc * 2 + 26));
    }
    geo = { L, cx, cy, Rt, rc, track, safe, home, label, cpp };
    boardKey = key;
    return geo;
  }

  function marblePos(m) {
    const g = geometry();
    if (m.zone === 'track') return g.track[(m.owner * g.cpp + m.pos) % g.L];
    if (m.zone === 'safe') return g.safe[m.owner][m.pos];
    const k = Number(m.id.split('_')[1]);
    return g.home[m.owner][k];
  }

  function drawBoardStatic() {
    const g = geometry();
    const svg = $('board');
    const n = state.settings.players;
    let h = '';
    h += `<circle cx="${g.cx}" cy="${g.cy}" r="${g.Rt + g.rc * 1.4}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="${g.rc * 2.9}"/>`;
    g.track.forEach((p, i) => {
      const isBase = i % g.cpp === 0;
      const seat = i / g.cpp;
      const stroke = isBase ? ` style="stroke:${seatColor(seat)}"` : '';
      h += `<circle class="cell${isBase ? ' base' : ''}" data-abs="${i}" cx="${p.x}" cy="${p.y}" r="${isBase ? g.rc * 1.15 : g.rc}"${stroke}/>`;
    });
    for (let seat = 0; seat < n; seat++) {
      g.safe[seat].forEach((p) => { h += `<circle class="cell safe" cx="${p.x}" cy="${p.y}" r="${g.rc}" style="stroke:${seatColor(seat)}"/>`; });
      g.home[seat].forEach((p) => { h += `<circle class="cell home" cx="${p.x}" cy="${p.y}" r="${g.rc * .95}"/>`; });
      const lp = g.label[seat];
      h += `<text id="lbl${seat}" class="lbl" x="${lp.x}" y="${lp.y + 7}" style="fill:${seatColor(seat)}"></text>`;
    }
    h += `<text id="centerText" class="center-text" x="${g.cx}" y="${g.cy - 8}"></text><text id="centerSub" class="center-sub" x="${g.cx}" y="${g.cy + 24}"></text>`;
    h += `<g id="marbles"></g>`;
    svg.innerHTML = h;
    svg.dataset.key = boardKey;
  }

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
      send({ type: 'move', moveId: cands[0].id });
      sel = { cardId: null, picks: [] };
      return true;
    }
    return false;
  }
  function pick(value) {
    sel.picks.push(value);
    if (!tryCommit()) renderGame();
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
        el.innerHTML = `<circle class="halo" r="0" fill="none" stroke="#fff" stroke-width="3"/><circle class="ring" r="${g.rc * 1.05}" fill="none" stroke="none"/><circle class="body" r="${g.rc * .78}"/><circle r="${g.rc * .25}" cx="${-g.rc * .25}" cy="${-g.rc * .25}" fill="rgba(255,255,255,.55)" stroke="none"/>`;
        el.querySelector('.body').setAttribute('fill', seatColor(m.owner));
        el.onclick = () => { if (el.classList.contains('pick')) pick(m.id); };
        grp.appendChild(el);
      }
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      el.classList.toggle('pick', pickSet.has(m.id));
      el.classList.toggle('last', last.has(m.id));
      existing.delete(m.id);
    }
    for (const el of existing.values()) el.remove();
    // picked marbles should render on top
    for (const id of picks) { const el = grp.querySelector(`g.marble[data-id="${id}"]`); if (el) grp.appendChild(el); }
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
    $('centerText').textContent = state.phase === 'finished' ? `Team ${TEAM_NAMES[state.winner]} wins` : (state.phase === 'playing' ? `${nameOf(state.turn)}'s turn` : '');
    $('centerSub').textContent = state.phase === 'finished' ? state.players.filter((p) => p.team === state.winner).map((p) => p.name).join(' & ') : `Deck ${state.stockCount} · Deal ${state.dealNo}`;

    const banner = $('turnBanner');
    if (state.phase === 'finished') { banner.textContent = `Game over. Team ${TEAM_NAMES[state.winner]} wins!`; banner.className = 'turn-banner'; }
    else if (!you) { banner.textContent = `Watching. ${nameOf(state.turn)} to play.`; banner.className = 'turn-banner'; }
    else if (myTurn) { banner.textContent = you.controls !== mySeat ? `Your turn — you move ${nameOf(you.controls)}'s marbles` : 'Your turn'; banner.className = 'turn-banner mine'; }
    else { banner.textContent = `${nameOf(state.turn)} is thinking…`; banner.className = 'turn-banner'; }

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
    if (you && you.hand) {
      const playable = new Set((you.legalMoves || []).map((m) => m.cardId));
      const onlyBurn = (you.legalMoves || []).length > 0 && you.legalMoves.every((m) => m.kind === 'burn');
      for (const c of you.hand) {
        const el = document.createElement('div');
        const red = c.suit === 'H' || c.suit === 'D';
        el.className = 'pcard' + (red ? ' red' : '') + (c.rank === 'JOKER' ? ' joker' : '') + (sel.cardId === c.id ? ' sel' : '') + (myTurn && !playable.has(c.id) ? ' dead' : '');
        el.title = HINT[c.rank] || '';
        el.innerHTML = c.rank === 'JOKER' ? `<div class="r">★</div><div class="s">JOKER</div><div class="b">★</div>` : `<div class="r">${c.rank}</div><div class="s">${SUIT[c.suit]}</div><div class="b">${c.rank}</div>`;
        el.onclick = () => {
          if (!myTurn) return;
          if (!playable.has(c.id)) return;
          sel = sel.cardId === c.id ? { cardId: null, picks: [] } : { cardId: c.id, picks: [] };
          if (sel.cardId && !tryCommit()) renderGame();
          else if (!sel.cardId) renderGame();
        };
        hand.appendChild(el);
      }
      if (onlyBurn && myTurn && !sel.cardId) $('prompt').innerHTML = '<b>No legal move.</b> Pick a card to burn.';
    }

    // prompt
    const pr = $('prompt');
    if (myTurn && sel.cardId) {
      const picks = nextPicks();
      const marblePicks = picks.filter((p) => p.type === 'marble');
      const optPicks = picks.filter((p) => p.type === 'option');
      let html = '';
      if (marblePicks.length) html += sel.picks.length === 0 ? 'Tap a highlighted marble.' : 'Now tap the second marble.';
      if (optPicks.length) html += `<div class="opts">${optPicks.map((p) => `<button class="secondary" data-v="${esc(p.value)}">${esc(p.label)}</button>`).join('')}</div>`;
      html += ` <button class="link" id="btnCancel">cancel</button>`;
      pr.innerHTML = html;
      pr.querySelectorAll('button[data-v]').forEach((b) => (b.onclick = () => pick(b.dataset.v)));
      $('btnCancel').onclick = () => { sel = { cardId: null, picks: [] }; renderGame(); };
    } else if (!(myTurn && you.legalMoves && you.legalMoves.every((m) => m.kind === 'burn'))) {
      pr.innerHTML = myTurn ? 'Pick a card.' : '';
    }

    renderMarbles();

    // log & chat
    $('log').innerHTML = state.log.slice(-40).reverse().map((l) => `<div>${esc(l.text)}</div>`).join('');
    const chat = $('chat');
    const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 10;
    chat.innerHTML = state.chat.map((c) => `<div><b style="color:${seatColor(c.seat)}">${esc(c.name)}:</b>${esc(c.text)}</div>`).join('');
    if (atBottom) chat.scrollTop = chat.scrollHeight;

    renderFairness();
    $('btnRematch').classList.toggle('hidden', !(state.phase === 'finished' && state.hostId === playerId));
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
    else { showScreen('Game'); if (state.phase !== 'playing' || !you || state.turn !== you.seat) sel = { cardId: null, picks: [] }; renderGame(); }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- boot ----------
  renderRecent();
  const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{3,12})/);
  if (m) {
    const c = m[1].toUpperCase();
    $('code').value = c;
    const t = store.token(c);
    if (t) { code = c; token = t; } // auto-rejoin on open
  }
  connect();
})();
