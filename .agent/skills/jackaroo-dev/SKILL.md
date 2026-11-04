---
name: jackaroo-dev
description: How to develop, run and verify the Jackaroo web game (server, client, persistence, bots, end-to-end browser test). Use for any feature, bug fix or refactor in this repo.
---

# Developing Jackaroo

- Start: `npm install && npm start`; open http://localhost:3000 in several browser windows (or profiles) to simulate a table. The host can "Add a bot" to fill seats.
- Unit tests: `npm test`. The last test plays full 4/6/8-player bot games and asserts board invariants; keep it green.
- Browser check: with the server running, use Playwright (`chromium.launch()`), one `browserContext` per player, create a game in one, join by code in the others, click `#btnStart`, then click `.pcard:not(.dead)` and follow `#prompt button[data-v]` / `g.marble.pick` until the turn passes.
- Persistence: `data/games/<CODE>.json` (ignored by git). Delete a file to forget a game.
- Protocol: see README "WebSocket protocol". Add a handler to the `handlers` object in `server/index.js`; always `save(g); broadcast(g);` after mutating.
- Client state is rebuilt from every `state` message; keep rendering idempotent. Marbles are keyed by `data-id` so CSS transitions animate moves.
- Never trust the client: validate on the server, re-run `legalMoves` on every move.
