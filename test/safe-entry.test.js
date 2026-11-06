import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../shared/engine.js';

function game(extra = {}) {
  const st = E.createGame({ code: 'TEST1', hostId: 'p0', settings: { players: 4, randomTeams: false, ...extra } });
  for (let i = 0; i < 4; i++) E.addPlayer(st, { id: `p${i}`, name: `P${i}` });
  E.startGame(st);
  return st;
}
function setHand(st, seat, ranks) {
  st.hands[seat] = ranks.map((r, i) => ({ id: `t${seat}_${i}`, rank: r, suit: 'S' }));
}
function marble(st, seat, k = 0) { return st.marbles.find((m) => m.id === `m${seat}_${k}`); }
function put(st, seat, k, zone, pos) { const m = marble(st, seat, k); m.zone = zone; m.pos = pos; return m; }
function moves(st, seat) { st.turn = seat; return E.legalMoves(st, seat); }
const L = 76;

// moves of a given kind for a marble, optionally filtered by Ace option / seven option
function find(lm, marbleId, kind, to) {
  return lm.filter((m) => m.kind === kind && m.marbleId === marbleId && (!to || (m.to.zone === to.zone && m.to.pos === to.pos)));
}
function asOne(lm, marbleId) { return lm.filter((m) => m.kind === 'step' && m.picks.some((p) => p.value === '1') && m.marbleId === marbleId); }

test('safeEntry is exported and equals 74 for 4 players', () => {
  const st = game();
  assert.equal(E.trackLength(st.settings), L);
  assert.equal(E.safeEntry(st.settings), 74);
});

test('case 1: from hole 12 with safe 2 and 3 taken, 7 -> safe 1, 6 -> safe 0, 8 illegal', () => {
  const st = game();
  put(st, 0, 0, 'track', L - 7);
  put(st, 0, 1, 'safe', 2);
  put(st, 0, 2, 'safe', 3);
  // m0_3 stays home
  setHand(st, 0, ['7']);
  const m7 = find(moves(st, 0), 'm0_0', 'seven').filter((m) => m.parts.length === 1);
  assert.equal(m7.length, 1);
  assert.deepEqual(m7[0].to, { zone: 'safe', pos: 1 });
  E.applyMove(st, 0, m7[0].id);
  assert.equal(marble(st, 0, 0).zone, 'safe');
  assert.equal(marble(st, 0, 0).pos, 1);

  const st6 = game();
  put(st6, 0, 0, 'track', L - 7); put(st6, 0, 1, 'safe', 2); put(st6, 0, 2, 'safe', 3);
  setHand(st6, 0, ['6']);
  const m6 = find(moves(st6, 0), 'm0_0', 'step');
  assert.equal(m6.length, 1);
  assert.deepEqual(m6[0].to, { zone: 'safe', pos: 0 });
  E.applyMove(st6, 0, m6[0].id);
  assert.deepEqual([marble(st6, 0, 0).zone, marble(st6, 0, 0).pos], ['safe', 0]);

  const st8 = game();
  put(st8, 0, 0, 'track', L - 7); put(st8, 0, 1, 'safe', 2); put(st8, 0, 2, 'safe', 3);
  setHand(st8, 0, ['8']);
  assert.equal(moves(st8, 0).filter((m) => m.marbleId === 'm0_0').length, 0);
});

test('case 2: from hole 17 (pos L-2) Ace as 1 -> safe 0, 3 -> safe 2', () => {
  const st = game();
  put(st, 0, 0, 'track', L - 2);
  setHand(st, 0, ['A']);
  const a = asOne(moves(st, 0), 'm0_0');
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].to, { zone: 'safe', pos: 0 });
  E.applyMove(st, 0, a[0].id);
  assert.deepEqual([marble(st, 0, 0).zone, marble(st, 0, 0).pos], ['safe', 0]);

  const st3 = game();
  put(st3, 0, 0, 'track', L - 2);
  setHand(st3, 0, ['3']);
  const m3 = find(moves(st3, 0), 'm0_0', 'step');
  assert.equal(m3.length, 1);
  assert.deepEqual(m3[0].to, { zone: 'safe', pos: 2 });
  E.applyMove(st3, 0, m3[0].id);
  assert.deepEqual([marble(st3, 0, 0).zone, marble(st3, 0, 0).pos], ['safe', 2]);
});

test('case 3: backward 4 from base -> L-4, then 3 from L-4 -> safe 0', () => {
  const st = game();
  put(st, 0, 0, 'track', 0);
  setHand(st, 0, ['4']);
  const b = find(moves(st, 0), 'm0_0', 'back');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].to, { zone: 'track', pos: L - 4 });
  E.applyMove(st, 0, b[0].id);
  assert.deepEqual([marble(st, 0, 0).zone, marble(st, 0, 0).pos], ['track', L - 4]);

  const st3 = game();
  put(st3, 0, 0, 'track', L - 4);
  setHand(st3, 0, ['3']);
  const m3 = find(moves(st3, 0), 'm0_0', 'step');
  assert.equal(m3.length, 1);
  assert.deepEqual(m3[0].to, { zone: 'safe', pos: 0 });
});

test('case 4: from hole 18 (pos L-1) the entrance is missed: Ace as 1 -> track 0, 3 -> track 2', () => {
  const st = game();
  put(st, 0, 0, 'track', L - 1);
  setHand(st, 0, ['A']);
  const a = asOne(moves(st, 0), 'm0_0');
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].to, { zone: 'track', pos: 0 });
  E.applyMove(st, 0, a[0].id);
  assert.deepEqual([marble(st, 0, 0).zone, marble(st, 0, 0).pos], ['track', 0]);

  const st3 = game();
  put(st3, 0, 0, 'track', L - 1);
  setHand(st3, 0, ['3']);
  const m3 = find(moves(st3, 0), 'm0_0', 'step');
  assert.equal(m3.length, 1);
  assert.deepEqual(m3[0].to, { zone: 'track', pos: 2 });
  E.applyMove(st3, 0, m3[0].id);
  assert.deepEqual([marble(st3, 0, 0).zone, marble(st3, 0, 0).pos], ['track', 2]);
});

test('case 5: an opponent 5 keeps the marble on the track and never enters the column', () => {
  const cases = [[L - 4, 1], [L - 6, L - 1], [L - 2, 3]];
  for (const [from, expected] of cases) {
    const st = game({ fiveMovesAny: true });
    put(st, 0, 0, 'track', from);
    setHand(st, 1, ['5']);
    const fives = find(moves(st, 1), 'm0_0', 'five');
    assert.equal(fives.length, 1, `from ${from}`);
    assert.deepEqual(fives[0].to, { zone: 'track', pos: expected }, `from ${from}`);
    assert.ok(!moves(st, 1).some((m) => m.kind === 'five' && m.marbleId === 'm0_0' && m.to.zone === 'safe'));
    E.applyMove(st, 1, fives[0].id);
    assert.deepEqual([marble(st, 0, 0).zone, marble(st, 0, 0).pos], ['track', expected]);
  }
});

test('case 6: the owner\'s own 5 enters the column: L-3 + 5 -> safe 3', () => {
  const st = game({ fiveMovesAny: true });
  const pos = L - 3;
  put(st, 0, 0, 'track', pos);
  setHand(st, 0, ['5']);
  const si = pos + 5 - (L - 2) - 1;
  assert.equal(si, 3);
  const f = find(moves(st, 0), 'm0_0', 'five');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].to, { zone: 'safe', pos: si });
  E.applyMove(st, 0, f[0].id);
  assert.deepEqual([marble(st, 0, 0).zone, marble(st, 0, 0).pos], ['safe', 3]);
});

test('case 7: inside the column: Ace safe 0 -> safe 1; 3 from safe 0 blocked by own marble on safe 2', () => {
  const st = game();
  put(st, 0, 0, 'safe', 0);
  setHand(st, 0, ['A']);
  const a = asOne(moves(st, 0), 'm0_0');
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].to, { zone: 'safe', pos: 1 });
  E.applyMove(st, 0, a[0].id);
  assert.deepEqual([marble(st, 0, 0).zone, marble(st, 0, 0).pos], ['safe', 1]);

  const st3 = game();
  put(st3, 0, 0, 'safe', 0);
  put(st3, 0, 1, 'safe', 2);
  setHand(st3, 0, ['3']);
  assert.equal(moves(st3, 0).filter((m) => m.marbleId === 'm0_0').length, 0);
});
