# Jackaroo

A live, multiplayer web version of **Jackaroo** (Jakaroo), the marbles-and-cards partnership game popular in the Gulf and Egypt. Everyone on the table opens the same link on their phone or laptop, enters a name, and plays the same game in real time. Works for **4, 6 or 8 players in teams of two** (partners sit opposite).

- **Live**: every move is pushed to every player instantly over a WebSocket.
- **Saved**: the game is written to disk after every action, so a refresh, a dropped connection or even a server restart does not lose the table. Rejoin with the same link and name.
- **Fair**: the server shuffles with a cryptographic random generator (`crypto.randomInt`, unbiased Fisher-Yates). Each player only ever receives their own hand. Every deck's order is committed with a SHA-256 hash before the first card is dealt and revealed when the deck is used up, so anyone can verify no deal was changed after the fact (see "Fairness check" in the game).
- **Teams**: random teams at start, or pick your own seat in the lobby to choose your partner.
- **Bots**: the host can add simple bots to fill empty seats or to try the game alone.
- **Chat** inside the game, sounds and a vibration when it is your turn (mute button in the top bar).
- **Phones first**: works in Safari on iPhone and Chrome on Android. Add it to the home screen and it opens full-screen like an app (web app manifest + service worker). The board rotates so your own seat is always at the bottom, holes are numbered 1–18 from each base, and the holes you can reach light up when you pick a card.

Rules, including which house rules are used and which can be toggled, are in [RULES.md](RULES.md). The track has 19 holes per player (base + 18); change `cellsPerPlayer` in `server/engine.js` if your wooden board counts differently.

### Native iOS / Android apps

The web app already installs to the home screen on both platforms. If you later want store listings, wrap the same `public/` folder with [Capacitor](https://capacitorjs.com) (`npx cap add ios`, `npx cap add android`) and point it at your deployed server URL; no game code changes are needed because all logic runs on the server.

## Run it locally

```bash
npm install
npm start           # http://localhost:3000
npm test            # rules engine tests
```

Open the page, create a game, and share the link (`/g/CODE`) with your friends. Phones on the same Wi-Fi can reach your laptop by its LAN IP, e.g. `http://192.168.1.20:3000/g/CODE`.

## Deploy it (free) so friends can join from anywhere

The app is a single Node process with no database. Any host that runs Node and keeps a small disk works.

**Render** (one click): this repo includes `render.yaml`. In Render choose *New → Blueprint*, point it at your fork, and deploy. The blueprint mounts a 1 GB disk at `/data` so games survive restarts. The free plan sleeps after inactivity; the first open may take ~30 s, and games are reloaded from disk when it wakes.

**Docker** (Fly.io, Railway, a VPS, a Raspberry Pi):

```bash
docker build -t jackaroo .
docker run -p 3000:3000 -v jackaroo-data:/data -e DATA_DIR=/data jackaroo
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data/games` | where game files are stored |
| `BOT_DELAY_MS` | `900` | how long a bot "thinks" |

## How it is built

```
server/engine.js   pure rules engine: deck, dealing, legal moves, applying moves, win check, bot
server/index.js    Express static server + WebSocket protocol + persistence + bots
server/storage.js  atomic JSON file per game
public/            vanilla JS client, SVG board drawn for any player count
test/              node:test suite for the engine (run: npm test)
```

The client never computes rules. For the player whose turn it is, the server sends the list of **legal moves**, each with the sequence of taps needed (card → marble → option → second marble). The client only filters that list as you tap and sends back the chosen move id. The server re-validates every move against the current state, so a modified client cannot cheat.

### WebSocket protocol (client → server)

`create {name, settings}` · `join {code, name, token?}` · `spectate {code}` · `settings {settings}` · `seat {seat, playerId?}` · `shuffleSeats` · `addBot` · `kick {playerId}` · `start` · `move {moveId}` · `chat {text}` · `rematch` · `leave`

Server → client: `joined {code, token, playerId}` · `state {state, you}` · `error {message}` · `kicked`.

## Working on it with an AI coding agent

The repo carries agent instructions so that Claude Code, Google Antigravity, Cursor and similar tools pick up the project conventions:

- `CLAUDE.md` / `AGENTS.md` – project overview and the commands to run.
- `.agent/skills/jackaroo-rules/SKILL.md` – the exact rule set the engine implements, for any agent asked to change rules.
- `.agent/skills/jackaroo-dev/SKILL.md` – how to add a feature safely (engine first, test, then client).

## License

MIT
