// Exhaustive sweeps over the engine: near-home moves for every seat/hole/rank,
// and full bot games checked against movement invariants after every move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../shared/engine.js';

function fresh(players = 4, extra = {}) {
  const st = E.createGame({ code: 'SWEEP', hostId: 'h', settings: E.normalizeSettings({ players, randomTeams: false, ...extra }) });
  for (let s = 0; s < players; s++) E.addPlayer(st, { id: 'p' + s, name: 'P' + s, isBot: true });
  E.startGame(st);
  return st;
}
const card = (rank, suit) => ({ id: 'c_' + rank + suit, rank, suit: rank === 'JOKER' ? null : suit });
const SKIP = new Set(['burn', 'exit', 'queenBurn', 'tenBurn', 'jack']);

test('near home: no card ever carries a marble past its safe entrance (every seat, hole, rank)', () => {
  const bad = [];
  let checked = 0;
  for (const players of [4, 6]) {
    const L = players * 19;
    for (let seat = 0; seat < players; seat++) {
      for (let pos = L - 14; pos <= L - 1; pos++) {
        for (const rank of E.RANKS.concat(['JOKER'])) for (const suit of ['S', 'H']) {
          const st = fresh(players);
          st.turn = seat; st.pendingBurn = null;
          const mine = st.marbles.filter((m) => m.owner === seat);
          mine[0].zone = 'track'; mine[0].pos = pos;
          mine[1].zone = 'safe'; mine[1].pos = 3; // safe zone partly full
          st.hands[seat] = [card(rank, suit)];
          for (const mv of E.legalMoves(st, seat)) {
            if (SKIP.has(mv.kind)) continue;
            const parts = mv.kind === 'seven' ? mv.parts : [{ marbleId: mv.marbleId, steps: mv.steps, to: mv.to }];
            for (const p of parts) {
              if (p.marbleId !== mine[0].id || !(p.steps > 0)) continue;
              checked++;
              const where = { players, seat, pos, rank, suit, steps: p.steps, to: p.to };
              const entry = L - 2; // safe column entered straight up from hole 17
              if (pos > entry) {
                // on hole 18: missed the entrance, goes round again
                if (!(p.to.zone === 'track' && p.to.pos === (pos + p.steps) % L)) bad.push({ ...where, why: 'hole 18 did not lap' });
              } else if (pos + p.steps <= entry) {
                if (!(p.to.zone === 'track' && p.to.pos === pos + p.steps)) bad.push({ ...where, why: 'wrong track landing' });
              } else if (!(p.to.zone === 'safe' && p.to.pos === pos + p.steps - entry - 1 && p.to.pos < 4)) {
                bad.push({ ...where, why: 'did not go up into the safe zone' });
              }
              if (p.to.zone === 'track' && p.to.pos < pos && pos <= entry) bad.push({ ...where, why: 'wrapped past the base' });
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 0, 'sweep checked no moves');
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} violations`);
});

test('full games keep the movement invariants', () => {
  const viol = [];
  for (const players of [4, 6, 8]) for (let g = 0; g < 2; g++) {
    const st = fresh(players, { jokers: g === 1 });
    const L = players * 19;
    let turns = 0;
    while (st.phase === 'playing' && turns++ < 20000) {
      const seat = st.turn;
      const id = E.chooseBotMove(st, seat);
      const mv = E.legalMoves(st, seat).find((m) => m.id === id);
      assert.ok(mv, 'bot chose an illegal move');
      const before = new Map(st.marbles.map((m) => [m.id, { ...m }]));
      const ctrl = E.controlledSeat(st, seat);
      E.applyMove(st, seat, id);
      const free = mv.kind === 'back' || mv.kind === 'jack';
      for (const m of st.marbles) {
        const b = before.get(m.id);
        const info = { players, game: g, kind: mv.kind, rank: mv.rank, id: m.id, from: b.pos, to: m.pos };
        if (b.zone === 'track' && m.zone === 'track' && m.pos !== b.pos && !free) {
          // lapping is only legal from hole 18 (missed entrance) or when another player's 5 pushes the marble
          const mayLap = b.pos > L - 2 || (mv.kind === 'five' && m.owner !== ctrl);
          if (m.pos < b.pos && !mayLap) viol.push({ ...info, why: 'wrapped past base' });
          if ((m.pos - b.pos + L) % L > 13) viol.push({ ...info, why: 'moved more than 13' });
        }
        if (b.zone === 'safe' && m.zone !== 'safe') viol.push({ ...info, why: 'left safe zone' });
      }
    }
    if (st.phase !== 'finished') viol.push({ players, game: g, why: 'did not finish' });
  }
  assert.deepEqual(viol.slice(0, 5), [], `${viol.length} violations`);
});
