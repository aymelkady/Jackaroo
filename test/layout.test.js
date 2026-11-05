import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armLayout, armIndex } from '../shared/layout.js';

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const C = { x: 500, y: 500 };

test('armIndex maps bases to stars and the hole before a base to hole 18', () => {
  for (const N of [4, 6, 8]) {
    const L = N * 19;
    for (let s = 0; s < N; s++) {
      assert.deepEqual(armIndex(s * 19, N), { arm: s, idx: 18 });
      assert.deepEqual(armIndex((s * 19 - 1 + L) % L, N), { arm: s, idx: 17 });
      assert.deepEqual(armIndex((s * 19 + 1) % L, N), { arm: (s + 1) % N, idx: 0 });
    }
  }
});

for (const N of [4, 6, 8]) {
  test(`armLayout geometry checks for ${N} players`, () => {
    const g = armLayout({ players: N, cellsPerPlayer: 19, safeCells: 4, marblesPerPlayer: 4 }, 0);
    const L = N * 19;
    const { sp, rc, R, centerR } = g;
    assert.equal(g.track.length, L);
    // consecutive holes are close, except exactly N inter-arm jumps (star -> next arm's hole 1)
    let jumps = 0;
    for (let a = 0; a < L; a++) {
      const b = (a + 1) % L;
      if (dist(g.track[a], g.track[b]) > 1.9 * sp) {
        jumps++;
        assert.equal(g.track[a].idx, 18, `jump must start at a star (a=${a})`);
        assert.equal(g.track[b].idx, 0);
        assert.equal(g.track[b].arm, (g.track[a].arm + 1) % N);
      }
    }
    assert.equal(jumps, N);
    const byArm = (s, idx) => g.track.find((t) => t.arm === s && t.idx === idx);
    for (let s = 0; s < N; s++) {
      const star = byArm(s, 18);
      assert.equal(star.label, '★');
      assert.ok(dist(byArm(s, 17), star) <= 1.5 * sp, 'hole 18 next to star');
      assert.ok(dist(byArm(s, 0), star) <= 1.5 * sp, 'hole 1 next to star');
      assert.ok(dist(g.safe[s][0], byArm(s, 17)) <= 1.6 * sp, 'safe entry next to hole 18');
      assert.ok(dist(byArm(s, 7), C) > centerR + rc, 'arc apex outside the centre circle');
      assert.ok(Math.hypot(g.label[s].x - 500, g.label[s].y - 500) < R, 'label inside board');
    }
    const all = [...g.track, ...g.safe.flat(), ...g.home.flat()];
    for (let i = 0; i < all.length; i++) {
      assert.ok(dist(all[i], C) <= R - rc, `hole ${i} inside the board`);
      for (let j = i + 1; j < all.length; j++) {
        assert.ok(dist(all[i], all[j]) >= 2.1 * rc, `holes ${i} and ${j} overlap`);
      }
    }
    for (const p of g.home.flat()) {
      for (const t of g.track) assert.ok(dist(p, t) >= 2.2 * rc, 'pen too close to the track');
    }
    if (N === 4) {
      const rows = [];
      for (let idx = 0; idx <= 18; idx++) { const t = byArm(0, idx); rows.push({ idx, label: t.label, x: +t.x.toFixed(1), y: +t.y.toFixed(1) }); }
      g.safe[0].forEach((p, k) => rows.push({ idx: `safe${k + 1}`, label: 'S', x: +p.x.toFixed(1), y: +p.y.toFixed(1) }));
      console.log('N=4 bottom arm (seat 0):');
      console.table(rows);
    }
  });
}
