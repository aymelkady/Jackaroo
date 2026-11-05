# Jackaroo

A live, multiplayer web version of **Jackaroo** (Jakaroo), the marbles-and-cards partnership game popular in the Gulf and Egypt. Everyone on the table opens the same link on their phone or laptop, enters a name, and plays the same game in real time. Works for **4, 6 or 8 players in teams of two** (partners sit opposite).

- **Live**: every move is pushed to every player instantly over a WebSocket.
- **Saved**: the game is written to disk after every action, so a refresh, a dropped connection or even a server restart does not lose the table. Rejoin with the same link and name.
- **Fair**: the server shuffles with a cryptographic random generator (`crypto.randomInt`, unbiased Fisher-Yates). Each player only ever receives their own hand. Every deck's order is committed with a SHA-256 hash before the first card is dealt and revealed when the deck is used up, so anyone can verify no deal was changed after the fact (see "Fairness check" in the game).
- **Teams**: random teams at start, or pick your own seat in the lobby to choose your partner.
- **Bots**: the host can add simple bots to fill empty seats or to try the game alone.
- **Chat and emoji reactions** that pop up over the player's seat, sounds, a vibration when it is your turn (mute button in the top bar), marbles that hop hole by hole, cards that fly to the discard pile, confetti on the win.
- **Cards as your table plays them**: black Jack swaps, red Jack moves 11, red Queen burns a card of your choice from the next player, 10 moves or makes the next player burn. All in RULES.md, with a lobby toggle.
- **Boards to choose from**: Andalusian walnut with brass khatim inlay (square or octagon), ebony with mother-of-pearl, plain oak, or the classic round board. Each player picks their own on their device.
- **Phones first**: works in Safari on iPhone and Chrome on Android. Add it to the home screen and it opens full-screen like an app (web app manifest + service worker). The board rotates so your own seat is always at the bottom, holes are numbered 1–18 from each base, the holes you can reach light up when you pick a card and you can tap a lit hole to move there. The hand docks at the bottom of the phone and a zoom button enlarges the board.

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

## Play it now: the public link

**https://aymelkady.github.io/Jackaroo/**

That page is published automatically from this repository by GitHub Pages on every push, and it needs no server at all: the person who creates a game **hosts the table inside their own browser**, and the others connect to that browser directly over WebRTC (peer-to-peer, signalled through the public PeerJS service, with a free TURN relay for phones on different mobile networks). Share the `?g=CODE` link the lobby shows.

What that means in practice:

- The host keeps their page open while you play. If they close it, the table pauses; when they open the same link again their browser re-hosts the saved game and everyone reconnects.
- The game is saved in the host's browser (localStorage) after every move. Other players reconnect with the same name or the same device.
- The fairness guarantees are the same as the server version (cryptographic shuffle, hands only sent to their owner, server-side validation of every move, SHA-256 deck commitments), with one honest caveat: the host's browser is the referee, so a host who opens developer tools could read the other hands. Among friends that is fine; for strangers, run the Node server instead.

## Run your own server (optional)

The same code runs as a classic client/server app (`server/`), which is better for strangers or flaky networks. The app is one Node process with a WebSocket; it needs a host that runs Node (not a static host). Everything below is free.

### Render (about 3 minutes)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/aymelkady/Jackaroo)

1. Click the button (or in Render: **New + → Blueprint**, pick this repo). Sign in with GitHub, then **Apply**. The `render.yaml` in this repo sets everything up.
2. You get a URL like `https://jackaroo-xxxx.onrender.com`. Open it, create a game, send friends the link the lobby shows.

Free-plan behaviour: the service sleeps after ~15 minutes with nobody connected and wakes on the next visit. While people are in a game the WebSocket keeps it awake. When it sleeps, games in memory and on its disk are lost, so add Upstash if you want games to survive that.

### Keep games across restarts: Upstash Redis (optional, free)

1. Create a free database at [upstash.com](https://upstash.com) (Redis, any region near you).
2. Put its **REST URL** and **REST token** into the Render service's environment as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Redeploy. Every game is saved there after every move. Games expire after 30 days of inactivity.

### Other hosts

- **Docker** anywhere (Fly.io with `fly.toml`, Railway, Koyeb, a VPS, a Raspberry Pi):

  ```bash
  docker build -t jackaroo .
  docker run -p 3000:3000 -v jackaroo-data:/data -e DATA_DIR=/data jackaroo
  ```

- **Your own laptop for a room full of friends**: `npm start`, then share `http://<your LAN IP>:3000`.
- **Any static host** (Netlify, Cloudflare Pages, S3...): `sh scripts/build-pages.sh` and upload `dist/`; that is the same serverless build GitHub Pages uses.

Environment variables (server mode):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data/games` | where game files are stored when Redis is not configured |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | unset | use Upstash Redis instead of files |
| `BOT_DELAY_MS` | `900` | how long a bot "thinks" |

## How it is built

```
shared/engine.js   pure rules engine: deck, dealing, legal moves, applying moves, win check, bot (Node + browser)
shared/host.js     GameHost: lobby, protocol, bots, reconnection, persistence (transport-agnostic)
shared/rng.js      Web Crypto randomness + synchronous SHA-256 (works in Node and browsers)
server/index.js    Node server: Express static + WebSocket wired to GameHost
server/storage.js  server persistence: JSON file per game, or Upstash Redis over REST
public/            vanilla JS client, SVG board for any player count, p2p.js (serverless host/client)
scripts/, .github/ static build for GitHub Pages, CI
test/              node:test suite (run: npm test)
```

The client never computes rules. For the player whose turn it is, the host (server or hosting browser) sends the list of **legal moves**, each with the sequence of taps needed (card → marble → option → second marble). The client only filters that list as you tap and sends back the chosen move id. The server re-validates every move against the current state, so a modified client cannot cheat.

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
