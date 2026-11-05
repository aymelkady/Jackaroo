// Board geometry for the "arm" boards (saudi, jj): every seat owns an arm of 19 track holes
// [1..18, star] drawn as a U (left column inward, arc, right column outward, outer row toward the star),
// with the safe column in the middle of the U and the home pen at the player's left.
// Pure function, no DOM: runs in Node (tests) and in browsers.

export const SUIT_GLYPHS = ['♠', '♥', '♦', '♣'];
export const STAR = '★';

const SPACING = { 4: 34, 6: 30, 8: 27 };

// Track index -> { arm, idx }. idx 0..17 are holes 1..18, idx 18 is the star (seat's base).
export function armIndex(a, N, cpp = 19) {
  const L = N * cpp;
  const arm = Math.floor((a + cpp - 1) / cpp) % N;
  const idx = (((a - (arm * cpp - (cpp - 1))) % L) + L) % L;
  return { arm, idx };
}

// Local (a, b) of arm idx 0..18, in units where sp/d/R1 are given.
function localTrack(idx, sp, d, R1) {
  if (idx <= 5) return [d, R1 - (idx + 1) * sp];
  if (idx === 6) return [1.13 * sp, R1 - 6.88 * sp];
  if (idx === 7) return [0, R1 - 7.35 * sp];
  if (idx === 8) return [-1.13 * sp, R1 - 6.88 * sp];
  if (idx <= 14) return [-d, R1 - (5.5 - (idx - 9)) * sp];
  if (idx <= 17) return [(idx - 16) * sp, R1];
  return [d, R1];
}

export function armLayout(settings, mySeat = 0) {
  const N = settings.players;
  const cpp = settings.cellsPerPlayer || 19;
  const safeCells = settings.safeCells || 4;
  const mpp = settings.marblesPerPlayer || 4;
  const C = 500, R = 475, R1 = 400;
  const sp = SPACING[N] || 27;
  const rc = 0.42 * sp;
  const d = 2 * sp;
  const centerR = Math.min(105, R1 - 8.6 * sp);
  const L = N * cpp;

  const frames = [];
  for (let s = 0; s < N; s++) {
    const theta = Math.PI / 2 + ((s - mySeat) * 2 * Math.PI) / N;
    const o = { x: Math.cos(theta), y: Math.sin(theta) };
    const l = { x: -o.y, y: o.x };
    frames.push({ o, l, at: (a, b) => ({ x: C + l.x * a + o.x * b, y: C + l.y * a + o.y * b }) });
  }

  const track = new Array(L);
  for (let a = 0; a < L; a++) {
    const { arm, idx } = armIndex(a, N, cpp);
    const [la, lb] = localTrack(idx, sp, d, R1);
    const p = frames[arm].at(la, lb);
    track[a] = { x: p.x, y: p.y, label: idx < cpp - 1 ? String(idx + 1) : STAR, arm, idx };
  }

  const safe = [], home = [], label = [], suit = [];
  for (let s = 0; s < N; s++) {
    const f = frames[s];
    const sc = [];
    for (let k = 1; k <= safeCells; k++) sc.push(f.at(0, R1 - k * sp));
    safe.push(sc);
    const pa = d + 2.6 * sp, pb = R1 - 1.7 * sp, off = 0.55 * sp;
    const offs = [[-off, off], [off, off], [-off, -off], [off, -off]];
    home.push(offs.slice(0, mpp).map(([da, db]) => f.at(pa + da, pb + db)));
    const sg = f.at(d + 2.6 * sp, R1 - 3.9 * sp);
    suit.push({ x: sg.x, y: sg.y, glyph: SUIT_GLYPHS[s % 4] });
    const lp = f.at(0, R1 + (N > 4 ? 1.9 : 1.45) * sp); // more players: push the chips out to the rim
    // chip sits tangent to the rim, text kept upright: rot in (-90, 90]
    let rot = (Math.atan2(f.o.y, f.o.x) * 180) / Math.PI - 90;
    if (rot <= -90) rot += 180;
    if (rot > 90) rot -= 180;
    label.push({
      x: lp.x, y: lp.y,
      angle: (Math.atan2(f.o.y, f.o.x) * 180) / Math.PI,
      horizontal: Math.abs(f.o.x) < 0.7,
      rot: Math.round(rot),
    });
  }
  return { track, safe, home, label, suit, sp, rc, d, R, R1, centerR, C, N, L, frames: frames.map(({ o, l }) => ({ o, l })) };
}
