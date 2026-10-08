// End-to-end smoke test: builds + starts the local Go server and the Vite dev
// client, drives the real UI in headless Chromium, and checks the things that
// `tsc` and the Go tests can't see (does the ball sit on the ground, do shots
// move it, can a room be created). Run with `npm run e2e` from golfclient/.
//
// It owns ports 8081 (Go server; the port is a const in main.go) and 5173, and
// refuses to start if either is busy so it never fights your own dev servers.
// `npm run e2e -- --use-running` instead tests the dev servers you already have up
// (go run . + npm run dev, no env vars) — handy for checking your exact setup, but
// note the tests push fixture courses into the shared single-player server state.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import * as T from '../src/terrain.ts'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, '..')
const serverDir = join(clientDir, '..', 'golfserver')
const API = 'http://localhost:8081'
const WS = 'ws://localhost:8081/ws'
const APP = 'http://localhost:5173'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// `npm run e2e -- --shots` saves screenshots of key moments for eyeballing the UI.
const SHOTS_DIR = process.argv.includes('--shots') ? join(tmpdir(), 'golfracer-e2e-shots') : null
async function shot(page, name) {
  if (!SHOTS_DIR) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) })
  console.log(`       [shot] ${join(SHOTS_DIR, name)}.png`)
}

async function isUp(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1000) }); return true } catch { return false }
}

async function waitUp(url, what, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await isUp(url)) return
    await sleep(250)
  }
  throw new Error(`${what} did not come up at ${url} within ${ms}ms`)
}

const children = []
let binDir = null
function cleanup() {
  for (const c of children) { try { c.kill('SIGTERM') } catch { /* already gone */ } }
  if (binDir) { try { rmSync(binDir, { recursive: true, force: true }) } catch { /* best effort */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const USE_RUNNING = process.argv.includes('--use-running')

async function startServers() {
  if (USE_RUNNING) {
    await waitUp(API + '/version', 'Go server (:8081) — start it with `go run .` in golfserver/', 3000)
    await waitUp(APP, 'Vite client (:5173) — start it with `npm run dev` in golfclient/', 3000)
    return
  }
  for (const [url, what] of [[API + '/version', 'Go server (:8081)'], [APP, 'Vite client (:5173)']]) {
    if (await isUp(url)) throw new Error(`${what} is already running — stop it first so the test owns the ports`)
  }
  // Build a real binary (not `go run`) so killing the child actually stops the server.
  binDir = mkdtempSync(join(tmpdir(), 'golfracer-e2e-'))
  const bin = join(binDir, 'golfserver')
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: serverDir, stdio: 'inherit' })
  // cwd matters: the server reads ./courses relative to where it starts.
  children.push(spawn(bin, [], { cwd: serverDir, stdio: 'ignore' }))
  // Deliberately NO VITE_API_URL / VITE_WS_URL: this is how a developer runs plain
  // `npm run dev`, and the dev-mode default (serverUrls.ts) must find the local
  // server by itself. (An earlier version set both, which hid a bug where plain
  // `npm run dev` silently talked to production.) Strip any inherited overrides.
  const clientEnv = { ...process.env }
  delete clientEnv.VITE_API_URL
  delete clientEnv.VITE_WS_URL
  children.push(spawn(join(clientDir, 'node_modules/.bin/vite'), ['--port', '5173', '--strictPort'], {
    cwd: clientDir,
    stdio: 'ignore',
    env: clientEnv,
  }))
  await waitUp(API + '/version', 'Go server')
  await waitUp(APP, 'Vite client')
}

// ---- tests ----
const results = []
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name}`) }
  catch (e) { results.push({ name, ok: false }); console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`) }
}

// Opens a page that records console errors, uncaught errors and WS frames.
async function openPage(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const rec = { errors: [], sockets: [], frames: [] }
  page.on('console', (m) => { if (m.type() === 'error') rec.errors.push(m.text()) })
  page.on('pageerror', (e) => rec.errors.push(String(e)))
  page.on('websocket', (ws) => {
    const s = { url: ws.url(), closed: false }
    rec.sockets.push(s)
    ws.on('close', () => { s.closed = true })
    ws.on('framereceived', (f) => {
      try { rec.frames.push({ url: ws.url(), msg: JSON.parse(f.payload) }) } catch { /* non-JSON frame */ }
    })
  })
  return { page, rec }
}

const stateFrames = (rec) => rec.frames.filter((f) => f.url.endsWith('/ws') && f.msg.type === 'state').map((f) => f.msg)

async function waitFor(cond, what, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (cond()) return; await sleep(50) }
  throw new Error(`timed out waiting for ${what}`)
}

// Ground height at x for a hole — mirrors tY() in main.ts (spline and waves can combine).
function groundAt(hole, x) {
  const segs = T.buildSegments(hole), coeffs = T.buildSpline(hole.controlPoints)
  const s = hole.useSpline, w = hole.useWaves
  return s && w ? T.splineY(x, coeffs) + T.terrainY(x, segs) - T.SPLINE_BASE_REF
    : s ? T.splineY(x, coeffs) + hole.baseGround - T.SPLINE_BASE_REF
    : w ? T.terrainY(x, segs)
    : hole.baseGround
}

// The first course (the one single-player loads), with `platforms` added to hole 0.
async function courseWithPlatforms(platforms) {
  const infos = await (await fetch(`${API}/courses`)).json()
  const course = await (await fetch(`${API}/courses/${infos[0].id}`)).json()
  course.holes[0].platforms = platforms
  T.normalizeTees(course.holes[0])
  return course
}

async function run() {
  await startServers()
  const browser = await chromium.launch()
  try {
    await test('main menu loads, server reports online, no console errors', async () => {
      const { page, rec } = await openPage(browser)
      await page.goto(APP)
      await page.waitForSelector('.mm-ver-online', { timeout: 10000 })
      assert.equal(await page.textContent('.mm-ver-online'), 'server dev')
      assert.deepEqual(rec.errors, [])
      await page.context().close()
    })

    await test('single-player talks to the LOCAL server, ball rests on the tee', async () => {
      const { page, rec } = await openPage(browser)
      await page.goto(APP)
      await page.click('[data-action="single"]')
      await waitFor(() => stateFrames(rec).length > 0, 'first state frame')
      // Guards the bug where a missing VITE_WS_URL sent the game to production.
      const gameSocket = rec.sockets.find((s) => s.url.endsWith('/ws'))
      assert.equal(gameSocket.url, WS, 'game socket must point at the local server')

      // Let the client's course push settle (server re-tees with a `reset` event).
      await sleep(1000)
      const last = stateFrames(rec).at(-1)
      assert.ok(last.resting, 'ball should be at rest on spawn')

      // Expected tee position computed with the client's own terrain code, the
      // same way the server places it: ground - teeH(10) - ballRadius(10).
      const expected = await page.evaluate(async (api) => {
        const t = await import('/src/terrain.ts')
        const infos = await (await fetch(`${api}/courses`)).json()
        const course = await (await fetch(`${api}/courses/${infos[0].id}`)).json()
        const hole = t.normalizeTees(course.holes[0])
        const x = hole.tees[0]
        // Mirrors tY() in main.ts: spline and waves can be used alone or combined.
        const segs = t.buildSegments(hole), coeffs = t.buildSpline(hole.controlPoints)
        const s = hole.useSpline, w = hole.useWaves
        const ground = s && w ? t.splineY(x, coeffs) + t.terrainY(x, segs) - t.SPLINE_BASE_REF
          : s ? t.splineY(x, coeffs) + hole.baseGround - t.SPLINE_BASE_REF
          : w ? t.terrainY(x, segs)
          : hole.baseGround
        return { x, y: ground - 10 - 10 }
      }, API)
      // The state stream is quiet at rest, so the ball's spawn position comes
      // from the `reset` event (or the connect snapshot if no reset was sent).
      const reset = rec.frames.filter((f) => f.msg.type === 'event' && f.msg.event === 'reset').at(-1)?.msg
      const ball = reset ?? last
      const trace = rec.frames.filter((f) => f.url.endsWith('/ws')).slice(0, 8)
        .map((f) => JSON.stringify(f.msg)).join('\n         ')
      const diag = `\nexpected tee ${JSON.stringify(expected)}; first frames:\n${trace}`
      assert.ok(Math.abs(ball.x - expected.x) < 2, `ball x ${ball.x} should be at tee ${expected.x}${diag}`)
      assert.ok(Math.abs(ball.y - expected.y) < 2, `ball y ${ball.y} should sit on the tee (${expected.y}), not float${diag}`)
      assert.deepEqual(rec.errors, [])
      await page.context().close()
    })

    await test('a putter shot moves the ball and it comes to rest', async () => {
      const { page, rec } = await openPage(browser)
      await page.goto(APP)
      await page.click('[data-action="single"]')
      await waitFor(() => stateFrames(rec).length > 0, 'first state frame')
      await sleep(1000)
      const before = stateFrames(rec).length
      const startX = stateFrames(rec).at(-1).x
      await page.keyboard.press('3') // putter: a 2-press swing (power, then fire)
      await page.keyboard.press('Space')
      await sleep(350)
      await page.keyboard.press('Space')
      await waitFor(() => rec.frames.some((f) => f.msg.type === 'event' && f.msg.event === 'shotFired'), 'shotFired event')
      await waitFor(() => stateFrames(rec).length > before + 5, 'ball motion frames')
      await waitFor(() => stateFrames(rec).at(-1).resting, 'ball to come to rest', 20000)
      const endX = stateFrames(rec).at(-1).x
      assert.ok(Math.abs(endX - startX) > 5, `ball should have moved (start ${startX}, end ${endX})`)
      assert.deepEqual(rec.errors, [])
      await page.context().close()
    })

    await test('create a room: lobby opens and the room is listed by the server', async () => {
      const { page, rec } = await openPage(browser)
      await page.goto(APP)
      await page.click('[data-action="online"]')
      await page.click('[data-action="create"]')
      await page.fill('[data-name-input]', 'e2e-room')
      await page.click('[data-modal-confirm]')
      await page.waitForSelector('[data-leave]', { state: 'visible', timeout: 10000 })
      const lobbySocket = rec.sockets.find((s) => s.url.endsWith('/lobby'))
      assert.equal(lobbySocket?.url, 'ws://localhost:8081/lobby', 'lobby socket must point at the local server')
      const rooms = await (await fetch(`${API}/rooms`)).json()
      assert.ok(rooms.some((r) => r.name === 'e2e-room'), `rooms list should include e2e-room, got ${JSON.stringify(rooms)}`)
      assert.deepEqual(rec.errors, [])
      await page.context().close()
    })

    await test('server: a sliding platform shoves a resting ball (course push → physics → wire)', async () => {
      // The ball sits on the tee. A wall starts 150px left of the tee and slides right
      // through it. The platform clock restarts at t=0 whenever a hole is (re)loaded, so
      // the wall begins at its drawn position and reaches the ball about 1.3s later —
      // which makes both the timing and the direction (rightwards) deterministic.
      const course0 = await courseWithPlatforms([])
      const hole = course0.holes[0]
      const teeX = hole.tees[0]
      const ballY = groundAt(hole, teeX) - 10 - 10
      const course = await courseWithPlatforms([{
        id: 'wall', layer: 150, fillColor: '#f0f', edgeColor: '#f0f',
        points: [{ x: teeX - 150, y: ballY - 60 }, { x: teeX - 140, y: ballY - 60 }, { x: teeX - 140, y: ballY + 10 }, { x: teeX - 150, y: ballY + 10 }],
        motion: { kind: 'path', waypoints: [{ x: 300, y: 0 }], speed: 100, mode: 'pingpong', ease: 'linear' },
      }])
      const frames = []
      const ws = new WebSocket(WS)
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws connect failed')) })
      ws.onmessage = (e) => frames.push(JSON.parse(e.data))
      ws.send(JSON.stringify({ type: 'course', data: course, hole: 0 }))
      try {
        await waitFor(() => frames.some((f) => f.type === 'event' && f.event === 'reset'), 'reset after course push')
        const reset = frames.filter((f) => f.type === 'event' && f.event === 'reset').at(-1)
        assert.ok(Math.abs(reset.x - teeX) < 2, `ball should start on the tee (${reset.x} vs ${teeX})`)
        // The platform clock must be present on state frames, and must have RESTARTED
        // for this hole (the server has been up for many seconds by now).
        await waitFor(() => frames.some((f) => f.type === 'state' && typeof f.pt === 'number'), 'state frame carrying pt')
        const firstPT = frames.filter((f) => f.type === 'state' && typeof f.pt === 'number').at(-1).pt
        assert.ok(firstPT < 2, `platform clock should restart at the hole load (pt=${firstPT.toFixed(2)})`)
        // The wall sweeps through the ball and pushes it to the RIGHT.
        try {
          await waitFor(() => frames.some((f) => f.type === 'state' && f.resting === false && f.x > reset.x + 5), 'ball pushed right by the wall', 8000)
        } catch (e) {
          const st = frames.filter((f) => f.type === 'state')
          throw new Error(`${e.message}\n tee ${teeX}, ballY ${ballY}; ${st.length} state frames, pt range ${st[0]?.pt?.toFixed(2)}..${st.at(-1)?.pt?.toFixed(2)}; last ${JSON.stringify(st.at(-1))}`)
        }
      } finally { ws.close() }
    })

    await test('client: an animated platform is drawn and visibly moves', async () => {
      const course0 = await courseWithPlatforms([])
      const hole = course0.holes[0]
      const teeX = hole.tees[0]
      const groundY = groundAt(hole, teeX)
      // A big magenta block hovering near the tee, bobbing up and down.
      const course = await courseWithPlatforms([{
        id: 'bob', layer: 150, fillColor: '#ff00ff', edgeColor: '#ff00ff',
        points: [{ x: teeX + 40, y: groundY - 260 }, { x: teeX + 140, y: groundY - 260 }, { x: teeX + 140, y: groundY - 200 }, { x: teeX + 40, y: groundY - 200 }],
        motion: { kind: 'path', waypoints: [{ x: 0, y: -90 }], speed: 60, mode: 'pingpong', ease: 'sine' },
      }])
      const { page, rec } = await openPage(browser)
      await page.route(new RegExp('/courses/[^/]+$'), (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        route.fulfill({ contentType: 'application/json', body: JSON.stringify(course) })
      })
      await page.goto(APP)
      await page.click('[data-action="single"]')
      await waitFor(() => stateFrames(rec).length > 0, 'first state frame')
      // Centroid (screen y) of magenta pixels on the game canvas.
      const centroid = () => page.evaluate(() => {
        const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0]
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let n = 0, sy = 0
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 220 && d[i + 1] < 40 && d[i + 2] > 220) { n++; sy += Math.floor(i / 4 / c.width) }
        }
        return { n, y: n ? sy / n : NaN }
      })
      await sleep(1500) // let the camera settle after the course push
      await shot(page, 'game-animated-platform')
      const samples = []
      for (let k = 0; k < 6; k++) { samples.push(await centroid()); await sleep(450) }
      assert.ok(samples.every((s) => s.n > 200), `platform should be visible in every sample: ${JSON.stringify(samples.map((s) => s.n))}`)
      const ys = samples.map((s) => s.y)
      const spread = Math.max(...ys) - Math.min(...ys)
      assert.ok(spread > 8, `platform should move on screen (centroid y spread ${spread.toFixed(1)}px): ${ys.map((y) => y.toFixed(0)).join(', ')}`)
      assert.deepEqual(rec.errors, [])
      await page.context().close()
    })

    await test('editor: give a platform Rotate then Slide motion; preview animates and the server receives it', async () => {
      const { page, rec } = await openPage(browser)
      const sent = []
      page.on('websocket', (ws) => ws.on('framesent', (f) => { try { sent.push(JSON.parse(f.payload)) } catch { /* binary */ } }))
      await page.goto(APP)
      await page.click('[data-action="editor"]')
      await page.waitForSelector('.editor-overlay', { state: 'visible' })
      await page.click('.editor-sidebar button:text-is("+ Add Platform")')

      // Bounding box + centroid of the default yellow platform (#f5d800) on the preview canvas.
      const shape = () => page.evaluate(() => {
        const c = document.querySelector('.preview-canvas-wrap canvas')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let n = 0, sx = 0, minY = 1e9, maxY = -1
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 235 && d[i + 1] > 205 && d[i + 1] < 225 && d[i + 2] < 40) {
            const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width)
            n++; sx += px; if (py < minY) minY = py; if (py > maxY) maxY = py
          }
        }
        return { n, x: n ? sx / n : NaN, h: maxY - minY }
      })
      const sample = async (count, gapMs) => { const out = []; for (let k = 0; k < count; k++) { out.push(await shape()); await sleep(gapMs) } return out }

      const rest = await shape()
      assert.ok(rest.n > 100, `the added platform should be visible (found ${rest.n} px)`)

      // Rotate: the skinny platform sweeps through angles, so its bounding-box height changes a lot.
      await page.click('.editor-sidebar button:text-is("Rotate")')
      await page.click('.editor-sidebar button:has-text("Play")')
      await shot(page, 'editor-rotate')
      const spin = await sample(5, 500)
      const hs = spin.map((s) => s.h)
      assert.ok(Math.max(...hs) - Math.min(...hs) > 10, `rotating platform should change shape; bbox heights ${hs.join(', ')}`)
      let course = sent.filter((m) => m.type === 'course').at(-1)
      let plat = course?.data.holes[course.hole].platforms.at(-1)
      assert.equal(plat?.motion?.kind, 'rotate', 'server should receive the rotate motion')
      assert.ok(plat.motion.pivot && plat.motion.rpm !== 0, 'rotation needs a pivot and a speed')

      // Slide: the platform translates, so its centroid x moves.
      await page.click('.editor-sidebar button:text-is("Slide")')
      await page.click('.editor-sidebar button:has-text("Rest pose")')
      await page.click('.editor-sidebar button:has-text("Play")')
      await shot(page, 'editor-slide')
      const slide = await sample(5, 450)
      const xs = slide.map((s) => s.x)
      assert.ok(Math.max(...xs) - Math.min(...xs) > 5, `sliding platform should move; centroid x ${xs.map((x) => x.toFixed(0)).join(', ')}`)
      course = sent.filter((m) => m.type === 'course').at(-1)
      plat = course?.data.holes[course.hole].platforms.at(-1)
      assert.equal(plat?.motion?.kind, 'path')
      assert.ok(plat.motion.waypoints.length >= 1 && plat.motion.speed > 0, 'a path needs waypoints and a speed')
      assert.deepEqual(rec.errors, [])
      await page.context().close()
    })

    await test('editor: a platform colour can be changed (clicking its picker must not rebuild the sidebar)', async () => {
      const { page, rec } = await openPage(browser)
      await page.goto(APP)
      await page.click('[data-action="editor"]')
      await page.waitForSelector('.editor-overlay', { state: 'visible' })
      await page.click('.editor-sidebar button:text-is("+ Add Platform")')

      // A real click on the picker. If the sidebar is rebuilt in response, the element
      // is torn out of the DOM — which in a real browser closes the native colour popup
      // before a colour can be chosen.
      const fill = await page.locator('.editor-sidebar .platform-selected input[type=color]').first().elementHandle()
      await fill.click()
      assert.ok(await fill.evaluate((n) => n.isConnected), 'clicking the colour picker destroyed it (sidebar was rebuilt)')

      await fill.evaluate((n) => { n.value = '#ff0000'; n.dispatchEvent(new Event('input', { bubbles: true })) })
      const red = await page.evaluate(() => {
        const c = document.querySelector('.preview-canvas-wrap canvas')
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] < 20 && d[i + 2] < 20) n++
        return n
      })
      assert.ok(red > 100, `the platform should now be drawn red (found ${red} red px)`)
      assert.deepEqual(rec.errors, [])
      await page.context().close()
    })
  } finally {
    await browser.close()
  }
}

try {
  await run()
} catch (e) {
  console.error(e.message)
  results.push({ name: 'setup', ok: false })
} finally {
  cleanup()
}

const failed = results.filter((r) => !r.ok).length
console.log(failed === 0 ? `\n${results.length} passed` : `\n${failed} of ${results.length} failed`)
process.exit(failed === 0 ? 0 : 1)
