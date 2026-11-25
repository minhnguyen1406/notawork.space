# notawork.space

A small 3D room for a group of friends. Walk around, talk to whoever is nearby, watch things
together on the big screen, and cook in the kitchen with nobody timing you.

- **Room:** a low-poly rooftop at dusk, avatars, name tags, text chat.
- **Voice and video:** a live video bubble above nearby avatars; voices fade with distance. Hold V to talk, M to toggle the mic.
- **Billboard:** a hanging scoreboard with world and Vietnam headlines (BBC, VnExpress) and US stock prices, refreshed every ten minutes.
- **Cinema:** share your screen (with sound) to the big screen. "Watch full screen" for movies.
- **Sit down:** lounge chairs and the dining table switch to a grid of faces for everyone seated there.
- **Kitchen:** take ingredients, chop, cook, plate and serve. Food never burns.
- **Football:** a pitch with a ball you kick by walking into it, two goals and a scoreboard.
- **Lap race:** a timed loop through four gates, with a fastest-laps board.
- **The wheel:** spin it and it picks one person in the room at random.

## How it fits together

| Part | Where | Code |
|---|---|---|
| The page (Three.js) | GitHub Pages | `src/` |
| Game server: positions, chat, seats, kitchen | Cloudflare Worker with one Durable Object | `worker/` |
| Voice, video, screenshare | LiveKit | `src/media.ts` |
| Rules and layout shared by both sides | | `shared/` |

The server is the authority for seats and the kitchen. The page only draws what the server says.

## Run it locally

```sh
npm install
npm run dev
```

Open http://localhost:5173. Open a second tab to see two players.

Voice and video are off until LiveKit keys are set. Copy `worker/.dev.vars.example` to
`worker/.dev.vars` and fill it in. That file is git-ignored; never commit keys.

## Deploy

**Game server** (once, and again after changing `worker/` or `shared/`):

```sh
npx wrangler login
npx wrangler secret put LIVEKIT_URL --config worker/wrangler.jsonc
npx wrangler secret put LIVEKIT_API_KEY --config worker/wrangler.jsonc
npx wrangler secret put LIVEKIT_API_SECRET --config worker/wrangler.jsonc
npx wrangler secret put ROOM_PASSWORD --config worker/wrangler.jsonc   # optional
npm run deploy:server
```

This prints the server address, like `https://notawork-space.<you>.workers.dev`.

**Page:** in the GitHub repo, set Settings → Pages → Source to "GitHub Actions", and add a
repository variable `SERVER_URL` with the server address above. Every push to `main` then
rebuilds and publishes the page.

## Controls

WASD or arrows to move, Shift to run, drag to look, scroll to zoom, Enter to chat, E to use or sit,
F to chop, hold V to talk, M to toggle the mic.
