import { buildSegments, terrainY, hexWithAlpha, buildSpline, splineY, waterPoolBounds, ensureCW } from './terrain'
import type { Course, Hole, BuiltSegment, SplineCoeff, Platform } from './terrain'
import { initEditor } from './editor'
import { listCourses, getCourse, newCourse } from './courseapi'

// ---- Canvas / render constants ----
const CANVAS_W = 800
const CANVAS_H = 540
const BALL_RADIUS = 10
const HOLE_W = BALL_RADIUS * 3   // fixed width — 1.5× ball diameter
const HOLE_D = 40                 // fixed pit depth
const POWER_SCALE = 10
const MAX_DRAG = 150
const TEE_H = 10                  // tee platform height (fixed)
const MIN_ZOOM      = 0.15
const FOLLOW_CAM_LERP = 0.5
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
  if (s && w) return splineY(x, splineCoeffs) + terrainY(x, builtSegs) - hole.baseGround
  if (s)      return splineY(x, splineCoeffs)
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
  for (const hz of hole.hazards) {
    if (hz.kind !== 'water' || hz.level == null) continue
    const bounds = waterPoolBounds(hz.cx, hz.level, tY, hole.worldW)
    if (!bounds) continue
    const { left, right } = bounds
    const path = new Path2D()
    path.rect(left, hz.level, right - left, hole.worldH - hz.level)
    waterPools.push({ left, right, level: hz.level, floorY: hz.level + WATER_GRADIENT_DEPTH, fillPath: path })
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
    const coeffs = buildSpline(b.topEdge)
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

// updateHole makes h the active hole for rendering and rebuilds the derived
// terrain/water/bunker caches from it.
function updateHole(h: Hole) {
  hole = h
  builtSegs = buildSegments(h)
  splineCoeffs = buildSpline(h.controlPoints)
  rebuildWaterPools()
  rebuildBunkerPools()
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
document.body.style.cssText = 'background:#050505;margin:0;display:flex;flex-direction:column;align-items:center;padding-top:40px'

const wrap = document.createElement('div')
wrap.style.cssText = 'position:relative;display:inline-block'
document.body.appendChild(wrap)

const canvas = document.createElement('canvas')
canvas.width = CANVAS_W
canvas.height = CANVAS_H
canvas.style.cssText = 'border:1px solid #222;cursor:crosshair;display:block'
wrap.appendChild(canvas)
const ctx = canvas.getContext('2d')!

const editorBtn = document.createElement('button')
editorBtn.textContent = 'Map Editor'
editorBtn.style.cssText = [
  'position:absolute;top:8px;right:8px',
  'background:rgba(20,20,20,0.85);border:1px solid #444',
  'color:#aaa;font:12px monospace;padding:4px 10px',
  'border-radius:3px;cursor:pointer;z-index:10',
  'transition:background 0.15s,color 0.15s',
].join(';')
editorBtn.addEventListener('mouseenter', () => { editorBtn.style.background='rgba(40,40,40,0.95)'; editorBtn.style.color='#fff' })
editorBtn.addEventListener('mouseleave', () => { editorBtn.style.background='rgba(20,20,20,0.85)'; editorBtn.style.color='#aaa' })
wrap.appendChild(editorBtn)

const sliderRowEl = document.createElement('div')
sliderRowEl.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px'
const zoomSlider = document.createElement('input')
zoomSlider.type = 'range'
zoomSlider.min = String(MIN_ZOOM.toFixed(2)); zoomSlider.max = '2'; zoomSlider.step = '0.05'; zoomSlider.value = '1'
zoomSlider.style.width = '180px'
const zoomLabel = document.createElement('span')
zoomLabel.style.cssText = 'color:#888;font:13px monospace;width:60px'
zoomLabel.textContent = '1.00×'
zoomSlider.addEventListener('input', () => {
  zoom = parseFloat(zoomSlider.value)
  zoomLabel.textContent = zoom.toFixed(2) + '×'
})
const zoomText = document.createElement('span')
zoomText.style.cssText = 'color:#666;font:13px monospace'
zoomText.textContent = 'zoom'
sliderRowEl.append(zoomText, zoomSlider, zoomLabel)
document.body.appendChild(sliderRowEl)

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
let cameraMode: 'follow' | 'free' = 'free'
let restingDebounceStart: number | null = null
let trulyResting = true, shotAllowedAt = 0
let showingHole = false, prevInHole = false
let inWaterPenalty = false, inWaterSinking = false, waterSinkStartMs = 0

function canShootNow() { return trulyResting && Date.now() >= shotAllowedAt }

let camX = Math.max(0, Math.min(ballX - CANVAS_W / 2, hole.worldW - CANVAS_W))
let camY = Math.max(0, Math.min(ballY - CANVAS_H * 0.65, hole.worldH - CANVAS_H))
let zoom = 1.0, dragging = false, dragX = 0, dragY = 0

function worldToScreen(wx: number, wy: number) {
  return { sx: (wx - camX) * zoom, sy: (wy - camY) * zoom }
}
function powerColor(ratio: number) { return `hsl(${240 - ratio * 240}, 90%, 55%)` }

function drawSunAndMountains() {
  const th = hole.theme
  const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom

  // Sun — position formula maps to a fixed screen position (upper-right) at any cam/zoom.
  // ss uses /zoom so the screen-space radius stays constant regardless of zoom level.
  const sunX = camX + visW * 0.80, sunY = camY + visH * 0.17
  const ss = th.sunSize / zoom

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
  const m1Shift = camX * (1 - p1)
  const m1EffStart = camX * p1 - 20
  const m1EffEnd   = camX * p1 + visW + 20
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
  const m2Shift = camX * (1 - p2)
  const m2EffStart = camX * p2 - 20
  const m2EffEnd   = camX * p2 + visW + 20
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
const MINI_X = 8, MINI_Y = 8, MINI_W = 200, MINI_H = 50

function drawMinimap() {
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  ctx.fillRect(MINI_X, MINI_Y, MINI_W, MINI_H)
  ctx.strokeStyle = '#444'; ctx.lineWidth = 1
  ctx.strokeRect(MINI_X, MINI_Y, MINI_W, MINI_H)

  const mwx = (wx: number) => MINI_X + (wx / hole.worldW) * MINI_W
  const mwy = (wy: number) => MINI_Y + (wy / hole.worldH) * MINI_H

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

  const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom
  const rectX = mwx(camX), rectY = mwy(camY)
  const rectW = (visW / hole.worldW) * MINI_W, rectH = (visH / hole.worldH) * MINI_H
  ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(rectX, rectY, rectW, rectH)
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1
  ctx.strokeRect(rectX, rectY, rectW, rectH)

  ctx.fillStyle = '#e44'; ctx.beginPath()
  ctx.arc(mwx(hole.holeX), mwy(tY(hole.holeX)), 3, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#fff'; ctx.beginPath()
  ctx.arc(mwx(ballX), mwy(ballY), 3, 0, Math.PI * 2); ctx.fill()
}

// ---- Draw ----
function draw() {
  // Void outside world bounds
  ctx.fillStyle = '#050505'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  ctx.save()
  ctx.scale(zoom, zoom)
  ctx.translate(-camX, -camY)

  // Clip everything to the world rectangle — nothing renders outside world bounds
  ctx.beginPath()
  ctx.rect(0, 0, hole.worldW, hole.worldH)
  ctx.clip()

  // Sky — gradient spans the visible viewport so it stays screen-fixed regardless of pan/zoom.
  const sky = ctx.createLinearGradient(0, camY, 0, camY + CANVAS_H / zoom)
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
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6 / zoom
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

  if (inWaterSinking) {
    const elapsed = Math.min(1, (Date.now() - waterSinkStartMs) / 1000)
    ctx.globalAlpha = Math.max(0, 1 - elapsed)
  }
  ctx.fillStyle = '#fff'; ctx.beginPath()
  ctx.arc(ballX, ballY, BALL_RADIUS, 0, Math.PI * 2); ctx.fill()
  ctx.globalAlpha = 1

  if (trulyResting && shotAllowedAt > 0 && Date.now() < shotAllowedAt) {
    if (inWaterPenalty) {
      const rem = Math.max(0, shotAllowedAt - Date.now())
      const outerRatio = Math.max(0, (rem - SHOT_DELAY_MS) / SHOT_DELAY_MS)
      const innerRatio = Math.min(1, rem / SHOT_DELAY_MS)
      const lw = 3 / zoom
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
      const arcR = BALL_RADIUS + 8, lw = 3 / zoom
      ctx.strokeStyle = 'rgba(255,80,10,0.18)'; ctx.lineWidth = lw
      ctx.beginPath(); ctx.arc(ballX, ballY, arcR, 0, Math.PI * 2); ctx.stroke()
      const elapsed = 1 - ratio
      ctx.strokeStyle = `hsl(${(1 - ratio) * 25}, 100%, 55%)`; ctx.lineWidth = lw; ctx.lineCap = 'round'
      ctx.beginPath(); ctx.arc(ballX, ballY, arcR, -Math.PI / 2 + elapsed * Math.PI * 2, Math.PI * 1.5); ctx.stroke()
      ctx.lineCap = 'butt'
    }
  } else if (canShootNow()) {
    ctx.strokeStyle = '#4f4'; ctx.lineWidth = 2 / zoom
    ctx.beginPath(); ctx.arc(ballX, ballY, BALL_RADIUS + 4, 0, Math.PI * 2); ctx.stroke()
  }

  ctx.restore()

  if (showingHole) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.fillStyle = '#fff'; ctx.font = 'bold 72px monospace'; ctx.textAlign = 'center'
    ctx.fillText('HOLE!', CANVAS_W / 2, CANVAS_H / 2 - 10)
    ctx.font = '22px monospace'; ctx.fillStyle = '#aaa'
    ctx.fillText('ball resets in a moment…', CANVAS_W / 2, CANVAS_H / 2 + 34)
    ctx.textAlign = 'left'
  }

  const { sx: bsx, sy: bsy } = worldToScreen(ballX, ballY)
  if (dragging) {
    const dist = Math.hypot(dragX - bsx, dragY - bsy), ratio = Math.min(dist / MAX_DRAG, 1)
    const grad = ctx.createLinearGradient(bsx, bsy, dragX, dragY)
    grad.addColorStop(0, '#4af'); grad.addColorStop(1, powerColor(ratio))
    ctx.strokeStyle = grad; ctx.lineWidth = 2.5; ctx.setLineDash([5, 4])
    ctx.beginPath(); ctx.moveTo(bsx, bsy); ctx.lineTo(dragX, dragY); ctx.stroke()
    ctx.setLineDash([])
  }

  drawMinimap()
  const holeDist = Math.max(0, Math.round(hole.holeX - ballX))
  ctx.fillStyle = '#888'; ctx.font = '12px monospace'
  ctx.fillText(`hole: ${holeDist}px`, MINI_X + 2, MINI_Y + MINI_H + 18)
}

// ---- Loop ----
function tick() {
  requestAnimationFrame(tick)  // schedule first — render exceptions can't kill the loop
  ballX += (physBallX - ballX) * BALL_LERP
  ballY += (physBallY - ballY) * BALL_LERP
  if (!trulyResting && restingDebounceStart !== null && Date.now() - restingDebounceStart >= REST_DEBOUNCE_MS) {
    trulyResting = true; shotAllowedAt = Date.now() + SHOT_DELAY_MS; cameraMode = 'free'
  }
  if (cameraMode === 'follow') {
    const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom
    const targetCamX = visW >= hole.worldW
      ? (hole.worldW - visW) / 2
      : Math.max(0, Math.min(ballX - visW / 2, hole.worldW - visW))
    const targetCamY = visH >= hole.worldH
      ? (hole.worldH - visH) / 2
      : Math.max(0, Math.min(ballY - visH * 0.65, hole.worldH - visH))
    camX += (targetCamX - camX) * FOLLOW_CAM_LERP
    camY += (targetCamY - camY) * FOLLOW_CAM_LERP
  }
  draw()
}
requestAnimationFrame(tick)

// ---- Input ----
canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect()
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top

  if (cameraMode === 'free' && cx >= MINI_X && cx <= MINI_X + MINI_W && cy >= MINI_Y && cy <= MINI_Y + MINI_H) {
    function panTo(px: number, py: number) {
      const worldX = ((px - MINI_X) / MINI_W) * hole.worldW
      const worldY = ((py - MINI_Y) / MINI_H) * hole.worldH
      const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom
      camX = worldX - visW / 2; camY = worldY - visH / 2
    }
    panTo(cx, cy)
    function onMiniMove(ev: MouseEvent) {
      const r = canvas.getBoundingClientRect(); panTo(ev.clientX - r.left, ev.clientY - r.top)
    }
    function onMiniUp() {
      window.removeEventListener('mousemove', onMiniMove); window.removeEventListener('mouseup', onMiniUp)
    }
    window.addEventListener('mousemove', onMiniMove); window.addEventListener('mouseup', onMiniUp)
    return
  }

  if (!canShootNow()) return
  dragging = true

  function clamp(mx: number, my: number) {
    const { sx, sy } = worldToScreen(ballX, ballY)
    const dx = mx - sx, dy = my - sy, d = Math.hypot(dx, dy)
    if (d > MAX_DRAG) { const s = MAX_DRAG / d; return { x: sx + dx * s, y: sy + dy * s } }
    return { x: mx, y: my }
  }
  const init = clamp(cx, cy); dragX = init.x; dragY = init.y

  function onMove(ev: MouseEvent) {
    const r = canvas.getBoundingClientRect()
    const c = clamp(ev.clientX - r.left, ev.clientY - r.top)
    dragX = c.x; dragY = c.y
  }
  function onUp(ev: MouseEvent) {
    dragging = false
    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
    const r = canvas.getBoundingClientRect()
    const mx = ev.clientX - r.left, my = ev.clientY - r.top
    const { sx, sy } = worldToScreen(ballX, ballY)
    if (Math.hypot(mx - sx, my - sy) <= BALL_RADIUS * zoom + 4) return
    const c = clamp(mx, my)
    ws.send(JSON.stringify({ type: 'shoot', vx: (sx - c.x) * POWER_SCALE, vy: (sy - c.y) * POWER_SCALE }))
  }
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
})

// ---- WebSocket ----
const ws = new WebSocket('ws://localhost:8080/ws')

// The server starts on whichever course it loaded from disk; we push the
// client's active course on connect so both sides agree on what's being played
// (without this the server keeps simulating its own terrain after a reload,
// which made the ball spawn underground until an edit nudged an update).
ws.onopen = () => { sendActiveCourse() }

ws.onmessage = (e) => {
  const { x, y, resting, inHole, inWater } = JSON.parse(e.data)
  physBallX = x; physBallY = y

  if (inHole && !prevInHole) { showingHole = true; setTimeout(() => { showingHole = false }, 3500) }
  if (prevInHole && !inHole) { ballX = physBallX; ballY = physBallY }
  prevInHole = !!inHole

  if (inWater && !resting && !inWaterSinking) { inWaterSinking = true; waterSinkStartMs = Date.now() }
  if (inWater && resting && !inWaterPenalty) {
    inWaterPenalty = true; inWaterSinking = false
    trulyResting = true; restingDebounceStart = null
    shotAllowedAt = Date.now() + 2 * SHOT_DELAY_MS
    ballX = physBallX; ballY = physBallY
    const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom
    camX = Math.max(0, Math.min(physBallX - visW / 2, hole.worldW - visW))
    camY = Math.max(0, Math.min(physBallY - visH * 0.65, hole.worldH - visH))
    cameraMode = 'free'
  }
  if (!inWater) { inWaterSinking = false; inWaterPenalty = false; ballX = physBallX; ballY = physBallY }

  if (!resting) {
    restingDebounceStart = null
    if (trulyResting) { trulyResting = false; shotAllowedAt = 0 }
    if (prevResting) {
      ballX = physBallX; ballY = physBallY
      const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom
      camX = Math.max(0, Math.min(physBallX - visW / 2, hole.worldW - visW))
      camY = Math.max(0, Math.min(physBallY - visH * 0.65, hole.worldH - visH))
      cameraMode = 'follow'
    }
  } else if (!inHole && !inWater && restingDebounceStart === null) {
    restingDebounceStart = Date.now()
  }
  prevResting = resting
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

editorBtn.addEventListener('click', () => editor.show())

// ---- Dev shortcuts ----
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (e.key === 'r' || e.key === 'R') ws.send(JSON.stringify({ type: 'reset', tee: 'back' }))
  else if (e.key === 't' || e.key === 'T') ws.send(JSON.stringify({ type: 'reset', tee: 'forward' }))
  else if (e.key === 'e' || e.key === 'E') {
    ws.send(JSON.stringify({ type: 'skipTimer' }))
    shotAllowedAt = 0
    trulyResting = true
    inWaterPenalty = false
    inWaterSinking = false
    showingHole = false
  }
})

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

