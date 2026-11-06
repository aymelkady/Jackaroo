import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../shared/engine.js';

function game(players = 4, extra = {}) {
  const st = E.createGame({ code: 'TEST1', hostId: 'p0', settings: { players, randomTeams: false, ...extra } });
  for (let i = 0; i < players; i++) E.addPlayer(st, { id: `p${i}`, name: `P${i}` });
  E.startGame(st);
  return st;
}

function setHand(st, seat, ranks) {
  // 'QH' style entries set the suit; bare ranks are spades (black)
  st.hands[seat] = ranks.map((r, i) => {
    const m = r.match(/^(A|K|Q|J|10|[2-9])([SHDC])$/);
    return m ? { id: `t${seat}_${i}`, rank: m[1], suit: m[2] } : { id: `t${seat}_${i}`, rank: r, suit: r === 'JOKER' ? null : 'S' };
  });
}
function marble(st, seat, k = 0) { return st.marbles.find((m) => m.id === `m${seat}_${k}`); }
function put(st, seat, k, zone, pos) { const m = marble(st, seat, k); m.zone = zone; m.pos = pos; return m; }
function moves(st, seat) { st.turn = seat; return E.legalMoves(st, seat); }

test('deck: 52 cards for 4 players, 104 for 6/8, jokers optional', () => {
  assert.equal(E.buildDeck(E.normalizeSettings({ players: 4 })).length, 52);
  assert.equal(E.buildDeck(E.normalizeSettings({ players: 6 })).length, 104);
  assert.equal(E.buildDeck(E.normalizeSettings({ players: 8, jokers: true })).length, 108);
});

test('shuffle is a permutation', () => {
  const d = E.buildDeck(E.normalizeSettings({}));
  const s = E.secureShuffle(d);
  assert.equal(s.length, d.length);
  assert.deepEqual(new Set(s.map((c) => c.id)), new Set(d.map((c) => c.id)));
});

test('first deal is 5 cards, later deals 4; one deck is used exactly for 4 players', () => {
  const st = game(4, { complexCards: false }); // every turn must consume exactly one card here
  assert.equal(st.hands[0].length, 5);
  assert.equal(st.stock.length, 52 - 20);
  // play through all three deals of the first deck (5+4+4 = 13 cards each)
  const commit = st.deckCommit.hash;
  for (let round = 0; round < 3; round++) {
    const per = st.hands[st.turn].length;
    for (let i = 0; i < 4 * per; i++) {
      const seat = st.turn;
      const lm = E.legalMoves(st, seat);
      E.applyMove(st, seat, lm[0].id);
    }
  }
  // after 5+4+4 = 13 cards each the deck is exhausted and a new one committed
  assert.notEqual(st.deckCommit.hash, commit);
  assert.equal(st.deckHistory.length, 1);
  assert.equal(st.deckHistory[0].hash, commit);
});

test('only A and K exit a marble; with everything at home other cards must be burned', () => {
  const st = game(4);
  setHand(st, 0, ['2', '9', 'Q']);
  const lm = moves(st, 0);
  assert.ok(lm.every((m) => m.kind === 'burn'));
  assert.equal(lm.length, 3);
  setHand(st, 0, ['A', 'K']);
  const lm2 = moves(st, 0);
  assert.deepEqual(lm2.map((m) => m.kind), ['exit', 'exit']);
});

test('exit kills an opponent sitting on my base, but is illegal when my own marble is there', () => {
  const st = game(4);
  const L = E.trackLength(st.settings);
  // opponent seat 1 marble on seat 0's base: seat1 base is at 19, so pos = L-19 relative
  put(st, 1, 0, 'track', L - 19);
  setHand(st, 0, ['A']);
  let lm = moves(st, 0);
  const ex = lm.find((m) => m.kind === 'exit');
  assert.ok(ex && ex.kills.length === 1);
  E.applyMove(st, 0, ex.id);
  assert.equal(marble(st, 1, 0).zone, 'home');
  assert.equal(marble(st, 0, 0).zone, 'track');
  setHand(st, 0, ['K']);
  lm = moves(st, 0);
  assert.ok(!lm.some((m) => m.kind === 'exit'));
  assert.ok(lm.some((m) => m.kind === 'king')); // may still move 13
});

test('a marble on its own base cannot be passed, even by a King', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 10);   // seat 0 marble at distance 10 -> abs 10
  put(st, 1, 0, 'track', 0);    // seat 1 marble on its own base (abs 19)
  setHand(st, 0, ['K', '10', '8']);
  const lm = moves(st, 0);
  assert.ok(!lm.some((m) => m.kind === 'king'));                         // 10+13 passes abs 19
  assert.ok(!lm.some((m) => m.kind === 'step' && m.rank === '10'));      // 10+10 passes abs 19
  assert.ok(lm.some((m) => m.rank === '8' && m.to.pos === 18));          // 10+8 = 18, stops before
});

test('a marble cannot jump over another marble of the same player (jumpOwn off by default)', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 5);
  put(st, 0, 1, 'track', 8);          // own marble 3 ahead
  put(st, 2, 0, 'track', 10 - 38 + 76); // partner marble at abs 10 (may be jumped)
  setHand(st, 0, ['6', 'K', '2']);
  let lm = moves(st, 0);
  assert.ok(!lm.some((m) => m.marbleId === 'm0_0' && m.rank === '6'));      // 5 -> 11 passes own at 8
  assert.ok(!lm.some((m) => m.marbleId === 'm0_0' && m.kind === 'king'));   // King may not jump own either
  assert.ok(lm.some((m) => m.marbleId === 'm0_0' && m.rank === '2'));       // 5 -> 7 is fine
  assert.ok(lm.some((m) => m.marbleId === 'm0_1' && m.rank === '6'));       // 8 -> 14 passes partner at 10: allowed
  // backwards too
  setHand(st, 0, ['4']);
  put(st, 0, 1, 'track', 3);
  lm = moves(st, 0);
  assert.ok(!lm.some((m) => m.marbleId === 'm0_0' && m.kind === 'back')); // 5 -> 1 passes own at 3
  // with the option on, jumping is allowed again
  const st2 = game(4, { jumpOwn: true });
  put(st2, 0, 0, 'track', 5); put(st2, 0, 1, 'track', 8);
  setHand(st2, 0, ['6']);
  assert.ok(moves(st2, 0).some((m) => m.marbleId === 'm0_0' && m.rank === '6'));
});

test('landing on a marble sends it home; landing on own marble is illegal', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 5);
  put(st, 2, 0, 'track', 11 - 38 + 76); // seat 2 base abs 38; we want abs 11 -> pos = (11-38) mod 76
  setHand(st, 0, ['6']);
  let lm = moves(st, 0);
  const mv = lm.find((m) => m.marbleId === 'm0_0');
  assert.deepEqual(mv.kills, ['m2_0']);
  E.applyMove(st, 0, mv.id);
  assert.equal(marble(st, 2, 0).zone, 'home');
  // own marble ahead by 6
  put(st, 0, 1, 'track', 17);
  setHand(st, 0, ['6']);
  lm = moves(st, 0);
  assert.ok(!lm.some((m) => m.marbleId === 'm0_0' && m.kind === 'step'));
});

test('safe zone: entered after a full lap, no overshoot, no passing inside', () => {
  const st = game(4);
  const L = E.trackLength(st.settings);
  put(st, 0, 0, 'track', L - 2);
  setHand(st, 0, ['3', '6', '2']);
  let lm = moves(st, 0);
  const three = lm.find((m) => m.rank === '3');
  assert.deepEqual(three.to, { zone: 'safe', pos: 2 }); // entry is hole 17 (L-2): 1 step is safe 0
  assert.ok(!lm.some((m) => m.rank === '6')); // L-2+6 -> safe index 5 does not exist
  const two = lm.find((m) => m.rank === '2');
  assert.deepEqual(two.to, { zone: 'safe', pos: 1 });
  // marble in safe cell 1 blocks another entering cell 2 via it
  put(st, 0, 1, 'safe', 1);
  setHand(st, 0, ['A']);
  lm = moves(st, 0);
  const moveA = lm.filter((m) => m.marbleId === 'm0_0');
  // from hole 17 an Ace as 1 goes straight up to safe 0 (ok), as 11 it overshoots
  assert.ok(moveA.some((m) => m.steps === 1));
  assert.ok(!moveA.some((m) => m.steps === 11));
});

test('the 4-back trick: a marble that backs up from base can enter the safe zone', () => {
  const st = game(4);
  const L = E.trackLength(st.settings);
  put(st, 0, 0, 'track', 0);
  setHand(st, 0, ['4']);
  let lm = moves(st, 0);
  const back = lm.find((m) => m.kind === 'back');
  assert.equal(back.to.pos, L - 4);
  E.applyMove(st, 0, back.id);
  setHand(st, 0, ['4']);
  lm = moves(st, 0);
  const fwd = lm.find((m) => m.kind === 'step' && m.rank === '4');
  assert.equal(fwd, undefined); // 4 only moves backwards
  setHand(st, 0, ['5']);
  lm = moves(st, 0);
  const five = lm.find((m) => m.marbleId === 'm0_0');
  assert.deepEqual(five.to, { zone: 'safe', pos: 2 }); // 16, 17, then safe 0, 1, 2
});

test('7 can be split across two marbles; both parts validated sequentially', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 0);
  put(st, 0, 1, 'track', 10);
  setHand(st, 0, ['7']);
  const lm = moves(st, 0);
  assert.ok(lm.some((m) => m.kind === 'seven' && m.parts.length === 1 && m.parts[0].steps === 7));
  const split = lm.filter((m) => m.kind === 'seven' && m.parts.length === 2);
  assert.ok(split.length > 0);
  const mv = split.find((m) => m.parts[0].steps === 3 && m.parts[0].marbleId === 'm0_0');
  E.applyMove(st, 0, mv.id);
  assert.equal(marble(st, 0, 0).pos, 3);
  assert.equal(marble(st, 0, 1).pos, 14);
});

test('Jack swaps with any non-protected marble on the track', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 3);        // abs 3
  put(st, 1, 0, 'track', 0);        // opponent on own base: protected
  put(st, 1, 1, 'track', 30);       // abs 49
  setHand(st, 0, ['J']);
  const lm = moves(st, 0);
  assert.equal(lm.length, 1);
  assert.equal(lm[0].targetId, 'm1_1');
  E.applyMove(st, 0, lm[0].id);
  assert.equal(E.absOf(marble(st, 0, 0), st.settings), 49);
  assert.equal(E.absOf(marble(st, 1, 1), st.settings), 3);
});

test('5 may move an opponent marble but cannot push it into its safe zone (it laps instead)', () => {
  const st = game(4);
  const L = E.trackLength(st.settings);
  put(st, 0, 0, 'track', 20);
  put(st, 1, 0, 'track', 2);
  put(st, 3, 0, 'track', L - 3);
  setHand(st, 0, ['5']);
  const lm = moves(st, 0);
  assert.ok(lm.some((m) => m.marbleId === 'm1_0' && m.to.pos === 7));
  assert.ok(lm.some((m) => m.marbleId === 'm3_0' && m.to.zone === 'track' && m.to.pos === 2)); // pushed past its entrance
  assert.ok(!lm.some((m) => m.marbleId === 'm3_0' && m.to.zone === 'safe'));
});

test('King 13 kills every marble it passes', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 1);
  put(st, 1, 0, 'track', 5 - 19 + 76);  // abs 5
  put(st, 2, 0, 'track', 9 - 38 + 76);  // abs 9
  setHand(st, 0, ['K']);
  const lm = moves(st, 0);
  const k = lm.find((m) => m.kind === 'king');
  assert.deepEqual(new Set(k.kills), new Set(['m1_0', 'm2_0']));
  E.applyMove(st, 0, k.id);
  assert.equal(marble(st, 1, 0).zone, 'home');
  assert.equal(marble(st, 2, 0).zone, 'home');
  assert.equal(marble(st, 0, 0).pos, 14);
});

test('a finished player moves the partner marbles; team with all 8 safe wins', () => {
  const st = game(4);
  for (let k = 0; k < 4; k++) put(st, 0, k, 'safe', k);
  put(st, 2, 0, 'track', 5);
  setHand(st, 0, ['2']);
  const lm = moves(st, 0);
  assert.ok(lm.every((m) => m.marbleId === 'm2_0'));
  for (let k = 1; k < 4; k++) put(st, 2, k, 'safe', k);
  put(st, 2, 0, 'track', E.trackLength(st.settings) - 3); // 16: 2 steps = 17, safe 0
  setHand(st, 0, ['2']);
  const lm2 = moves(st, 0);
  E.applyMove(st, 0, lm2[0].id);
  assert.equal(st.phase, 'finished');
  assert.equal(st.winner, 0);
});

test('joker plays as any rank', () => {
  const st = game(4, { jokers: true });
  setHand(st, 0, ['JOKER']);
  const lm = moves(st, 0);
  assert.ok(lm.some((m) => m.kind === 'exit' && m.rank === 'A'));
  assert.ok(lm.some((m) => m.kind === 'exit' && m.rank === 'K'));
});

test('private views never leak other hands; public state hides stock order', () => {
  const st = game(4);
  const pub = E.publicState(st);
  assert.equal(pub.hands, undefined);
  assert.equal(pub.stock, undefined);
  assert.equal(pub.deckSalt, undefined);
  assert.equal(pub.deckOrder, undefined);
  assert.ok(pub.deckCommit.hash);
  const pv = E.privateView(st, 1);
  assert.equal(pv.hand.length, 5);
});

test('6 and 8 player games run to completion with bots (no illegal states)', () => {
  for (const n of [4, 6, 8]) {
    const st = game(n, { jokers: n === 8 });
    let turns = 0;
    while (st.phase === 'playing' && turns < 20000) {
      const id = E.chooseBotMove(st, st.turn);
      assert.notEqual(id, null);
      E.applyMove(st, st.turn, id);
      turns++;
      // invariants
      const onTrack = st.marbles.filter((m) => m.zone === 'track').map((m) => E.absOf(m, st.settings));
      assert.equal(new Set(onTrack).size, onTrack.length, 'two marbles on one cell');
      for (const m of st.marbles) if (m.zone === 'safe') assert.ok(m.pos >= 0 && m.pos < st.settings.safeCells);
    }
    assert.equal(st.phase, 'finished', `${n}p game did not finish in ${turns} turns`);
  }
});

test('complex cards: black Jack swaps, red Jack moves 11', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 3);
  put(st, 1, 1, 'track', 30);
  setHand(st, 0, ['JS', 'JH']);
  const lm = moves(st, 0);
  const black = lm.filter((m) => m.cardId === 't0_0'), red = lm.filter((m) => m.cardId === 't0_1');
  assert.ok(black.every((m) => m.kind === 'jack') && black.length === 1);
  assert.ok(red.every((m) => m.kind === 'step' && m.steps === 11) && red.length === 1);
  // with complex cards off, any Jack swaps
  const st2 = game(4, { complexCards: false });
  put(st2, 0, 0, 'track', 3); put(st2, 1, 1, 'track', 30);
  setHand(st2, 0, ['JH']);
  assert.ok(moves(st2, 0).every((m) => m.kind === 'jack'));
});

test('red Queen may burn a card of your choice from the next player; black Queen only moves 12', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 3);
  setHand(st, 0, ['QH', 'QS']);
  setHand(st, 1, ['2', '3', '4']);
  const lm = moves(st, 0);
  const burns = lm.filter((m) => m.kind === 'queenBurn');
  assert.equal(burns.length, 3);
  assert.ok(burns.every((m) => m.cardId === 't0_0' && m.target === 1));
  assert.ok(lm.some((m) => m.cardId === 't0_1' && m.kind === 'step' && m.steps === 12));
  assert.ok(!lm.some((m) => m.cardId === 't0_1' && m.kind === 'queenBurn'));
  const pick = burns.find((m) => m.index === 1);
  E.applyMove(st, 0, pick.id);
  assert.deepEqual(st.hands[1].map((c) => c.rank), ['2', '4']);
  assert.equal(st.turn, 1);
  assert.equal(st.pendingBurn, null);
});

test('10 may force the next player to burn a card of THEIR choice; the victim then loses the turn', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 3);
  setHand(st, 0, ['10']);
  setHand(st, 1, ['A', '9']);
  put(st, 1, 0, 'track', 5);
  const lm = moves(st, 0);
  const ten = lm.find((m) => m.kind === 'tenBurn');
  assert.ok(ten && ten.target === 1);
  assert.ok(lm.some((m) => m.kind === 'step' && m.steps === 10));
  E.applyMove(st, 0, ten.id);
  assert.equal(st.turn, 1);
  assert.equal(st.pendingBurn, 1);
  const forced = E.legalMoves(st, 1);
  assert.ok(forced.length === 2 && forced.every((m) => m.kind === 'burn' && m.forced));
  E.applyMove(st, 1, forced.find((m) => m.rank === 'A').id); // player 1 chooses to burn the Ace
  assert.equal(st.turn, 2, 'after the forced burn the victim\'s turn is over');
  assert.equal(st.pendingBurn, null);
  assert.deepEqual(st.hands[1].map((c) => c.rank), ['9']);
});

test('near home: last free safe cell is 0, so cards that overshoot it can only be burned', () => {
  const st = game(4);
  const L = E.trackLength(st.settings);
  put(st, 0, 0, 'safe', 3);
  put(st, 0, 1, 'safe', 2);
  put(st, 0, 2, 'safe', 1);
  put(st, 0, 3, 'track', L - 3);
  setHand(st, 0, ['9', 'Q', '8']);
  st.turn = 0; st.pendingBurn = null;
  let lm = E.legalMoves(st, 0);
  assert.ok(lm.length > 0);
  assert.ok(lm.every((m) => m.kind === 'burn'), 'every card overshoots the last free safe cell');
  setHand(st, 0, ['2']); // 16 -> 17 -> safe 0
  st.turn = 0; st.pendingBurn = null;
  lm = E.legalMoves(st, 0);
  assert.equal(lm.length, 1);
  assert.deepEqual(lm[0].to, { zone: 'safe', pos: 0 });
});

test('players with no cards left are skipped until the next deal', () => {
  const st = game(4);
  setHand(st, 0, ['2']); setHand(st, 1, []); setHand(st, 2, ['3']); setHand(st, 3, []);
  put(st, 0, 0, 'track', 3); put(st, 2, 0, 'track', 3);
  st.turn = 0;
  E.applyMove(st, 0, E.legalMoves(st, 0)[0].id);
  assert.equal(st.turn, 2);
  E.applyMove(st, 2, E.legalMoves(st, 2)[0].id);
  assert.equal(st.dealNo, 2, 'all hands empty -> new deal');
});

test('base protection is absolute: another player\'s 5 cannot move a marble off its own base', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 20);
  put(st, 1, 0, 'track', 0);    // seat 1 on its own base
  put(st, 2, 0, 'track', 0);    // partner on its own base
  setHand(st, 0, ['5']);
  const lm = moves(st, 0);
  assert.ok(!lm.some((m) => m.marbleId === 'm1_0'));
  assert.ok(!lm.some((m) => m.marbleId === 'm2_0'));
  assert.ok(lm.some((m) => m.marbleId === 'm0_0'));
});

// abs helper: position of seat's marble that should sit at absolute cell `abs` (4 players, L = 76)
const rel = (seat, abs) => ((abs - seat * 19) % 76 + 76) % 76;

test('wall: two opponent team-mates on consecutive cells block a 6 (and a King)', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 2);
  put(st, 1, 0, 'track', rel(1, 4));
  put(st, 3, 0, 'track', rel(3, 5));    // seats 1 and 3 are a team
  setHand(st, 0, ['6', 'K', '3']);
  const lm = moves(st, 0);
  assert.ok(!lm.some((m) => m.marbleId === 'm0_0' && m.rank === '6'));
  assert.ok(!lm.some((m) => m.marbleId === 'm0_0' && m.kind === 'king'));
  assert.ok(!lm.some((m) => m.marbleId === 'm0_0' && m.rank === '3')); // landing on the second marble
  // backwards too
  put(st, 0, 0, 'track', 7);
  setHand(st, 0, ['4']);
  assert.ok(!moves(st, 0).some((m) => m.marbleId === 'm0_0' && m.kind === 'back')); // 7 -> 3 passes 5 then 4
});

test('wall: landing on the first marble of a wall is legal (kill)', () => {
  const st = game(4);
  put(st, 0, 0, 'track', 2);
  put(st, 1, 0, 'track', rel(1, 4));
  put(st, 3, 0, 'track', rel(3, 5));
  setHand(st, 0, ['2']);
  const mv = moves(st, 0).find((m) => m.marbleId === 'm0_0' && m.rank === '2');
  assert.ok(mv);
  assert.deepEqual(mv.kills, ['m1_0']);
});

test('wall: my own team wall blocks an opponent; a mixed-team pair does not block', () => {
  const st = game(4);
  put(st, 1, 0, 'track', rel(1, 30));
  put(st, 0, 0, 'track', rel(0, 32));
  put(st, 2, 0, 'track', rel(2, 33));   // seats 0 and 2 are a team
  setHand(st, 1, ['6']);
  assert.ok(!moves(st, 1).some((m) => m.marbleId === 'm1_0'));
  // replace the partner by an opponent: no wall any more, jumping is fine
  put(st, 2, 0, 'home', -1);
  put(st, 3, 0, 'track', rel(3, 33));
  setHand(st, 1, ['6']);
  const mv = moves(st, 1).find((m) => m.marbleId === 'm1_0');
  assert.ok(mv && mv.to.pos === rel(1, 36));
});
