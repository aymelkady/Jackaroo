# Jackaroo – agent notes

Live multiplayer Jackaroo board game. Node 22, no build step, two runtime deps (express, ws).

## Commands
- `npm install` · `npm start` (http://localhost:3000) · `npm test` (node:test: engine, rng, storage)
- End-to-end check: start the server, then drive several browser contexts with Playwright against `/`.

## Layout
- `shared/engine.js` – ALL rules. Pure functions on a JSON state. `legalMoves(state, seat)` returns every legal move with a `picks` list (the taps the UI needs); `applyMove(state, seat, moveId)` re-validates and applies. Never put rules in the client. Must stay free of Node-only imports (it runs in browsers too); randomness/hashing come from `shared/rng.js`.
- `shared/layout.js` – `armLayout()`: the real-board geometry (one U-shaped arm per player: 1..18 then the star, safe column in the middle, pen on the diagonal). Every board design uses it; designs differ only in frame shape, wood and inlay. Pure, unit-tested in `test/layout.test.js`; `docs/PLAN-jj-board.md` is the spec.
- `shared/host.js` – `GameHost`: the message protocol, lobby, bots, reconnection (token, fallback: same name on a disconnected seat), persistence via an injected async storage. Transport-agnostic: a conn is anything with `send(msg)`.
- `server/index.js` – Node: Express + ws wired to `GameHost`, file or Upstash Redis storage.
- `public/p2p.js` – serverless mode (GitHub Pages): the creator's browser runs `GameHost` with localStorage storage; others connect over WebRTC data channels via PeerJS (vendored in `public/vendor/`). `config.js` selects the mode (`window.JK_MODE`), the Node server overrides it with 'server'.
- `scripts/build-pages.sh` + `.github/workflows/pages.yml` – static build (public/ + shared/) deployed to GitHub Pages on every push.
- `public/app.js` – rendering + tap flow. `candidateMoves()` filters the server's legal moves by card + picks so far; when one move remains with no more picks it is sent.
- `RULES.md` – the rule set in words. Keep it in sync with `movesForRank`.

## Conventions
- Marble position: `pos` is the distance from the marble's OWN base (0 = on base). `absOf()` converts to the shared track index. Safe zone `pos` is 0..3.
- Fairness: deck order is committed (`deckCommit.hash`) and later revealed (`deckHistory`). Do not expose `stock`, `hands`, `deckSalt`, `deckOrder` in `publicState`.
- Any rule change: add/adjust a test in `test/engine.test.js` first, update `RULES.md` and the rules dialog in `public/index.html`.
