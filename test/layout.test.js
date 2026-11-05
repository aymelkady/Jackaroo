import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armLayout } from '../shared/layout.js';

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const C = { x: 500, y: 500 };

for (const N of [4, 6, 8]) {
  test(`board layout is one continuous loop for ${N} players`, () => {
    const g = armLayout({ players: N, cellsPerPlayer: 19, safeCells: 4, marblesPerPlayer: 4 }, 0);
    const L = N * 19;
    const { sp, rc, R, centerR } = g;
    assert.equal(g.track.length, L);
    // every consecutive pair of holes is within reach: no jumps anywhere on the board
    for (let a = 0; a < L; a++) {
      const b = (a + 1) % L;
      assert.ok(dist(g.track[a], g.track[b]) <= 1.9 * sp, `gap between hole ${a} and ${b}: ${dist(g.track[a], g.track[b]).toFixed(1)}`);
      assert.ok(dist(g.track[a], g.track[b]) >= 2.1 * rc, `holes ${a} and ${b} too close`);
    }
    for (let s = 0; s < N; s++) {
      const star = g.track[s * 19];
      assert.equal(star.label, '★');
      const h18 = g.track[(s * 19 - 1 + L) % L], h1 = g.track[s * 19 + 1];
      assert.equal(h18.label, '18'); assert.equal(h1.label, '1');
      assert.ok(dist(h18, star) <= 1.5 * sp, 'hole 18 ends beside the star');
      assert.ok(dist(h1, star) <= 1.5 * sp, 'hole 1 starts beside the star');
      assert.ok(dist(g.safe[s][0], h18) <= 1.6 * sp, 'safe column entered from 18');
      assert.ok(dist(g.safe[s][0], star) > 1.6 * sp, 'the star is not the safe entrance');
      for (let k = 6; k <= 9; k++) assert.equal(g.track[s * 19 + k].where, 'ring');
      assert.ok(Math.hypot(g.label[s].x - 500, g.label[s].y - 500) < R, 'chip inside the board');
    }
    const all = [...g.track, ...g.safe.flat(), ...g.home.flat()];
    for (let i = 0; i < all.length; i++) {
      assert.ok(dist(all[i], C) <= R - rc, `hole ${i} inside the board`);
      assert.ok(dist(all[i], C) >= centerR + rc, `hole ${i} clear of the centre circle`);
      for (let j = i + 1; j < all.length; j++) assert.ok(dist(all[i], all[j]) >= 2.1 * rc, `holes ${i} and ${j} overlap (${dist(all[i], all[j]).toFixed(1)})`);
    }
    for (const p of g.home.flat()) for (const t of g.track) assert.ok(dist(p, t) >= 2.2 * rc, 'pen too close to the track');
    if (N === 4) {
      const rows = [];
      for (let k = 0; k <= 18; k++) { const t = g.track[k]; rows.push({ k, label: t.label, where: t.where, x: +t.x.toFixed(1), y: +t.y.toFixed(1) }); }
      g.safe[0].forEach((p, i) => rows.push({ k: `safe${i + 1}`, label: 'S', where: 'safe', x: +p.x.toFixed(1), y: +p.y.toFixed(1) }));
      console.table(rows);
    }
  });
}
