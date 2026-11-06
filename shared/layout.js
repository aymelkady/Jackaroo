// Board geometry for the real Saudi / JJ boards, used by every board design (they differ only in frame, wood and inlay).
//
// The track is ONE continuous loop of N*19 holes. Between two stars the path is:
//   star_s -> 1..5 up seat s's LEFT column (toward the centre)
//          -> 6..9 along the central ring (the quadrant between arm s and arm s+1)
//          -> 10..14 down arm s+1's RIGHT column (toward the rim)
//          -> 15..18 along arm s+1's outer row -> star_{s+1}
// So every marble walks the whole board; a seat's safe column sits in the middle of its own arm and is
// entered straight up from hole 17. Holes 18 and the star sit beside the column, not on the way home.
// The pen (4 waiting marbles) sits beside the star.
// Pure function, no DOM: runs in Node (tests) and in browsers.

export const SUIT_GLYPHS = ['♠', '♥', '♦', '♣'];
export const STAR = '★';

export const SPACING = { 4: 34, 6: 30, 8: 24 };

export function armLayout(settings, mySeat = 0) {
  const N = settings.players;
  const cpp = settings.cellsPerPlayer || 19;
  const safeCells = settings.safeCells || 4;
  const mpp = settings.marblesPerPlayer || 4;
  const C = 500, R = 475, R1 = 400;
  const sp = SPACING[N] || 24;
  const rc = 0.42 * sp;
  const d = 2 * sp;                       // column half-separation
  const Rr = Math.hypot(R1 - 5 * sp, d);  // ring radius: where the column tops sit
  const phi = Math.atan2(d, R1 - 5 * sp); // angular offset of a column from its arm axis
  const step = (2 * Math.PI) / N;
  const delta = step - 2 * phi;           // ring angle between the two column tops of one quadrant
  const centerR = Rr - 1.6 * sp;
  const L = N * cpp;

  const frames = [];
  for (let s = 0; s < N; s++) {
    const theta = Math.PI / 2 + ((s - mySeat) * step);
    const o = { x: Math.cos(theta), y: Math.sin(theta) };
    const l = { x: -o.y, y: o.x }; // the player's left = clockwise on screen
    frames.push({ theta, o, l, at: (a, b) => ({ x: C + l.x * a + o.x * b, y: C + l.y * a + o.y * b }) });
  }
  const onRing = (angle, r = Rr) => ({ x: C + r * Math.cos(angle), y: C + r * Math.sin(angle) });

  const track = new Array(L);
  for (let s = 0; s < N; s++) {
    const f = frames[s], fn = frames[(s + 1) % N];
    for (let k = 0; k < cpp; k++) {
      const a = s * cpp + k;
      let p, lp, where;
      if (k === 0) { p = f.at(d, R1); lp = null; where = 'star'; }
      else if (k <= 5) { p = f.at(d, R1 - k * sp); lp = f.at(k === 1 ? d + 0.85 * sp : d - 0.85 * sp, R1 - k * sp); where = 'left'; }
      else if (k <= 9) {
        const ang = f.theta + phi + ((k - 5) * delta) / 5;
        p = onRing(ang); lp = onRing(ang, Rr - 0.85 * sp); where = 'ring';
      } else if (k <= 14) { p = fn.at(-d, R1 - (15 - k) * sp); lp = fn.at(k === 14 ? -d - 0.85 * sp : -d + 0.85 * sp, R1 - (15 - k) * sp); where = 'right'; }
      else { // 15..18 along the next arm's outer row toward its star
        const aa = (k - 17) * sp; // 15 -> -2sp (corner), 16 -> -sp, 17 -> 0, 18 -> +sp
        p = fn.at(aa, R1);
        lp = k === 15 ? fn.at(aa - 0.85 * sp, R1) : k === 17 ? null : fn.at(aa, R1 - 0.8 * sp);
        where = 'outer';
      }
      track[a] = { x: p.x, y: p.y, label: k === 0 ? STAR : String(k), seg: s, k, where, lx: lp ? lp.x : null, ly: lp ? lp.y : null };
    }
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
    const lp = f.at(0, R1 + (N > 4 ? 1.9 : 1.45) * sp); // chips on the rim; more players: further out
    let rot = (Math.atan2(f.o.y, f.o.x) * 180) / Math.PI - 90; // tangent to the rim, text upright
    if (rot <= -90) rot += 180;
    if (rot > 90) rot -= 180;
    label.push({ x: lp.x, y: lp.y, angle: (Math.atan2(f.o.y, f.o.x) * 180) / Math.PI, horizontal: Math.abs(f.o.x) < 0.7, rot: Math.round(rot) });
  }
  return { track, safe, home, label, suit, sp, rc, d, R, R1, Rr, centerR, C, N, L, frames: frames.map(({ o, l, theta }) => ({ o, l, theta })) };
}
