import { buildSegments, terrainY, hexWithAlpha, buildSpline, splineY, waterPoolBounds, ensureCW, SPLINE_BASE_REF, bunkerRimCoeffs } from './terrain'
import type { Course, Hole, BuiltSegment, SplineCoeff, Platform } from './terrain'
import { initEditor } from './editor'
import { listCourses, getCourse, newCourse } from './courseapi'
import { SwingEngine, formatDistance } from './swing'
import { GameCamera, mountGameChrome } from './gameCamera'
import './gameChrome.css'

// mountGame builds and runs the single-player game inside `host`. This whole body
// used to run at module load; it's wrapped in a function so the screen manager can
// mount it on demand (Single Player / Map Editor) instead of on page load — which
// also means the WebSocket only connects once the game is actually entered.
// Returns a small handle so callers can open the map-editor overlay and (scoped to
// when this screen is actually active) attach/detach the camera's keyboard listeners.
export function mountGame(host: HTMLElement, opts: { openEditor?: boolean; onBack?: () => void; onKen?: () => void } = {}): { openEditor: () => void; onEnter: () => void; onExit: () => void } {

// ---- Canvas / render constants ----
// Canvas grows with the window but never below this floor (see mountGameChrome).
const MIN_W = 900
const MIN_H = 560
const BALL_RADIUS = 10
const HOLE_W = BALL_RADIUS * 3   // fixed width — 1.5× ball diameter
const HOLE_D = 40                 // fixed pit depth
const TEE_H = 10                  // tee platform height (fixed)
const BALL_LERP       = 0.85
const REST_DEBOUNCE_MS = 250
const SHOT_DELAY_MS    = 2500

// ---- Course state ----
// courseData is the whole multi-hole course (the unit saved on the server);
// `hole` is the active hole that rendering and the terrain caches below are
// built from; activeHole indexes into courseData.holes. Replaced at startup by
// the course loaded from the server (see loadInitialCourse).
let courseData: Course = newCourse('untitled', 'Untitled')
let activeHole = 0
let hole: Hole = courseData.holes[activeHole]
let builtSegs: BuiltSegment[] = buildSegments(hole)
let splineCoeffs: SplineCoeff[] = buildSpline(hole.controlPoints)

function tY(x: number): number {
  const s = hole.useSpline, w = hole.useWaves
  if (s && w) return splineY(x, splineCoeffs) + terrainY(x, builtSegs) - SPLINE_BASE_REF
  if (s)      return splineY(x, splineCoeffs) + hole.baseGround - SPLINE_BASE_REF
  if (w)      return terrainY(x, builtSegs)
  return hole.baseGround
}

interface WaterPool { left: number; right: number; level: number; floorY: number; fillPath: Path2D }
let waterPools: WaterPool[] = []

// Fixed visual falloff depth for the water gradient — not tied to actual
// terrain depth, which can vary wildly (and isn't meaningful once the pool
// can sit over a cliff edge).
const WATER_GRADIENT_DEPTH = 80

// Flood-fill bounds only change when the hole does, so this is rebuilt here
// (and in updateCourse) instead of every animation frame inside drawWater().
// The fill's bottom edge is a flat rectangle down to worldH rather than a
// hand-traced terrain curve: the ground is already solid-filled down to
// worldH everywhere, so a flat bottom hides it just as well — and unlike a
// traced curve, it can't self-intersect into an unfillable shape on steep or
// overshooting (spline) terrain.
function rebuildWaterPools() {
  waterPools = []
  const off = hole.baseGround - SPLINE_BASE_REF
  for (const hz of hole.hazards) {
    if (hz.kind !== 'water' || hz.level == null) continue
    const wl = hz.level + off
    const bounds = waterPoolBounds(hz.cx, wl, tY, hole.worldW)
    if (!bounds) continue
    const { left, right } = bounds
    const path = new Path2D()
    path.rect(left, wl, right - left, hole.worldH - wl)
    waterPools.push({ left, right, level: wl, floorY: wl + WATER_GRADIENT_DEPTH, fillPath: path })
  }
}
rebuildWaterPools()

// ---- Bunker pool cache ----
// Like water pools: rebuilt once per hole change, not every frame.
// Fill path = Catmull-Rom spline top → terrain surface back (closed).
const BUNKER_FILL   = 'rgba(210,185,100,0.88)'
const BUNKER_STROKE = 'rgba(155,130,40,0.9)'

// Same draw-before-terrain trick as water: fill from the spline rim straight
// down to worldH. The terrain fill (drawn after) covers everything below the
// terrain surface, so only the above-terrain sand shows — no complex segment
// clipping needed, and cliff faces are automatically hidden.
interface BunkerPool { coeffs: SplineCoeff[]; leftX: number; rightX: number; fillPath: Path2D; rimPath: Path2D }
let bunkerPools: BunkerPool[] = []

function rebuildBunkerPools() {
  bunkerPools = []
  for (const b of hole.bunkers) {
    if (b.topEdge.length < 2) continue
    const coeffs = bunkerRimCoeffs(hole, b.topEdge)
    const leftX  = Math.min(...b.topEdge.map(p => p.x))
    const rightX = Math.max(...b.topEdge.map(p => p.x))

    const fill = new Path2D()
    fill.moveTo(leftX, splineY(leftX, coeffs))
    for (let x = leftX + 5; x < rightX; x += 5) fill.lineTo(x, splineY(x, coeffs))
    fill.lineTo(rightX, splineY(rightX, coeffs))
    fill.lineTo(rightX, hole.worldH)
    fill.lineTo(leftX,  hole.worldH)
    fill.closePath()

    // Rim stroke is just the spline — terrain drawn on top covers underground parts.
    const rim = new Path2D()
    rim.moveTo(leftX, splineY(leftX, coeffs))
    for (let x = leftX + 5; x <= rightX; x += 5) rim.lineTo(x, splineY(x, coeffs))

    bunkerPools.push({ coeffs, leftX, rightX, fillPath: fill, rimPath: rim })
  }
}
rebuildBunkerPools()

// ballInBunker mirrors the server's bunker check (main.go ballInBunker): the
// ball's X is within a bunker's span and the sand rim there sits above the bare
// terrain (rimY < groundY, smaller Y = higher on screen). Used to drive the
// swing's bunker-penalty HUD % and shot prediction; the server re-checks
// authoritatively so this is purely for on-screen feedback.
function ballInBunker(): boolean {
  for (const bp of bunkerPools) {
    if (ballX < bp.leftX || ballX > bp.rightX) continue
    if (splineY(ballX, bp.coeffs) < tY(ballX)) return true
  }
  return false
}

// updateHole makes h the active hole for rendering and rebuilds the derived
// terrain/water/bunker caches from it.
function updateHole(h: Hole) {
  hole = h
  builtSegs = buildSegments(h)
  splineCoeffs = buildSpline(h.controlPoints)
  rebuildWaterPools()
  rebuildBunkerPools()
  cam.setWorld(h.worldW, h.worldH)
  cam.centerOn(h.teeBackX, tY(h.teeBackX))
  holeStartMs = Date.now()
  // Each hole starts with the driver, no spin, aimed 45° toward the hole.
  swing.resetForHole(h.holeX, h.teeBackX)
}

// advanceHole moves single-player play to the next hole after a sink, wrapping
// back to hole 1 after the last so a round loops continuously. It updates the
// local render state and tells the server to re-tee on the new hole via
// selectHole (the server rebuilds physics + emits a "reset" that snaps the ball
// to the new tee).
function advanceHole() {
  const n = courseData.holes.length
  if (n <= 1) return
  activeHole = (activeHole + 1) % n
  updateHole(courseData.holes[activeHole])
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'selectHole', hole: activeHole }))
  }
}

// sendActiveCourse pushes the whole course + active hole index to the server for
// live preview/play (server rebuilds physics for that hole). No-op if the socket
// isn't open yet; loadInitialCourse and ws.onopen both call it.
function sendActiveCourse() {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'course', data: courseData, hole: activeHole }))
  }
}

// ---- DOM setup ----
// GameCamera + mountGameChrome (gameCamera.ts) are shared with matchScreen.ts —
// same Hit/Free-look camera, minimap, hole/timer HUD, and hamburger menu chrome.
const cam = new GameCamera()
const chrome = mountGameChrome(host, cam, {
  minW: MIN_W,
  minH: MIN_H,
  menuItems: [
    { label: 'Map Editor', onClick: () => editor.show() },
    { label: 'Ken', onClick: () => opts.onKen?.(), style: 'background: #ff9900' },
    { label: 'Back to Menu', onClick: () => opts.onBack?.() },
  ],
})
const canvas = chrome.canvas
const ctx = chrome.ctx

// ---- Cutouts ----
// Only the hole gaps the terrain (it's a real pit the ball drops through). Water
// doesn't carve a notch — it's drawn as a flood-filled pool on top of the
// natural, un-gapped terrain (see drawWater), so a trap can straddle any slope
// or peak without leaving stray wall lines or a hidden hole in the ground.
interface Cutout {
  kind: 'hole'
  left: number; right: number
  leftTopY: number; rightTopY: number
  floorY: number
}

function buildCutouts(): Cutout[] {
  const hL = hole.holeX - HOLE_W / 2, hR = hole.holeX + HOLE_W / 2
  return [{ kind: 'hole', left: hL, right: hR,
    leftTopY: tY(hL), rightTopY: tY(hR), floorY: tY(hole.holeX) + HOLE_D }]
}

function addTerrainPath(cuts: Cutout[]) {
  ctx.moveTo(0, tY(0))
  let wx = 20
  for (const cut of cuts) {
    while (wx < cut.left) { ctx.lineTo(wx, tY(wx)); wx += 20 }
    ctx.lineTo(cut.left,  cut.leftTopY); ctx.lineTo(cut.left,  cut.floorY)
    ctx.lineTo(cut.right, cut.floorY);   ctx.lineTo(cut.right, cut.rightTopY)
    wx = Math.ceil(cut.right / 20) * 20
  }
  while (wx <= hole.worldW) { ctx.lineTo(wx, tY(wx)); wx += 20 }
}

// Draw each water trap as a flood-filled pool: it floods outward from the
// trap's anchor (`cx`) until the terrain rises above `level`, then fills the
// gap between that surface line and the real terrain curve underneath it.
// Because terrain is NOT gapped, anywhere the ground rises above the surface
// (e.g. a peak the trap straddles) shows through as a shore rising out of the
// pool, which is exactly what we want.
function drawWater() {
  const th = hole.theme
  for (const { left, right, level: wy, floorY, fillPath } of waterPools) {
    const g = ctx.createLinearGradient(0, wy, 0, floorY)
    g.addColorStop(0, hexWithAlpha(th.waterFill, 0.92)); g.addColorStop(1, hexWithAlpha(th.waterFill, 0.97))
    ctx.fillStyle = g; ctx.fill(fillPath)
    const w = right - left
    ctx.strokeStyle = hexWithAlpha(th.waterLine, 0.70); ctx.lineWidth = th.waterLineW
    ctx.beginPath(); ctx.moveTo(left, wy); ctx.lineTo(right, wy); ctx.stroke()
    ctx.strokeStyle = hexWithAlpha(th.waterLine, 0.30); ctx.lineWidth = 1; ctx.beginPath()
    ctx.moveTo(left + w * 0.08, wy + 7); ctx.lineTo(left + w * 0.50, wy + 7)
    ctx.moveTo(left + w * 0.44, wy + 14); ctx.lineTo(left + w * 0.86, wy + 14)
    ctx.stroke()
  }
}

function drawBunkers() {
  for (const { fillPath, rimPath } of bunkerPools) {
    ctx.fillStyle = BUNKER_FILL; ctx.fill(fillPath)
    ctx.strokeStyle = BUNKER_STROKE; ctx.lineWidth = 2; ctx.stroke(rimPath)
  }
}

function drawPlatforms(which: Platform['zOrder']) {
  for (const plat of hole.platforms) {
    if (plat.zOrder !== which || plat.points.length < 3) continue
    const pts = ensureCW(plat.points)
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
    ctx.fillStyle = plat.fillColor || '#f5d800'; ctx.fill()
    ctx.strokeStyle = plat.edgeColor || '#b8a000'; ctx.lineWidth = 2; ctx.stroke()
  }
}

function drawHazards() {
  for (const hz of hole.hazards) {
    if (hz.kind !== 'tree') continue  // only trees remain (sand replaced by bunkers, water handled separately)
    const ty = tY(hz.cx)
    ctx.fillStyle = '#5a3510'; ctx.fillRect(hz.cx - 4, ty - hz.h, 8, hz.h)
    ctx.fillStyle = '#1e5218'
    ctx.beginPath(); ctx.arc(hz.cx, ty - hz.h - hz.w * 0.15, hz.w / 2, 0, Math.PI * 2); ctx.fill()
  }
}

// ---- State ----
let physBallX = hole.teeBackX
let physBallY = tY(hole.teeBackX) - TEE_H - BALL_RADIUS
let ballX = physBallX, ballY = physBallY
let prevResting = true
let restingDebounceStart: number | null = null
let trulyResting = true, shotAllowedAt = 0
let showingHole = false
let inWaterPenalty = false, inWaterSinking = false, waterSinkStartMs = 0
let holeStartMs = Date.now() // for the hole/timer HUD readout — visual parity only, not scored

// The ball is settled and past its post-shot cooldown — the parabola preview
// shows whenever this is true, even in free-look (so you can survey a shot
// from a wider view before committing).
function canPreviewShot() { return trulyResting && Date.now() >= shotAllowedAt }
// Actually aiming/shooting additionally requires Hit (follow) mode — matches
// matchScreen's canShoot().
function canShootNow() { return cam.mode === 'follow' && canPreviewShot() }

// Aim-drag visualization — screen-space line from the click's start point to
// the current cursor, shown only while the mouse is held down. If the cursor
// stays within AIM_DEADZONE_R screen px of the start point, the drag is a
// "dead zone": the angle doesn't change (drag line/parabola read as
// not-yet-committed), letting the user cancel by releasing back near where
// they pressed. A circle of that same radius is drawn at the origin point —
// red while inside the dead zone, light blue once dragged past it. Both the
// threshold and the circle are fixed screen-space sizes (no zoom scaling):
// this is about cursor travel on screen, not world distance.
let aiming = false, aimEngaged = false
let aimStartSx = 0, aimStartSy = 0, aimCurSx = 0, aimCurSy = 0
const AIM_DRAG_COLOR = 'rgba(120,200,255,0.9)'
const AIM_DEADZONE_R = BALL_RADIUS * 4

const swing = new SwingEngine({ ballColorHex: '#fff' })

function launch(vx: number, vy: number) {
  ws.send(JSON.stringify({ type: 'shoot', vx, vy, club: swing.club }))
  // Auto-zoom out to capture the trajectory from here; eases back in once the
  // ball settles (see the rest-detection in tick()). GRAVITY matches the server.
  cam.startShot(vx, vy, 1500)
}

function drawSunAndMountains() {
  const th = hole.theme
  const visW = cam.cw / cam.zoom, visH = cam.ch / cam.zoom

  // Sun — position formula maps to a fixed screen position (upper-right) at any cam/zoom.
  // ss uses /zoom so the screen-space radius stays constant regardless of zoom level.
  const sunX = cam.camX + visW * 0.80, sunY = cam.camY + visH * 0.17
  const ss = th.sunSize / cam.zoom

  // Draw back to front: ring2 circle, ring1 circle, core — each smaller circle covers the center.
  ctx.beginPath(); ctx.arc(sunX, sunY, ss * 2, 0, Math.PI * 2)
  ctx.fillStyle = th.sunRing2; ctx.fill()

  ctx.beginPath(); ctx.arc(sunX, sunY, ss * 1.5, 0, Math.PI * 2)
  ctx.fillStyle = th.sunRing1; ctx.fill()

  ctx.beginPath(); ctx.arc(sunX, sunY, ss, 0, Math.PI * 2)
  ctx.fillStyle = th.sunColor; ctx.fill()

  // Mountain height formula — uses incommensurate periods so peaks look irregular/non-repeating.
  // pow(|sin|, 0.6) sharpens peaks slightly without overcomplicating the math.
  function mtnHeight1(wx: number): number {
    return Math.pow(Math.abs(Math.sin(wx / 613 + 0.00)), 0.55) * 180
         + Math.pow(Math.abs(Math.sin(wx / 379 + 1.83)), 0.70) * 90
         + Math.abs(Math.sin(wx / 131 + 2.40)) * 28
         + Math.abs(Math.sin(wx / 59  + 0.91)) * 10
  }
  function mtnHeight2(wx: number): number {
    return Math.pow(Math.abs(Math.sin(wx / 431 + 0.60)), 0.50) * 130
         + Math.pow(Math.abs(Math.sin(wx / 251 + 1.10)), 0.65) * 55
         + Math.abs(Math.sin(wx / 89  + 2.90)) * 18
  }

  // Back mountains — p=0.06: moves at 6% of terrain speed (very far)
  const p1 = 0.06
  const m1Shift = cam.camX * (1 - p1)
  const m1EffStart = cam.camX * p1 - 20
  const m1EffEnd   = cam.camX * p1 + visW + 20
  const baseY1 = th.mountain1Y * hole.worldH
  ctx.fillStyle = th.mountain1
  ctx.beginPath()
  let firstM1 = true
  for (let ex = m1EffStart; ex <= m1EffEnd; ex += 6) {
    const wx = ex + m1Shift
    const my = baseY1 - mtnHeight1(wx)
    firstM1 ? ctx.moveTo(wx, my) : ctx.lineTo(wx, my)
    firstM1 = false
  }
  ctx.lineTo(m1EffEnd + m1Shift, hole.worldH)
  ctx.lineTo(m1EffStart + m1Shift, hole.worldH)
  ctx.closePath(); ctx.fill()

  // Front mountains — p=0.22: moves at 22% of terrain speed (mid distance)
  const p2 = 0.22
  const m2Shift = cam.camX * (1 - p2)
  const m2EffStart = cam.camX * p2 - 20
  const m2EffEnd   = cam.camX * p2 + visW + 20
  const baseY2 = th.mountain2Y * hole.worldH
  ctx.fillStyle = th.mountain2
  ctx.beginPath()
  let firstM2 = true
  for (let ex = m2EffStart; ex <= m2EffEnd; ex += 6) {
    const wx = ex + m2Shift
    const my = baseY2 - mtnHeight2(wx)
    firstM2 ? ctx.moveTo(wx, my) : ctx.lineTo(wx, my)
    firstM2 = false
  }
  ctx.lineTo(m2EffEnd + m2Shift, hole.worldH)
  ctx.lineTo(m2EffStart + m2Shift, hole.worldH)
  ctx.closePath(); ctx.fill()
}

// ---- Minimap ----
// Shared frame (bg/border/camera-viewport rect) is drawn by cam.drawMinimapFrame;
// this only renders the single-player-specific content inside it.
function drawMinimapContent(mwx: (wx: number) => number, mwy: (wy: number) => number, parabolaPts: { x: number; y: number }[] | null, parabolaColor: string) {
  ctx.strokeStyle = '#556644'; ctx.lineWidth = 1; ctx.beginPath()
  for (let wx = 0; wx <= hole.worldW; wx += 60) {
    wx === 0 ? ctx.moveTo(mwx(wx), mwy(tY(wx))) : ctx.lineTo(mwx(wx), mwy(tY(wx)))
  }
  ctx.stroke()

  for (const pool of waterPools) {
    const mx = mwx(pool.left), my = mwy(pool.level)
    const mw = mwx(pool.right) - mx
    const mh = Math.max(mwy(pool.floorY) - my, 2)
    ctx.fillStyle = 'rgba(22,85,225,0.75)'; ctx.beginPath()
    ctx.roundRect(mx, my, mw, mh, 1); ctx.fill()
  }

  // Bunkers: draw each rim as a sandy line along its spline.
  ctx.strokeStyle = 'rgba(210,185,100,0.95)'; ctx.lineWidth = 2
  for (const bp of bunkerPools) {
    ctx.beginPath()
    ctx.moveTo(mwx(bp.leftX), mwy(splineY(bp.leftX, bp.coeffs)))
    for (let x = bp.leftX + 20; x <= bp.rightX; x += 20) ctx.lineTo(mwx(x), mwy(splineY(x, bp.coeffs)))
    ctx.stroke()
  }

  ctx.fillStyle = '#e44'; ctx.beginPath()
  ctx.arc(mwx(hole.holeX), mwy(tY(hole.holeX)), 3, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#fff'; ctx.beginPath()
  ctx.arc(mwx(ballX), mwy(ballY), 3, 0, Math.PI * 2); ctx.fill()

  if (parabolaPts && parabolaPts.length > 1) {
    ctx.strokeStyle = parabolaColor; ctx.lineWidth = 1
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(mwx(parabolaPts[0].x), mwy(parabolaPts[0].y))
    for (let i = 1; i < parabolaPts.length; i++) ctx.lineTo(mwx(parabolaPts[i].x), mwy(parabolaPts[i].y))
    ctx.stroke()
    ctx.setLineDash([])
  }
}

// ---- Draw ----
function draw() {
  // Void outside world bounds
  ctx.fillStyle = '#050505'
  ctx.fillRect(0, 0, cam.cw, cam.ch)

  ctx.save()
  ctx.scale(cam.zoom, cam.zoom)
  ctx.translate(-cam.camX, -cam.camY)

  // Clip everything to the world rectangle — nothing renders outside world bounds
  ctx.beginPath()
  ctx.rect(0, 0, hole.worldW, hole.worldH)
  ctx.clip()

  // Sky — gradient spans the visible viewport so it stays screen-fixed regardless of pan/zoom.
  const sky = ctx.createLinearGradient(0, cam.camY, 0, cam.camY + cam.ch / cam.zoom)
  sky.addColorStop(0, hole.theme.skyTop); sky.addColorStop(1, hole.theme.skyBottom)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, hole.worldW, hole.worldH)

  drawSunAndMountains()
  drawPlatforms('back')

  // Water is drawn before the ground, as a plain rectangle — the ground fill
  // (opaque all the way down to worldH) then paints over whatever part of
  // that rectangle sits above the real terrain. That gives a shoreline that
  // exactly follows the terrain's actual contour for free, without the water
  // code needing to trace it, and without a fixed-width pool ever drawing a
  // hard, unnaturally straight edge into a slope.
  // Water and bunkers drawn before terrain — terrain fill covers their underground
  // portions, leaving only the above-surface region visible. Same painter trick.
  drawWater()
  drawBunkers()

  const cuts = buildCutouts()

  ctx.beginPath(); addTerrainPath(cuts)
  ctx.lineTo(hole.worldW, hole.worldH); ctx.lineTo(0, hole.worldH); ctx.closePath()
  ctx.fillStyle = hole.theme.groundFill; ctx.fill()

  for (const cut of cuts) {
    const topY = Math.min(cut.leftTopY, cut.rightTopY), w = cut.right - cut.left
    if (cut.kind === 'hole') {
      const g = ctx.createLinearGradient(0, topY, 0, cut.floorY)
      g.addColorStop(0, '#0c0c14'); g.addColorStop(1, '#040406')
      ctx.fillStyle = g; ctx.fillRect(cut.left, topY, w, cut.floorY - topY)
    }
  }

  ctx.beginPath(); addTerrainPath(cuts)
  ctx.strokeStyle = hole.theme.groundLine; ctx.lineWidth = hole.theme.groundLineW; ctx.stroke()

  // World boundary — box only, not tic-tac-toe
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6 / cam.zoom
  ctx.strokeRect(0, 0, hole.worldW, hole.worldH)

  ctx.fillStyle = '#ffffff'
  for (const tx of [hole.teeBackX, hole.teeForwardX]) ctx.fillRect(tx - 3, tY(tx) - TEE_H, 6, TEE_H)

  drawPlatforms('front')
  drawHazards()

  const flagBaseX = hole.holeX + HOLE_W / 2, flagBaseY = tY(hole.holeX + HOLE_W / 2)
  ctx.strokeStyle = '#bbb'; ctx.lineWidth = 2; ctx.beginPath()
  ctx.moveTo(flagBaseX, flagBaseY); ctx.lineTo(flagBaseX, flagBaseY - 55); ctx.stroke()
  ctx.fillStyle = '#e44'; ctx.beginPath()
  ctx.moveTo(flagBaseX, flagBaseY - 55); ctx.lineTo(flagBaseX + 24, flagBaseY - 44)
  ctx.lineTo(flagBaseX, flagBaseY - 33); ctx.closePath(); ctx.fill()

  // Sinking into water: don't fade the ball out — tint it slightly bluer so it
  // reads as underwater while staying clearly visible.
  let ballFill = '#fff'
  if (inWaterSinking) {
    const t = Math.min(1, (Date.now() - waterSinkStartMs) / 1000)
    const r = Math.round(255 - 90 * t), g = Math.round(255 - 45 * t), b = 255
    ballFill = `rgb(${r},${g},${b})`
  }
  ctx.fillStyle = ballFill; ctx.beginPath()
  ctx.arc(ballX, ballY, BALL_RADIUS, 0, Math.PI * 2); ctx.fill()

  if (trulyResting && shotAllowedAt > 0 && Date.now() < shotAllowedAt) {
    if (inWaterPenalty) {
      const rem = Math.max(0, shotAllowedAt - Date.now())
      const outerRatio = Math.max(0, (rem - SHOT_DELAY_MS) / SHOT_DELAY_MS)
      const innerRatio = Math.min(1, rem / SHOT_DELAY_MS)
      const lw = 3 / cam.zoom
      for (const { r, ratio } of [{ r: BALL_RADIUS + 16, ratio: outerRatio }, { r: BALL_RADIUS + 8, ratio: innerRatio }]) {
        if (ratio === 0) continue
        const elapsed = 1 - ratio
        ctx.strokeStyle = 'rgba(255,80,10,0.18)'; ctx.lineWidth = lw
        ctx.beginPath(); ctx.arc(ballX, ballY, r, 0, Math.PI * 2); ctx.stroke()
        ctx.strokeStyle = `hsl(${(1 - ratio) * 25}, 100%, 55%)`; ctx.lineWidth = lw; ctx.lineCap = 'round'
        ctx.beginPath(); ctx.arc(ballX, ballY, r, -Math.PI / 2 + elapsed * Math.PI * 2, Math.PI * 1.5); ctx.stroke()
        ctx.lineCap = 'butt'
      }
    } else {
      const ratio = (shotAllowedAt - Date.now()) / SHOT_DELAY_MS
      const arcR = BALL_RADIUS + 8, lw = 3 / cam.zoom
      ctx.strokeStyle = 'rgba(255,80,10,0.18)'; ctx.lineWidth = lw
      ctx.beginPath(); ctx.arc(ballX, ballY, arcR, 0, Math.PI * 2); ctx.stroke()
      const elapsed = 1 - ratio
      ctx.strokeStyle = `hsl(${(1 - ratio) * 25}, 100%, 55%)`; ctx.lineWidth = lw; ctx.lineCap = 'round'
      ctx.beginPath(); ctx.arc(ballX, ballY, arcR, -Math.PI / 2 + elapsed * Math.PI * 2, Math.PI * 1.5); ctx.stroke()
      ctx.lineCap = 'butt'
    }
  } else if (canShootNow()) {
    ctx.strokeStyle = '#4f4'; ctx.lineWidth = 2 / cam.zoom
    ctx.beginPath(); ctx.arc(ballX, ballY, BALL_RADIUS + 4, 0, Math.PI * 2); ctx.stroke()
  }

  // Parabola preview shows whenever the ball is ready to shoot again — hidden
  // mid-flight and through the red post-shot delay ring, but visible in both
  // Hit mode and free-look (so you can survey the shot from a wider view). It's
  // drawn in the aim-drag color only while a drag has actually moved the angle
  // (past the dead-zone); otherwise (including the idle non-dragging case) it's white.
  const parabolaPts = canPreviewShot() ? swing.computeParabolaWorld(ballX, ballY, hole.worldW, hole.worldH) : null
  const parabolaColor = aiming && aimEngaged ? AIM_DRAG_COLOR : 'rgba(255,255,255,0.85)'
  if (parabolaPts) swing.drawParabolaWorld(ctx, parabolaPts, cam.zoom, parabolaColor)

  ctx.restore()

  if (aiming) {
    ctx.strokeStyle = aimEngaged ? AIM_DRAG_COLOR : 'rgba(255,60,60,0.85)'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(aimStartSx, aimStartSy, AIM_DEADZONE_R, 0, Math.PI * 2); ctx.stroke()

    ctx.strokeStyle = AIM_DRAG_COLOR; ctx.lineWidth = 2
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(aimStartSx, aimStartSy); ctx.lineTo(aimCurSx, aimCurSy); ctx.stroke()
    ctx.setLineDash([])
  }

  if (showingHole) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cam.cw, cam.ch)
    ctx.fillStyle = '#fff'; ctx.font = 'bold 72px monospace'; ctx.textAlign = 'center'
    ctx.fillText('HOLE!', cam.cw / 2, cam.ch / 2 - 10)
    ctx.font = '22px monospace'; ctx.fillStyle = '#aaa'
    ctx.fillText('ball resets in a moment…', cam.cw / 2, cam.ch / 2 + 34)
    ctx.textAlign = 'left'
  }

  cam.drawMinimapFrame(ctx, (mwx, mwy) => drawMinimapContent(mwx, mwy, parabolaPts, parabolaColor))
  const miniBox = cam.miniBox()
  const holeDistPx = Math.hypot(hole.holeX - ballX, tY(hole.holeX) - ballY)
  ctx.fillStyle = '#888'; ctx.font = '12px monospace'
  ctx.fillText(`hole: ${formatDistance(holeDistPx)}`, miniBox.x + 2, miniBox.y + miniBox.h + 18)

  swing.drawHud(ctx, cam.cw, cam.ch)
}

function updateHud() {
  const elapsed = ((Date.now() - holeStartMs) / 1000).toFixed(1)
  chrome.setHud(`Hole ${activeHole + 1}/${courseData.holes.length}    ⏱ ${elapsed}s`)
}

// ---- Loop ----
function tick() {
  requestAnimationFrame(tick)  // schedule first — render exceptions can't kill the loop
  // Only flag the bunker penalty when the ball is settled and ready to shoot —
  // not while it's still flying over the sand (canPreviewShot gates the parabola
  // preview the same way).
  swing.inBunker = canPreviewShot() && ballInBunker()
  swing.update(Date.now())
  ballX += (physBallX - ballX) * BALL_LERP
  ballY += (physBallY - ballY) * BALL_LERP
  if (!trulyResting && restingDebounceStart !== null && Date.now() - restingDebounceStart >= REST_DEBOUNCE_MS) {
    trulyResting = true; shotAllowedAt = Date.now() + SHOT_DELAY_MS
    cam.endShot() // ball settled — ease the camera back in
  }
  cam.update({
    x: ballX, y: ballY,
    secondary: { x: hole.holeX, y: tY(hole.holeX) },
    ballMoving: !trulyResting,
  })
  draw()
  updateHud()
}
requestAnimationFrame(tick)

// ---- Input ----
canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect()
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top

  // Minimap: enter free-look and scrub the camera by clicking/dragging on it.
  if (cam.miniHit(cx, cy)) {
    cam.enterFreeLook()
    chrome.sync()
    cam.miniJump(cx, cy)
    function onMiniMove(ev: MouseEvent) {
      const r = canvas.getBoundingClientRect(); cam.miniJump(ev.clientX - r.left, ev.clientY - r.top)
    }
    function onMiniUp() {
      window.removeEventListener('mousemove', onMiniMove); window.removeEventListener('mouseup', onMiniUp)
    }
    window.addEventListener('mousemove', onMiniMove); window.addEventListener('mouseup', onMiniUp)
    return
  }

  const hud = swing.hitTestHud(cx, cy, cam.cw, cam.ch)
  if (hud) {
    if (hud === 'hit') {
      pressHitShortcut()
    } else {
      swing.handleHudClick(hud)
    }
    return
  }

  if (cam.mode === 'free') {
    // Left-drag pans the view.
    let panLastX = cx, panLastY = cy
    canvas.style.cursor = 'grabbing'
    function onMove(ev: MouseEvent) {
      const r = canvas.getBoundingClientRect()
      const mx = ev.clientX - r.left, my = ev.clientY - r.top
      cam.panBy(mx - panLastX, my - panLastY)
      panLastX = mx; panLastY = my
    }
    function onUp() {
      canvas.style.cursor = 'grab'
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return
  }

  if (!canShootNow()) return

  // Aim is set from the drag's start -> current point, not from the ball's
  // screen position — the click doesn't need to land on the ball. Staying
  // within AIM_DEADZONE_R of the start is a dead zone: the angle is left at
  // whatever it was before this drag, so releasing there cancels cleanly.
  const startSx = cx, startSy = cy
  const preDragAngle = swing.aimAngle
  aiming = true; aimStartSx = startSx; aimStartSy = startSy; aimCurSx = cx; aimCurSy = cy

  function applyAim(mx: number, my: number) {
    aimCurSx = mx; aimCurSy = my
    const dist = Math.hypot(mx - startSx, my - startSy)
    aimEngaged = dist > AIM_DEADZONE_R
    if (aimEngaged) swing.setAimFromScreen(startSx, startSy, mx, my)
    else swing.aimAngle = preDragAngle
  }
  applyAim(cx, cy)

  function onMove(ev: MouseEvent) {
    const r = canvas.getBoundingClientRect()
    applyAim(ev.clientX - r.left, ev.clientY - r.top)
  }
  function onUp(ev: MouseEvent) {
    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
    aiming = false
    const r = canvas.getBoundingClientRect()
    applyAim(ev.clientX - r.left, ev.clientY - r.top)
  }
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
})

// ---- WebSocket ----
function getWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined
  if (envUrl && envUrl.trim().length > 0) return envUrl

  const { protocol } = window.location
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//api.golfracer.com/ws`
}
const ws = new WebSocket(getWsUrl())

// The server starts on whichever course it loaded from disk; we push the
// client's active course on connect so both sides agree on what's being played
// (without this the server keeps simulating its own terrain after a reload,
// which made the ball spawn underground until an edit nudged an update).
ws.onopen = () => { sendActiveCourse() }

// `state` messages carry ball kinematics while it's in motion (and the settle
// frame). Discrete `event` messages drive the hole/water/reset transitions that
// used to be inferred from per-tick flags. The server stays silent at rest, so
// these handlers must not depend on a steady frame stream.
function onState(x: number, y: number, resting: boolean) {
  // Penalty and hole holds freeze the ball where an event placed it; ignore stray
  // position frames until a shot/reset clears the mode.
  if (inWaterPenalty || showingHole) return
  physBallX = x; physBallY = y
  if (inWaterSinking) return  // sinking: follow the server's fall, no rest/cam logic

  if (!resting) {
    restingDebounceStart = null
    if (trulyResting) { trulyResting = false; shotAllowedAt = 0 }
    // The camera continuously follow-lerps toward the ball whenever cam.mode is
    // 'follow' (see tick()), so no hard snap is needed here — and any shot that
    // just started motion required follow mode in the first place.
    if (prevResting) { ballX = physBallX; ballY = physBallY }
  } else if (restingDebounceStart === null) {
    restingDebounceStart = Date.now()
  }
  prevResting = resting
}

function onEvent(m: { event: string; x: number; y: number; vx?: number; vy?: number }) {
  switch (m.event) {
    case 'shotFired':
      // Clear any transient hold so the ball starts following its new flight.
      // (Also the future hook for a launch sound / opponent-shot feedback.)
      inWaterPenalty = false; inWaterSinking = false; showingHole = false
      trulyResting = false; shotAllowedAt = 0; prevResting = true
      break
    case 'sank':
      showingHole = true
      cam.endShot()
      physBallX = m.x; physBallY = m.y; ballX = m.x; ballY = m.y
      setTimeout(() => { showingHole = false; advanceHole() }, 3500)
      break
    case 'enteredWater':
      inWaterSinking = true
      waterSinkStartMs = Date.now()
      break
    case 'penaltyStart':
      inWaterPenalty = true; inWaterSinking = false
      trulyResting = true; restingDebounceStart = null
      shotAllowedAt = Date.now() + 2 * SHOT_DELAY_MS
      physBallX = m.x; physBallY = m.y; ballX = m.x; ballY = m.y
      cam.endShot(); cam.centerOn(m.x, m.y)
      break
    case 'reset':
      showingHole = false; inWaterSinking = false; inWaterPenalty = false
      trulyResting = true; restingDebounceStart = null; shotAllowedAt = 0
      prevResting = true
      physBallX = m.x; physBallY = m.y; ballX = m.x; ballY = m.y
      cam.endShot(); cam.centerOn(m.x, m.y)
      break
  }
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.type === 'event') onEvent(m)
  else onState(m.x, m.y, m.resting)  // "state" (also the plain connect snapshot)
}

ws.onclose = () => {
  ctx.fillStyle = '#f55'; ctx.font = '20px monospace'; ctx.fillText('disconnected', 10, 30)
}

// ---- Map editor ----
// The editor authors the whole course and tells us which hole is active; we
// mirror that into the render state and push a live preview to the server.
const editor = initEditor({
  getCourse: () => courseData,
  onCourseChange: (c, active) => {
    courseData = c
    activeHole = active
    updateHole(c.holes[active] ?? c.holes[0])
    sendActiveCourse()
  },
})

// ---- Keyboard (menu/camera/swing shortcuts + dev shortcuts) ----
// Scoped to onEnter/onExit (below) so single-player's shortcuts and free-look
// keys don't fire while a different screen is active — matches matchScreen.ts.
//   Escape        — open/close the hamburger menu
//   Enter or M    — toggle Free-look <-> Hit mode
//   Arrow keys    — enter Free-look and pan (held)
//   Space         — in Free-look, return to Hit mode; in Hit mode, press Hit!
//   1 / 2 / 3     — driver / pitching wedge / putter
//   4 / 5 / 6     — backspin / no spin / topspin
function pressHitShortcut() {
  if (!canShootNow()) return
  const res = swing.pressHit(Date.now())
  if (res) {
    const { vx, vy } = swing.getLaunchVelocity(res.powerPct)
    launch(vx, vy)
  }
}
function onKeyDown(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (e.key === 'Escape') { e.preventDefault(); chrome.toggleMenu(); return }
  if (cam.onKeyDown(e)) { e.preventDefault(); chrome.sync(); return }
  if (e.key === ' ') { e.preventDefault(); pressHitShortcut(); return }
  if (e.key === '1') { swing.club = 'driver'; return }
  if (e.key === '2') { swing.club = 'wedge'; return }
  if (e.key === '3') { swing.club = 'putter'; return }
  if (e.key === '4') { swing.spin = 'back'; return }
  if (e.key === '5') { swing.spin = 'none'; return }
  if (e.key === '6') { swing.spin = 'top'; return }
  if (e.key === 'r' || e.key === 'R') ws.send(JSON.stringify({ type: 'reset', tee: 'back' }))
  else if (e.key === 't' || e.key === 'T') ws.send(JSON.stringify({ type: 'reset', tee: 'forward' }))
  else if (e.key === 'e' || e.key === 'E') {
    ws.send(JSON.stringify({ type: 'skipTimer' }))
    shotAllowedAt = 0
    trulyResting = true
    restingDebounceStart = null
    inWaterPenalty = false
    inWaterSinking = false
    showingHole = false
  }
}
function onKeyUp(e: KeyboardEvent) { cam.onKeyUp(e) }

// Load the initial course from the server on startup (disk is the source of
// truth — no localStorage). Falls back to a fresh default course if the server
// has none yet or is unreachable, so the client still renders something.
async function loadInitialCourse() {
  try {
    const infos = await listCourses()
    courseData = infos.length > 0 ? await getCourse(infos[0].id) : newCourse('untitled', 'Untitled')
  } catch (err) {
    console.warn('course load failed, using default:', err)
    courseData = newCourse('untitled', 'Untitled')
  }
  activeHole = 0
  updateHole(courseData.holes[activeHole])
  sendActiveCourse()
}
loadInitialCourse()

if (opts.openEditor) editor.show()

return {
  openEditor: () => editor.show(),
  onEnter() { window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp) },
  onExit() {
    window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp)
    cam.exitFreeLook()
    chrome.sync()
    chrome.closeMenu()
  },
}
}

