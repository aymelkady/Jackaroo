// Jackaroo rules engine. Pure functions over a plain JSON state object. Runs in Node and in browsers.
// The server is the only authority: it shuffles, deals, enumerates legal moves
// and applies the move the player picked. Clients never compute rules.

import { sha256Hex, randomHex, randomInt } from './rng.js';

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];

export const DEFAULT_SETTINGS = {
  players: 4,          // 4, 6 or 8 (teams of two, partners sit opposite)
  cellsPerPlayer: 19,  // track cells between one base and the next
  safeCells: 4,
  marblesPerPlayer: 4,
  jokers: false,       // add 2 jokers per deck; a joker may be played as any rank
  kingKills: true,     // King may also move 13 steps killing everything it passes
  fiveMovesAny: true,  // 5 may move ANY marble on the track (opponent or partner)
  jumpOwn: false,      // may a marble jump over another marble of the same player? (most tables: no)
  complexCards: true,  // black J swaps / red J moves 11; red Q may make the next player burn a card of your choice; 10 may make the next player burn
  randomTeams: true,   // shuffle seats when the host starts the game
};

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  if ([4, 6, 8].includes(Number(input.players))) s.players = Number(input.players);
  if (typeof input.jokers === 'boolean') s.jokers = input.jokers;
  if (typeof input.kingKills === 'boolean') s.kingKills = input.kingKills;
  if (typeof input.fiveMovesAny === 'boolean') s.fiveMovesAny = input.fiveMovesAny;
  if (typeof input.jumpOwn === 'boolean') s.jumpOwn = input.jumpOwn;
  if (typeof input.complexCards === 'boolean') s.complexCards = input.complexCards;
  if (typeof input.randomTeams === 'boolean') s.randomTeams = input.randomTeams;
  return s;
}

// ---------- randomness & fairness ----------

export function secureShuffle(arr) {
  // Fisher-Yates with a CSPRNG (crypto.randomInt). Unbiased.
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildDeck(settings) {
  const decks = settings.players > 4 ? 2 : 1;
  const cards = [];
  let n = 0;
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ id: `c${n++}`, rank, suit });
    if (settings.jokers) {
      cards.push({ id: `c${n++}`, rank: 'JOKER', suit: null });
      cards.push({ id: `c${n++}`, rank: 'JOKER', suit: null });
    }
  }
  return cards;
}

export function cardLabel(c) {
  if (!c) return '?';
  if (c.rank === 'JOKER') return 'Joker';
  const s = { S: '♠', H: '♥', D: '♦', C: '♣' }[c.suit] || '';
  return `${c.rank}${s}`;
}

export function deckString(deck) {
  return deck.map((c) => `${c.rank}${c.suit || ''}`).join(',');
}

export function commitDeck(deck) {
  const salt = randomHex(16);
  const hash = sha256Hex(`${salt}:${deckString(deck)}`);
  return { salt, hash };
}

// ---------- game creation ----------

export function createGame({ code, hostId, settings }) {
  return {
    code,
    hostId,
    settings: normalizeSettings(settings),
    phase: 'lobby', // lobby | playing | finished
    createdAt: Date.now(),
    updatedAt: Date.now(),
    players: [], // { id, name, seat, isBot, connected }
    marbles: [],
    hands: {},
    stock: [],
    discard: [],
    deckCommit: null,   // { hash } of the current deck (salt kept private until reveal)
    deckSalt: null,     // private
    deckOrder: null,    // private copy of the full shuffled order
    deckHistory: [],    // revealed decks: { hash, salt, order }
    dealer: 0,
    turn: 0,
    dealNo: 0,
    freshDeck: true,
    winner: null,
    pendingBurn: null, // seat that must burn a card before playing (a 10 was played on them)
    log: [],
    lastMove: null,
    chat: [],
  };
}

export function trackLength(s) {
  return s.players * s.cellsPerPlayer;
}

export function partnerSeat(seat, n) {
  return (seat + n / 2) % n;
}

export function teamOf(seat, n) {
  return seat % (n / 2);
}

export function baseAbs(seat, s) {
  return seat * s.cellsPerPlayer;
}

export function absOf(marble, s) {
  // absolute track index of a marble on the track
  return (baseAbs(marble.owner, s) + marble.pos) % trackLength(s);
}

function log(state, text, extra = {}) {
  state.log.push({ t: Date.now(), text, ...extra });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

// ---------- lobby ----------

export function addPlayer(state, { id, name, isBot = false }) {
  if (state.phase !== 'lobby') throw new Error('Game already started');
  if (state.players.length >= state.settings.players) throw new Error('Game is full');
  const taken = new Set(state.players.map((p) => p.seat));
  let seat = 0;
  while (taken.has(seat)) seat++;
  const p = { id, name: String(name).slice(0, 20), seat, isBot, connected: !isBot };
  state.players.push(p);
  log(state, `${p.name} joined`);
  return p;
}

export function removePlayer(state, playerId) {
  if (state.phase !== 'lobby') throw new Error('Cannot remove players after start');
  const i = state.players.findIndex((p) => p.id === playerId);
  if (i < 0) return;
  const [p] = state.players.splice(i, 1);
  log(state, `${p.name} left`);
}

export function setSeat(state, playerId, seat) {
  if (state.phase !== 'lobby') throw new Error('Seats are locked after start');
  const n = state.settings.players;
  if (!Number.isInteger(seat) || seat < 0 || seat >= n) throw new Error('Bad seat');
  const p = state.players.find((x) => x.id === playerId);
  if (!p) throw new Error('No such player');
  const other = state.players.find((x) => x.seat === seat);
  if (other && other.id !== p.id) other.seat = p.seat; // swap
  p.seat = seat;
}

export function randomizeSeats(state) {
  const seats = secureShuffle(state.players.map((p) => p.seat));
  state.players.forEach((p, i) => (p.seat = seats[i]));
}

export function startGame(state) {
  if (state.phase !== 'lobby') throw new Error('Already started');
  const n = state.settings.players;
  if (state.players.length !== n) throw new Error(`Need exactly ${n} players`);
  if (state.settings.randomTeams) randomizeSeats(state);
  state.players.sort((a, b) => a.seat - b.seat);
  const s = state.settings;
  state.marbles = [];
  for (let seat = 0; seat < n; seat++) {
    for (let k = 0; k < s.marblesPerPlayer; k++) {
      state.marbles.push({ id: `m${seat}_${k}`, owner: seat, zone: 'home', pos: -1 });
    }
  }
  state.phase = 'playing';
  state.dealer = randomInt(0, n);
  state.dealNo = 0;
  state.freshDeck = true;
  state.stock = [];
  state.discard = [];
  state.winner = null;
  state.log = [];
  log(state, 'Game started');
  dealRound(state);
  return state;
}

// ---------- dealing ----------

function freshDeck(state) {
  const deck = secureShuffle(buildDeck(state.settings));
  const { salt, hash } = commitDeck(deck);
  state.stock = deck;
  state.discard = [];
  state.deckSalt = salt;
  state.deckOrder = deck.slice();
  state.deckCommit = { hash, cards: deck.length, at: Date.now() };
  state.freshDeck = true;
  log(state, `New deck shuffled (${deck.length} cards). Commitment ${hash.slice(0, 12)}…`);
}

function revealDeck(state) {
  if (!state.deckCommit) return;
  state.deckHistory.push({
    hash: state.deckCommit.hash,
    salt: state.deckSalt,
    order: deckString(state.deckOrder),
    cards: state.deckOrder.length,
  });
  if (state.deckHistory.length > 20) state.deckHistory.shift();
  state.deckCommit = null;
  state.deckSalt = null;
  state.deckOrder = null;
}

export function dealRound(state) {
  const n = state.settings.players;
  // First deal from a fresh deck is 5 cards, every later deal is 4.
  // One deck, 4 players: 5+4+4 = 13 cards each = 52, so a deck is used exactly.
  let per = state.freshDeck ? 5 : 4;
  if (state.stock.length < n * 4 || (state.freshDeck && state.stock.length < n * 5)) {
    revealDeck(state);
    freshDeck(state);
    per = 5;
  }
  state.freshDeck = false;
  state.dealNo += 1;
  state.dealer = (state.dealer + (state.dealNo === 1 ? 0 : 1)) % n;
  state.hands = {};
  for (let seat = 0; seat < n; seat++) state.hands[seat] = [];
  for (let k = 0; k < per; k++) {
    for (let i = 1; i <= n; i++) {
      const seat = (state.dealer + i) % n;
      state.hands[seat].push(state.stock.shift());
    }
  }
  state.turn = (state.dealer + 1) % n;
  state.pendingBurn = null;
  log(state, `Deal ${state.dealNo}: ${per} cards each. ${nameOf(state, state.dealer)} dealt.`);
}

export function nameOf(state, seat) {
  const p = state.players.find((x) => x.seat === seat);
  return p ? p.name : `Seat ${seat + 1}`;
}

// ---------- helpers ----------

function marbleAtAbs(state, abs) {
  const s = state.settings;
  return state.marbles.find((m) => m.zone === 'track' && absOf(m, s) === abs) || null;
}

function isProtected(m) {
  // A marble standing on its OWN base cannot be passed, killed, swapped or moved by another player's 5.
  return m.zone === 'track' && m.pos === 0;
}

function isWall(state, occ, nextAbs) {
  // Wall: the marble being passed (occ) and the marble on the next cell in the travel direction
  // belong to the same team. Nobody (King included) may pass over such a pair.
  const nxt = marbleAtAbs(state, nextAbs);
  if (!nxt) return false;
  const n = state.settings.players;
  return teamOf(nxt.owner, n) === teamOf(occ.owner, n);
}

export function isFinished(state, seat) {
  return state.marbles.filter((m) => m.owner === seat).every((m) => m.zone === 'safe');
}

export function controlledSeat(state, seat) {
  // A player whose marbles are all safe plays their partner's marbles.
  if (!isFinished(state, seat)) return seat;
  return partnerSeat(seat, state.settings.players);
}

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

// Simulate moving marble `m` forward `steps` (or backward if steps<0).
// Returns { ok, kills:[marbleIds], to:{zone,pos} } without mutating state.
function simulateStep(state, m, steps, opts = {}) {
  const s = state.settings;
  const L = trackLength(s);
  const kills = [];
  const { killPath = false, byOther = false } = opts;
  if (m.zone === 'home') return { ok: false };

  if (m.zone === 'safe') {
    if (steps <= 0) return { ok: false };
    const target = m.pos + steps;
    if (target >= s.safeCells) return { ok: false };
    for (let k = m.pos + 1; k <= target; k++) {
      if (state.marbles.some((x) => x.owner === m.owner && x.zone === 'safe' && x.pos === k)) return { ok: false };
    }
    return { ok: true, kills, to: { zone: 'safe', pos: target } };
  }

  // on the track
  if (steps < 0) {
    const n = -steps;
    for (let k = 1; k <= n; k++) {
      const d = ((m.pos - k) % L + L) % L;
      const abs = (baseAbs(m.owner, s) + d) % L;
      const occ = marbleAtAbs(state, abs);
      if (!occ) continue;
      if (isProtected(occ)) return { ok: false };
      if (k < n && isWall(state, occ, (abs - 1 + L) % L)) return { ok: false }; // two team-mates side by side block
      if (k === n) {
        if (occ.owner === m.owner) return { ok: false };
        kills.push(occ.id);
      } else if (occ.owner === m.owner && !s.jumpOwn) return { ok: false }; // cannot jump over your own marble
    }
    return { ok: true, kills, to: { zone: 'track', pos: ((m.pos - n) % L + L) % L } };
  }

  for (let k = 1; k <= steps; k++) {
    const d = m.pos + k;
    if (d <= L - 1) {
      const abs = (baseAbs(m.owner, s) + d) % L;
      const occ = marbleAtAbs(state, abs);
      if (!occ) continue;
      if (isProtected(occ)) return { ok: false };
      if (k < steps && d + 1 <= L - 1 && isWall(state, occ, (abs + 1) % L)) return { ok: false }; // wall
      if (k === steps) {
        if (occ.owner === m.owner) return { ok: false };
        kills.push(occ.id);
      } else if (occ.owner === m.owner && !s.jumpOwn) {
        return { ok: false }; // cannot jump over your own marble (not even with a King)
      } else if (killPath) {
        kills.push(occ.id);
      }
    } else {
      // entering / inside the safe zone
      if (byOther) return { ok: false }; // another player cannot push a marble into its safe zone
      const si = d - L;
      if (si >= s.safeCells) return { ok: false };
      if (state.marbles.some((x) => x.owner === m.owner && x.zone === 'safe' && x.pos === si)) return { ok: false };
    }
  }
  const d = m.pos + steps;
  if (d <= L - 1) return { ok: true, kills, to: { zone: 'track', pos: d } };
  return { ok: true, kills, to: { zone: 'safe', pos: d - L } };
}

function applyStep(state, marbleId, sim) {
  const m = state.marbles.find((x) => x.id === marbleId);
  for (const kid of sim.kills) {
    const k = state.marbles.find((x) => x.id === kid);
    k.zone = 'home';
    k.pos = -1;
  }
  m.zone = sim.to.zone;
  m.pos = sim.to.pos;
}

function simulateExit(state, m) {
  const s = state.settings;
  const abs = baseAbs(m.owner, s);
  const occ = marbleAtAbs(state, abs);
  if (occ) {
    if (occ.owner === m.owner) return { ok: false }; // own marble already on base
    return { ok: true, kills: [occ.id], to: { zone: 'track', pos: 0 } };
  }
  return { ok: true, kills: [], to: { zone: 'track', pos: 0 } };
}

// ---------- legal moves ----------

// Each legal move: { id, cardId, rank (effective), kind, picks:[{type,value,label}], ...details }
export function legalMoves(state, seat) {
  if (state.phase !== 'playing' || state.turn !== seat) return [];
  const hand = state.hands[seat] || [];
  const moves = [];
  if (state.pendingBurn === seat) {
    // a 10 was played on this player: they must burn a card of their choice before their normal turn
    for (const card of hand) moves.push({ kind: 'burn', forced: true, cardId: card.id, rank: card.rank, picks: [{ type: 'option', value: 'burn', label: 'Burn this card' }] });
    moves.forEach((m, i) => (m.id = i));
    return moves;
  }
  const ctrl = controlledSeat(state, seat);
  for (const card of hand) {
    const ranks = card.rank === 'JOKER' ? RANKS : [card.rank];
    for (const rank of ranks) {
      const prefix = card.rank === 'JOKER' ? [{ type: 'option', value: `as:${rank}`, label: `Play as ${rank}` }] : [];
      for (const mv of movesForRank(state, seat, ctrl, rank, card)) {
        moves.push({ ...mv, cardId: card.id, rank, picks: [...prefix, ...mv.picks] });
      }
    }
  }
  if (moves.length === 0) {
    for (const card of hand) {
      moves.push({ kind: 'burn', cardId: card.id, rank: card.rank, picks: [{ type: 'option', value: 'burn', label: 'Burn this card' }] });
    }
  }
  moves.forEach((m, i) => (m.id = i));
  return moves;
}

function myMarbles(state, ctrl) {
  return state.marbles.filter((m) => m.owner === ctrl);
}

function pickMarble(m, label) {
  return { type: 'marble', value: m.id, label: label || m.id };
}

function stepMoves(state, ctrl, steps, kind = 'step', extra = {}) {
  const out = [];
  for (const m of myMarbles(state, ctrl)) {
    const sim = simulateStep(state, m, steps, extra.sim || {});
    if (sim.ok) out.push({ kind, marbleId: m.id, steps, kills: sim.kills, to: sim.to, picks: [pickMarble(m)], ...extra.fields });
  }
  return out;
}

export function nextSeat(state, seat) {
  return (seat + 1) % state.settings.players;
}

function isRed(card) { return card.suit === 'H' || card.suit === 'D'; }

function movesForRank(state, seat, ctrl, rank, card = { suit: null, rank }) {
  const s = state.settings;
  const out = [];
  const joker = card.rank === 'JOKER';
  const nxt = nextSeat(state, seat);
  const nextHand = state.hands[nxt] || [];
  const exits = () => {
    const res = [];
    for (const m of myMarbles(state, ctrl)) {
      if (m.zone !== 'home') continue;
      const sim = simulateExit(state, m);
      if (sim.ok) {
        res.push({ kind: 'exit', marbleId: m.id, kills: sim.kills, to: sim.to, picks: [pickMarble(m), { type: 'option', value: 'exit', label: 'Exit to base' }] });
        break; // all home marbles are identical; one exit move is enough
      }
    }
    return res;
  };
  switch (rank) {
    case 'A':
      out.push(...exits());
      for (const m of stepMoves(state, ctrl, 1)) out.push({ ...m, picks: [m.picks[0], { type: 'option', value: '1', label: 'Move 1' }] });
      for (const m of stepMoves(state, ctrl, 11)) out.push({ ...m, picks: [m.picks[0], { type: 'option', value: '11', label: 'Move 11' }] });
      break;
    case 'K':
      out.push(...exits());
      if (s.kingKills) {
        for (const m of stepMoves(state, ctrl, 13, 'king', { sim: { killPath: true } })) {
          out.push({ ...m, picks: [m.picks[0], { type: 'option', value: '13', label: 'Move 13 (kills on the way)' }] });
        }
      }
      break;
    case 'Q': {
      for (const m of stepMoves(state, ctrl, 12)) out.push({ ...m, picks: s.complexCards ? [m.picks[0]] : m.picks });
      if (s.complexCards && (joker || isRed(card)) && nextHand.length) {
        // red Queen: pick one of the next player's cards (face down) and burn it
        nextHand.forEach((c, i) => out.push({ kind: 'queenBurn', target: nxt, index: i, picks: [{ type: 'option', value: 'burn', label: `Burn a card of ${nameOf(state, nxt)}` }, { type: 'option', value: `card:${i}`, label: `Card ${i + 1}` }] }));
      }
      break;
    }
    case '10': {
      for (const m of stepMoves(state, ctrl, 10)) out.push({ ...m, picks: s.complexCards ? [m.picks[0]] : m.picks });
      if (s.complexCards && nextHand.length) out.push({ kind: 'tenBurn', target: nxt, picks: [{ type: 'option', value: 'burn', label: `${nameOf(state, nxt)} must burn a card` }] });
      break;
    }
    case '9': out.push(...stepMoves(state, ctrl, 9)); break;
    case '8': out.push(...stepMoves(state, ctrl, 8)); break;
    case '6': out.push(...stepMoves(state, ctrl, 6)); break;
    case '3': out.push(...stepMoves(state, ctrl, 3)); break;
    case '2': out.push(...stepMoves(state, ctrl, 2)); break;
    case '4': out.push(...stepMoves(state, ctrl, -4, 'back')); break;
    case '5': {
      if (!s.fiveMovesAny) { out.push(...stepMoves(state, ctrl, 5)); break; }
      for (const m of state.marbles) {
        if (m.zone !== 'track') continue;
        const byOther = m.owner !== ctrl;
        if (byOther && isProtected(m)) continue; // base protection: nobody else may move a marble off its own base
        const sim = simulateStep(state, m, 5, { byOther });
        if (sim.ok) out.push({ kind: 'five', marbleId: m.id, steps: 5, kills: sim.kills, to: sim.to, picks: [pickMarble(m)] });
      }
      break;
    }
    case '7': {
      const mine = myMarbles(state, ctrl).filter((m) => m.zone !== 'home');
      for (const a of mine) {
        for (let s1 = 1; s1 <= 7; s1++) {
          const simA = simulateStep(state, a, s1);
          if (!simA.ok) continue;
          if (s1 === 7) {
            out.push({ kind: 'seven', parts: [{ marbleId: a.id, steps: 7, to: simA.to }], kills: simA.kills, to: simA.to, marbleId: a.id, picks: [pickMarble(a), { type: 'option', value: '7', label: 'All 7 steps' }] });
            continue;
          }
          // apply part A on a copy, then try part B
          const copy = clone(state);
          applyStep(copy, a.id, simA);
          for (const b of mine) {
            if (b.id === a.id) continue;
            const bb = copy.marbles.find((x) => x.id === b.id);
            if (bb.zone === 'home') continue; // killed? cannot happen for own, but be safe
            const simB = simulateStep(copy, bb, 7 - s1);
            if (!simB.ok) continue;
            out.push({
              kind: 'seven',
              parts: [{ marbleId: a.id, steps: s1, to: simA.to }, { marbleId: b.id, steps: 7 - s1, to: simB.to }],
              kills: [...simA.kills, ...simB.kills], marbleId: a.id,
              picks: [pickMarble(a), { type: 'option', value: String(s1), label: `${s1} steps, then ${7 - s1} with another` }, pickMarble(b)],
            });
          }
        }
      }
      break;
    }
    case 'J': {
      const L = trackLength(s);
      if (s.complexCards && !joker && isRed(card)) { out.push(...stepMoves(state, ctrl, 11)); break; } // red Jack only moves 11
      if (joker) out.push(...stepMoves(state, ctrl, 11));
      for (const a of myMarbles(state, ctrl)) {
        if (a.zone !== 'track' || isProtected(a)) continue;
        for (const b of state.marbles) {
          if (b.owner === ctrl || b.zone !== 'track' || isProtected(b)) continue;
          const absA = absOf(a, s), absB = absOf(b, s);
          out.push({
            kind: 'jack', marbleId: a.id, targetId: b.id,
            toA: ((absB - baseAbs(a.owner, s)) % L + L) % L,
            toB: ((absA - baseAbs(b.owner, s)) % L + L) % L,
            picks: [pickMarble(a), pickMarble(b, 'swap with')],
          });
        }
      }
      break;
    }
    default: break;
  }
  return out;
}

// ---------- applying a move ----------

export function applyMove(state, seat, moveId) {
  const moves = legalMoves(state, seat);
  const mv = moves.find((m) => m.id === moveId);
  if (!mv) throw new Error('Illegal move');
  const hand = state.hands[seat];
  const ci = hand.findIndex((c) => c.id === mv.cardId);
  if (ci < 0) throw new Error('Card not in hand');
  const [card] = hand.splice(ci, 1);
  state.discard.push(card);
  const who = nameOf(state, seat);
  const lbl = cardLabel(card) + (card.rank === 'JOKER' ? ` as ${mv.rank}` : '');
  const summary = { seat, cardId: card.id, card, rank: mv.rank, kind: mv.kind, at: Date.now() };

  const killsText = (kills) => (kills && kills.length ? ` and sends ${kills.map((k) => nameOf(state, state.marbles.find((m) => m.id === k).owner)).join(', ')} home` : '');

  switch (mv.kind) {
    case 'burn':
      if (mv.forced) { state.pendingBurn = null; log(state, `${who} burns ${lbl} (forced by a 10)`, { seat }); }
      else log(state, `${who} burns ${lbl} (no legal move)`, { seat });
      break;
    case 'queenBurn': {
      const th = state.hands[mv.target];
      if (!th || mv.index >= th.length) throw new Error('Illegal burn');
      const [victim] = th.splice(mv.index, 1);
      state.discard.push(victim);
      log(state, `${who} plays ${lbl}: burns ${cardLabel(victim)} from ${nameOf(state, mv.target)}'s hand`, { seat });
      summary.burned = victim;
      break;
    }
    case 'tenBurn':
      state.pendingBurn = mv.target;
      log(state, `${who} plays ${lbl}: ${nameOf(state, mv.target)} must burn a card`, { seat });
      break;
    case 'exit': {
      const m = state.marbles.find((x) => x.id === mv.marbleId);
      const sim = simulateExit(state, m);
      log(state, `${who} plays ${lbl}: marble out to base${killsText(sim.kills)}`, { seat });
      applyStep(state, m.id, sim);
      summary.marbleId = m.id;
      break;
    }
    case 'step': case 'back': case 'king': case 'five': {
      const m = state.marbles.find((x) => x.id === mv.marbleId);
      const sim = simulateStep(state, m, mv.steps, { killPath: mv.kind === 'king', byOther: mv.kind === 'five' && m.owner !== controlledSeat(state, seat) });
      const whose = m.owner === seat ? 'own' : `${nameOf(state, m.owner)}'s`;
      const dest = sim.to.zone === 'safe' ? ' into the safe zone' : '';
      log(state, `${who} plays ${lbl}: ${whose} marble ${mv.steps > 0 ? 'forward' : 'back'} ${Math.abs(mv.steps)}${dest}${killsText(sim.kills)}`, { seat });
      applyStep(state, m.id, sim);
      summary.marbleId = m.id;
      break;
    }
    case 'seven': {
      const texts = [];
      for (const part of mv.parts) {
        const m = state.marbles.find((x) => x.id === part.marbleId);
        const sim = simulateStep(state, m, part.steps);
        if (!sim.ok) throw new Error('Illegal 7 split');
        texts.push(`${part.steps} steps${sim.to.zone === 'safe' ? ' (safe)' : ''}${killsText(sim.kills)}`);
        applyStep(state, m.id, sim);
      }
      log(state, `${who} plays ${lbl}: ${texts.join(' + ')}`, { seat });
      summary.marbleId = mv.parts[0].marbleId;
      break;
    }
    case 'jack': {
      const a = state.marbles.find((x) => x.id === mv.marbleId);
      const b = state.marbles.find((x) => x.id === mv.targetId);
      a.pos = mv.toA;
      b.pos = mv.toB;
      log(state, `${who} plays ${lbl}: swaps with ${nameOf(state, b.owner)}'s marble`, { seat });
      summary.marbleId = a.id;
      summary.targetId = b.id;
      break;
    }
    default:
      throw new Error('Unknown move kind');
  }
  state.lastMove = summary;
  state.updatedAt = Date.now();

  // win check
  const n = state.settings.players;
  for (let t = 0; t < n / 2; t++) {
    const seats = [t, t + n / 2];
    if (seats.every((sx) => isFinished(state, sx))) {
      state.winner = t;
      state.phase = 'finished';
      log(state, `Team ${String.fromCharCode(65 + t)} (${seats.map((sx) => nameOf(state, sx)).join(' & ')}) wins!`);
      revealDeck(state);
      return state;
    }
  }

  // next turn / next deal
  if (mv.kind === 'burn' && mv.forced && state.hands[seat].length > 0) return state; // forced burn done: same player now plays
  advanceTurn(state);
  return state;
}

function advanceTurn(state) {
  const n = state.settings.players;
  if (Object.values(state.hands).every((h) => h.length === 0)) { dealRound(state); return; }
  let next = (state.turn + 1) % n;
  while ((state.hands[next] || []).length === 0) next = (next + 1) % n; // players with no cards left are skipped
  if (state.pendingBurn != null && state.pendingBurn !== next) state.pendingBurn = null; // burn only binds the very next player
  state.turn = next;
}

// ---------- views ----------

export function publicState(state) {
  const { deckSalt, deckOrder, hands, ...rest } = state;
  const handCounts = {};
  for (const [seat, h] of Object.entries(hands || {})) handCounts[seat] = h.length;
  return {
    ...rest,
    players: state.players.map(({ id, name, seat, isBot, connected }) => ({ id, name, seat, isBot, connected, team: teamOf(seat, state.settings.players), finished: state.phase !== 'lobby' && isFinished(state, seat) })),
    handCounts,
    stockCount: state.stock.length,
    discardTop: state.discard[state.discard.length - 1] || null,
    stock: undefined,
    discard: undefined,
  };
}

export function privateView(state, seat) {
  return {
    seat,
    hand: state.hands[seat] || [],
    legalMoves: legalMoves(state, seat),
    controls: state.phase === 'playing' ? controlledSeat(state, seat) : seat,
  };
}

// ---------- simple bot ----------

export function chooseBotMove(state, seat) {
  const moves = legalMoves(state, seat);
  if (moves.length === 0) return null;
  const s = state.settings;
  const L = trackLength(s);
  const score = (mv) => {
    let v = randomInt(0, 10) / 10;
    if (mv.kind === 'burn') return -100 + v;
    if (mv.kind === 'queenBurn' || mv.kind === 'tenBurn') return (teamOf(mv.target, s.players) === teamOf(seat, s.players) ? -30 : 6) + v;
    const kills = (mv.kills || []).filter((k) => {
      const m = state.marbles.find((x) => x.id === k);
      return teamOf(m.owner, s.players) !== teamOf(seat, s.players);
    }).length;
    const selfKills = (mv.kills || []).length - kills;
    v += kills * 30 - selfKills * 40;
    if (mv.kind === 'exit') v += 20;
    if (mv.to && mv.to.zone === 'safe') v += 25;
    if (mv.kind === 'step' || mv.kind === 'king') v += mv.steps / 2;
    if (mv.kind === 'seven') v += 4;
    if (mv.kind === 'five') {
      const m = state.marbles.find((x) => x.id === mv.marbleId);
      v += teamOf(m.owner, s.players) === teamOf(seat, s.players) ? 3 : -2;
    }
    if (mv.kind === 'jack') {
      const a = state.marbles.find((x) => x.id === mv.marbleId);
      const b = state.marbles.find((x) => x.id === mv.targetId);
      const gain = mv.toA - a.pos; // progress gained
      const theirLoss = b.pos - mv.toB;
      v += (gain + (teamOf(b.owner, s.players) !== teamOf(seat, s.players) ? theirLoss : -theirLoss)) / 4;
    }
    if (mv.kind === 'back') v += 2; // the classic 4-back trick near base
    // avoid leaving a marble right in front of an enemy
    if (mv.to && mv.to.zone === 'track') v += mv.to.pos / L;
    return v;
  };
  let best = moves[0], bestV = -Infinity;
  for (const mv of moves) {
    const v = score(mv);
    if (v > bestV) { best = mv; bestV = v; }
  }
  return best.id;
}
