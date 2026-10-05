// End-to-end smoke test: builds + starts the local Go server and the Vite dev
// client, drives the real UI in headless Chromium, and checks the things that
// `tsc` and the Go tests can't see (does the ball sit on the ground, do shots
// move it, can a room be created). Run with `npm run e2e` from golfclient/.
//
// It owns ports 8081 (Go server; the port is a const in main.go) and 5173, and
// refuses to start if either is busy so it never fights your own dev servers.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, '..')
const serverDir = join(clientDir, '..', 'golfserver')
const API = 'http://localhost:8081'
const WS = 'ws://localhost:8081/ws'
const APP = 'http://localhost:5173'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function startServers() {
  for (const [url, what] of [[API + '/version', 'Go server (:8081)'], [APP, 'Vite client (:5173)']]) {
    if (await isUp(url)) throw new Error(`${what} is already running — stop it first so the test owns the ports`)
  }
  // Build a real binary (not `go run`) so killing the child actually stops the server.
  binDir = mkdtempSync(join(tmpdir(), 'golfracer-e2e-'))
  const bin = join(binDir, 'golfserver')
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: serverDir, stdio: 'inherit' })
  // cwd matters: the server reads ./courses relative to where it starts.
  children.push(spawn(bin, [], { cwd: serverDir, stdio: 'ignore' }))
  // Both URLs are required: VITE_API_URL covers REST, VITE_WS_URL the sockets.
  // Without VITE_WS_URL the client silently talks to production.
  children.push(spawn(join(clientDir, 'node_modules/.bin/vite'), ['--port', '5173', '--strictPort'], {
    cwd: clientDir,
    stdio: 'ignore',
    env: { ...process.env, VITE_API_URL: API, VITE_WS_URL: WS },
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
