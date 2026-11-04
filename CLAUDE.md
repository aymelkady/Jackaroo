# Jackaroo – agent notes

Live multiplayer Jackaroo board game. Node 22, no build step, two runtime deps (express, ws).

## Commands
- `npm install` · `npm start` (http://localhost:3000) · `npm test` (node:test, engine only)
- End-to-end check: start the server, then drive several browser contexts with Playwright against `/`.

## Layout
- `server/engine.js` – ALL rules. Pure functions on a JSON state. `legalMoves(state, seat)` returns every legal move with a `picks` list (the taps the UI needs); `applyMove(state, seat, moveId)` re-validates and applies. Never put rules in the client.
- `server/index.js` – WebSocket protocol, persistence, bots, reconnection (token in localStorage, fallback: same name on a disconnected seat).
- `public/app.js` – rendering + tap flow. `candidateMoves()` filters the server's legal moves by card + picks so far; when one move remains with no more picks it is sent.
- `RULES.md` – the rule set in words. Keep it in sync with `movesForRank`.

## Conventions
- Marble position: `pos` is the distance from the marble's OWN base (0 = on base). `absOf()` converts to the shared track index. Safe zone `pos` is 0..3.
- Fairness: deck order is committed (`deckCommit.hash`) and later revealed (`deckHistory`). Do not expose `stock`, `hands`, `deckSalt`, `deckOrder` in `publicState`.
- Any rule change: add/adjust a test in `test/engine.test.js` first, update `RULES.md` and the rules dialog in `public/index.html`.
