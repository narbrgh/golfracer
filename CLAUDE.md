# golf01 / "GolfRacer" — Speed Golf

A 2D side-view golf game: a Go server owns all ball physics, a TypeScript
browser client renders and sends shots. Single player (with a built-in map
editor) plus online multiplayer rooms where up to 4 balls race the same hole
simultaneously. Repo: `github.com/narbrgh/golfracer`.

## Layout

```
golfclient/            Vite + TypeScript, vanilla DOM/canvas (no framework)
  src/app.ts           Entry: wires every screen into the ScreenManager
  src/main.ts          Single-player game (canvas render loop, /ws socket)
  src/screens/         mainMenu, online, roomsBrowser, roomLobby, matchScreen, kenScreen
  src/swing.ts         SwingEngine: aim/power/club/spin HUD + client-side trajectory preview
  src/gameCamera.ts    Shared camera + game chrome (hamburger, minimap, free-look)
  src/terrain.ts       Course/Hole types, spline + wave terrain math, water pooling
  src/editor.ts        Map editor overlay (largest client file)
  src/courseapi.ts     REST: list/get/save courses
  src/physicsApi.ts    REST: live physics tunables ("Ken" debug menu)
  src/lobbyNet.ts      WebSocket client for /lobby (rooms + match messages)
golfserver/            Go module `golf01/server`, stdlib + gorilla/websocket only
  main.go              HTTP routes, single-player /ws loop, hole geometry consts
  physics/ball.go      The physics engine: Tick, Tunables, air/spin/bounce/roll
  terrain/terrain.go      Hole schema + spline/wave terrain (mirrors terrain.ts)
  holegeom/holegeom.go    Builds collision geometry for one hole (shared by match engine)
  coursestore/store.go    Course JSON on disk + forward migration
  rooms/rooms.go          In-memory room registry (create/join/list/broadcast)
  rooms/match.go          Per-room multiplayer match engine + phase machine
  courses/*.json       Course files (the server's only runtime data)
  deploy.sh            Build + ship the server binary to EC2
```

## Commands

```bash
# Server (from golfserver/)
go run .                 # listens on :8081
go test ./...
go vet ./...
./deploy.sh              # build linux/amd64 + push to EC2, restart systemd `golf`
./deploy.sh --courses    # also rsync courses/ up (add/update only, never deletes)

# Client (from golfclient/)
npm run dev              # Vite dev server, usually :5173
npm run build            # tsc && vite build
npx tsc --noEmit         # typecheck only
npm run e2e              # Playwright smoke test (see Autonomy > Verify locally)
```

## Architecture

**The server is the physics authority.** The client never simulates the real
ball — it draws a *preview* parabola using constants mirrored from the server,
then sends a shot (vx, vy, club, spin) and renders the positions the server
streams back. Any physics change therefore usually needs two edits: the Go
value in `physics/ball.go` and the mirrored constant in `swing.ts`. **Keep
them equal.** Same rule for terrain math: `terrain/terrain.go` and
`terrain.ts` are deliberate mirrors (e.g. `SplineBaseRef` / `SPLINE_BASE_REF`
= 650), as are the fixed hole/tee dimensions (`holeW` 30, `holeD` 40,
`teeH` 10, ball radius 10) and the ball color palette (`rooms.BallColors` ↔
the `roomLobby.ts` palette, same order).

**Server endpoints** (`:8081`, all CORS-open):

| Route | Purpose |
|---|---|
| `GET /version` | build id; doubles as the client's online heartbeat |
| `GET /courses`, `GET/POST /courses/{id}` | course list / load / save |
| `GET/POST /physics/config` | live tunables (in-memory only; reset on restart) |
| `GET /rooms` | room listing for the browser screen |
| `WS /ws` | single-player: shots up, ball `state` + `event` messages down |
| `WS /lobby` | identity, room create/join/leave, in-room actions, match traffic |

Both sockets tick at 60 Hz and are quiet while the ball rests — `state`
messages only flow while a ball is moving, plus the one frame it settles.
Discrete transitions (`shotFired`, `sank`, `enteredWater`, `penaltyStart`,
`reset`) arrive as `event` messages so the client animates them rather than
inferring from position deltas.

**Client screens** are managed by `ScreenManager` (`screens/screenManager.ts`):
one visible at a time, DOM built lazily on first show then toggled via
`display`. Each screen is a `{ id, mount, onEnter?, onExit? }` object. The
single-player game screen mounts once and keeps its socket and render loop
alive across navigation.

**Multiplayer** (`rooms/`): rooms are ephemeral and in-memory — gone on
restart, auto-deleted when empty. Up to 6 occupants, max 4 of them active
players (picking a ball color claims a player slot; spectator frees it). A
match runs its own 60 Hz simulation with all balls on one hole, phases
`countdown → playing → (intermission → playing)* → results`, and balls
physically collide. Victory is a 2×2 of metric × scope:
`speed-total`, `speed-match`, `strokes-total`, `strokes-match` — "match" scope
awards per-hole rank points, "total" aggregates the raw metric.

**Courses**: one JSON file per course in `golfserver/courses/`, holding
`formatVersion`, `id`, `name`, and up to 18 holes. A hole carries world size,
`baseGround`, four tee X positions, `holeX`, spline control points and/or wave
segments (`useSpline`/`useWaves`, which can combine), bunkers, water hazards,
platforms, par, and a full visual theme (sky/mountains/ground/water/sun).
Migration happens in `coursestore` at the file-read boundary, so the client
only ever sees current-format data and needs no migration logic.

**Clubs**: driver / wedge / putter, with max shot speeds 2000 / 1500 / 450 and
bunker power penalties 0.25 / 0.7 / 0.5. Spin is back / none / top; backspin
trades distance for stopping power (a ~0.95 power cut plus extra drag) and
"no spin" gets a fraction of backspin's lift, so a slight backspin reads as the
ideal shot.

## Deploying — two independent halves

Classify every change before deploying:

- **Client** (`golfclient/**`) ships via `git push` to `main` — Cloudflare
  builds and deploys automatically. No server action needed.
- **Server** (`golfserver/**`) ships over SSH via `golfserver/deploy.sh` —
  cross-compiles linux/amd64, scp's to a temp path, swaps the binary, restarts
  the systemd unit `golf`, and tails the logs. The target host, SSH user, key
  path, and remote paths are configured at the top of that script; read them
  there rather than duplicating them here. Courses live in the server's
  `courses/` dir and are rewritten at runtime when players save from the
  editor — which is why `--courses` only adds and updates, never deletes.

A change touching mirrored physics or terrain constants is **both** halves.
Production client talks to `api.golfracer.com`; override with `VITE_API_URL`
for local work. Both builds stamp a git-hash version visible in the main-menu
footer.

## Known TODO — deploy host hardening (deferred, low priority)

`deploy.sh` carries the EC2 host IP, SSH user, and key *path* in plaintext, and
has been pushed to this public repo — so they're in the git history permanently
and should be treated as public. The `.pem` key itself was never committed;
that's the only actual secret, and it's safe. Access is key-only, so the
exposure is "attackers know where to knock," not "attackers can get in" —
and automated SSH scanners find every public IP on port 22 anyway.

Deliberately deferred: the blast radius today is a game server holding course
JSON, with a handful of players. Revisit if the server ever gains real user
accounts or credentials to anything else (an AWS role, a database, a payment
key) — at that point the compromise cost changes and these are worth doing:

- Restrict the security group to known IPs on port 22 (biggest single win).
- Verify `PasswordAuthentication no` / `PermitRootLogin no` in `sshd_config`.
- Rotate the keypair.
- Move host config out of the script (SSH alias or gitignored `.env`) so new
  details don't land in history.

## Conventions

- Comments explain *why*, often at length above a constant or a tricky branch.
  Match that density — this codebase documents its tuning decisions inline, and
  the physics code especially earns its explanations (see the rest-detection
  notes in `physics/ball.go`).
- Go: stdlib + gorilla/websocket. Don't add dependencies without asking.
- TypeScript: the client currently uses no UI framework or state library —
  plain DOM, canvas, modules. That's the present state, not a mandate; ask
  before introducing one. Playwright is a permanent devDependency — don't
  install or remove it.
- Go tests cover `physics/`, `rooms/`, `coursestore/`. The client has one
  Playwright smoke suite, `golfclient/e2e/smoke.mjs` (`npm run e2e`): menu +
  server status, single-player ball rests on the tee and talks to the local
  server, a putter shot moves and settles, and room creation. Run it after any
  client change; extend it when you add client behavior worth guarding.
- Physics tunables exposed in the Ken menu are session-only knobs for live
  tuning. Changing a *default* means editing `DefaultTunables()` and the
  mirrored client constant.
- The owner is learning Go: on Go changes, briefly say why the idiom was chosen.

## Autonomy

Work autonomously on `main`, locally — only the owner plays this game, so no
feature branches are needed. The permission rules in `.claude/settings.json`
enforce the boundaries; don't try to route around them.

- Before calling anything done: `go vet ./... && go test ./...` (in
  `golfserver/`) and `npx tsc --noEmit && npm run e2e` (in `golfclient/`).
- Always ask first: `git commit`/`git push` (a push to `main` auto-deploys the
  client, so it is effectively a prod deploy), `deploy.sh`/`ssh`/`rsync`/`scp`,
  `rm`/`rmdir`, and new dependencies (`go get`, `npm install`).
- Classify each change as client, server, or both (see Deploying) and say so in
  the summary, so the owner knows what a push or deploy would affect.

### Verify locally

`npm run e2e` does all of the following itself (builds the server, starts both
with the right env vars, drives headless Chromium, tears down). It owns ports
8081 and 5173 and refuses to start if they're busy, so stop any dev servers
first. For manual poking:

1. `go run .` in `golfserver/` (listens on :8081).
2. `VITE_API_URL=http://localhost:8081 VITE_WS_URL=ws://localhost:8081/ws npm run dev`
   in `golfclient/` (:5173). Both are required: `VITE_API_URL` only covers REST
   (courses, rooms, version); the game and lobby sockets read `VITE_WS_URL` and
   otherwise silently connect to production (`api.golfracer.com`).
3. Drive the client with Playwright (already a devDependency) or load it in a
   browser. Local verification needs no push, so there's no wait on Cloudflare
   or a server rebuild.
