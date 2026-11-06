# Plan: real JJ board layout + rule corrections

> **Revision 2 (after the owner's correction):** the arms are NOT closed loops. The inner arcs of all arms
> form one continuous ring around the centre. Between two stars the path is 1-5 up seat s's left column,
> 6-9 along the ring quadrant, 10-14 down seat s+1's right column, 15-18 along seat s+1's outer row, then
> seat s+1's star. One loop of N*19 holes, no jumps. Section 1 below is superseded by `shared/layout.js`
> and `test/layout.test.js` (which now require zero jumps). Ring radius `Rr = hypot(R1-5sp, 2sp)`,
> spacing 34/30/24 for 4/6/8 players, centre circle `Rr - 1.6sp`.

Status: approved spec. Implement exactly this; do not redesign.

## 0. Why

The current "cross" design draws each arm as `[star, 1..18]` with the safe column at the star. Real Saudi boards
(round "JJ" board and the clipped-square board, see photos) draw each arm as `[1..18, star]`: the star is at the
player's LEFT corner of the outer row, hole 18 ends next to the star, and the safe column sits in the middle of the
arm, entered straight up from hole 17. The engine enters the safe zone from hole 17
(`pos L-2`), so only the drawing (index -> position) and labels change. No engine track change.

## 1. Geometry (pure function, new file `shared/layout.js`, unit-tested in Node)

```
armLayout({ players: N, cellsPerPlayer: 19, safeCells: 4, marblesPerPlayer: 4 }, mySeat)
  -> { track: Array<{x,y,label,arm}> (length N*19), safe: [N][4]{x,y}, home: [N][4]{x,y},
       label: [N]{x,y,angle,horizontal}, suit: [N]{x,y}, sp, rc, d, R, R1, centerR }
```

Board: 1000x1000 viewBox, centre C=(500,500), board radius R=475, outer-row radius R1=400.
Hole spacing `sp` by player count: N=4 -> 34, N=6 -> 30, N=8 -> 27. Hole radius `rc = 0.42*sp`.
Column half-separation `d = 2*sp`. Centre circle radius `centerR = min(105, R1 - 8.6*sp)`.

Seat s sits at screen angle `theta_s = pi/2 + (s - mySeat) * 2*pi/N` (own seat at the bottom, seats increase
clockwise on screen). Outward unit `o = (cos theta, sin theta)`; the player's LEFT unit `l = (-o.y, o.x)`.
A local point (a, b) means `C + l*a + o*b` (a = toward the player's left, b = distance from the centre).

Within arm s, index `idx` 0..18 (idx 18 = star) sits at:

| idx | holes | local (a, b) |
|---|---|---|
| 0..5 | 1..6 (left column, inward) | (d, R1 - k*sp), k = idx+1 |
| 6 | 7 | (1.13*sp, R1 - 6.88*sp) |
| 7 | 8 (apex) | (0, R1 - 7.35*sp) |
| 8 | 9 | (-1.13*sp, R1 - 6.88*sp) |
| 9..14 | 10..15 (right column, outward) | (-d, R1 - (5.5 - (idx-9))*sp)  i.e. 10 at R1-5.5sp ... 15 at R1-0.5sp |
| 15,16,17 | 16,17,18 (outer row, toward the star) | (-sp, R1), (0, R1), (sp, R1) |
| 18 | star | (d, R1) = (2sp, R1) |

Safe column (4): `(0, R1 - k*sp)`, k = 1..4 (first safe hole directly above hole 17, entered straight up from 17).
Home pen (4, 2x2): centre `(d + 2.6*sp, R1 - 1.7*sp)`, offsets (+-0.55*sp, +-0.55*sp) along (l, o).
Suit glyph position: `(d + 2.6*sp, R1 - 3.9*sp)`; suits by seat: ♠ ♥ ♦ ♣ (then repeat).
Chip/label: `(0, R1 + 1.35*sp)`; `horizontal = |o.x| < 0.7`; `angle = atan2(o.y, o.x)` in degrees (side seats
rotate the HTML chip: angle < 0 -> -90, else 90, as the current code does).

Engine index mapping (L = N*19): arm of abs index a: `arm = floor((a + 18) / 19) % N`;
`idx = (a - (arm*19 - 18) + L) % L` (0..18); `label = idx + 1` for idx < 18, star for idx 18.
Check: abs `s*19` (seat s's base, pos 0) -> arm s, idx 18 = star. abs `s*19 - 1` -> arm s, idx 17 = hole 18.

### 1.1 Mathematical checks (write them as tests in `test/layout.test.js`)

For N in [4, 6, 8], mySeat 0:
- every consecutive pair of track indices `a, a+1` (mod L) is within `1.9*sp`, EXCEPT exactly N pairs
  (star of arm s -> hole 1 of arm s+1), which are the inter-arm jumps;
- hole 18 of each arm is within `1.5*sp` of its star, and hole 1 is within `1.5*sp` of the star;
- first safe hole of arm s is within `1.6*sp` of hole 18 of arm s;
- all holes (track, safe, home) are at least `2.1*rc` apart from each other (no overlap);
- every hole lies inside radius `R - rc`; every arc apex (idx 7) lies outside `centerR + rc`;
- pens do not come within `2.2*rc` of any track hole of any arm;
- label point lies inside R.
Print the N=4 bottom-arm coordinates in the test output for eyeballing (console.table or log).

## 2. Client

- Designs `saudi` (clipped-square walnut + handles, gold inlay, default) and new `jj` (round walnut, pale rim,
  thin engraved gold lines, rope ring of alternating red/white dashes around the centre circle) both use
  `armLayout`. Remove the plus-shaped `cross` track code (`plusVertices`, `plusPath`, cross branches).
  Ring designs (`andalus`, `andalus8`, `ebony`, `oaksq`, `oak`) are unchanged.
- Drawing per arm: a rounded U outline hugging the two columns, outer row and arc (stroke accent, 1.5px,
  fill rgba(0,0,0,.15)); a rounded outline around the safe column; a rounded plate around the pen with the
  suit glyph beside it; number labels: columns labelled on the inner side (toward the safe column),
  outer row labelled above the holes (toward the centre), star shown as ★ in the seat colour.
- `geometry()` returns the same shape as today (`track, safe, home, label, cpp, L, n, rc, gap`) so marbles,
  targets, hop animation, spotlight and turn ring keep working. `gap = 2.45*rc` as before.
- Centre: circle `centerR` with the deck pile and discard pile side by side (44x62), "Your turn" and
  "Deal n" text above them, inside the circle; keep ids `centerText`, `centerSub`, `stockCnt`,
  `discardCard`, `discardTxt`.
- The home screen art uses `previewMarkup('jj')`.
- Cards: render black Jacks (J♠, J♣) as a "swap" card: big ⇄ glyph and the word SWAP instead of the suit;
  red Jacks show 11 under the J. Hint text accordingly. Joker unchanged (plays as any card; as a Jack it may
  swap or move 11).

## 3. Engine rules (shared/engine.js + tests)

1. **Base protection is absolute**: a marble standing on its own star cannot be passed, killed, swapped,
   moved by a 5, or passed by a King's 13. (5 currently can move it: fix. Add test.)
2. **Wall**: two marbles of the SAME TEAM on two consecutive track cells block everyone (King included)
   from passing over them, in either direction. Landing on the first of the two (killing it) is allowed;
   landing on or passing the second is not. Implement in `simulateStep`: when the path would pass cell c
   (not the landing cell) occupied by marble X, and the next cell in the travel direction is occupied by a
   marble of X's team, the move is illegal. Backward moves use the same test with the direction reversed.
   Add tests: opponent wall blocks a 6; own-team wall blocks an opponent; landing on the first marble is
   legal; a wall of two DIFFERENT teams does not block.
3. Keep everything else. Update RULES.md and the rules dialog.

## 4. Verification before deploy

`npm test` green; `node scripts/...` none needed; then the browser checks (screenshots of the `jj` and
`saudi` boards at N=4, 6, 8, phone view, a 4-player bot game through the UI) are run by the reviewer.
