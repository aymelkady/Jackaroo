---
name: jackaroo-rules
description: The exact Jackaroo rule set this repo implements and where each rule lives in code. Use when asked to change, add or verify a card effect, movement, protection, safe-zone, dealing or winning rule.
---

# Jackaroo rules (as implemented)

Read `RULES.md` for the full wording. Code map:

| Rule | Where |
|---|---|
| Card effects | `movesForRank()` in `server/engine.js` – one `case` per rank |
| Stepping, passing, killing, base protection, safe-zone entry | `simulateStep()` |
| Taking a marble out | `simulateExit()` |
| Dealing (5 then 4, fresh deck, commit/reveal) | `dealRound()`, `freshDeck()`, `revealDeck()` |
| Finished player moves partner marbles | `controlledSeat()` |
| Win check, turn rotation | end of `applyMove()` |
| Toggleable options | `DEFAULT_SETTINGS` / `normalizeSettings()` |

## Procedure for a rule change
1. Write or change a test in `test/engine.test.js` that fails under the current behaviour (`npm test`).
2. Change the engine. Keep `legalMoves()` as the single source of truth; the client only displays `picks`.
3. If a new tap sequence is needed, express it in the move's `picks` array (`{type:'marble'|'option', value, label}`); the client handles any sequence generically.
4. Update `RULES.md`, the rules dialog in `public/index.html` and the `HINT` map in `public/app.js`.
5. Add a lobby toggle only if tables genuinely disagree on the rule.
