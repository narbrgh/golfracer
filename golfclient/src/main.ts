import { buildSegments, terrainY, terrainSlope, DEFAULT_COURSE } from './terrain'
import type { Course, BuiltSegment } from './terrain'
import { initEditor } from './editor'

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

// ---- Course state (mutable when editor pushes a new course) ----
let course: Course = DEFAULT_COURSE
let builtSegs: BuiltSegment[] = buildSegments(course)

function tY(x: number)     { return terrainY(x, builtSegs) }
function tSlope(x: number) { return terrainSlope(x, builtSegs) }

function updateCourse(c: Course) {
  course = c
  builtSegs = buildSegments(c)
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

// ---- Hazards ----
type HazardKind = 'sand' | 'water' | 'tree'
interface Hazard { kind: HazardKind; cx: number; w: number; h: number }
const hazards: Hazard[] = [
  { kind: 'sand',  cx:  900, w: 180, h: 14 },
  { kind: 'water', cx: 2050, w: 210, h: 60 },
  { kind: 'sand',  cx: 3150, w: 160, h: 14 },
]

// ---- Cutouts ----
interface Cutout {
  kind: 'hole' | 'water'
  left: number; right: number
  leftTopY: number; rightTopY: number
  floorY: number
  waterY?: number
}

function buildCutouts(): Cutout[] {
  const cuts: Cutout[] = []
  const hL = course.holeX - HOLE_W / 2, hR = course.holeX + HOLE_W / 2
  cuts.push({ kind: 'hole', left: hL, right: hR,
    leftTopY: tY(hL), rightTopY: tY(hR), floorY: tY(course.holeX) + HOLE_D })
  for (const hz of hazards) {
    if (hz.kind !== 'water') continue
    const left = hz.cx - hz.w / 2, right = hz.cx + hz.w / 2
    const lty = tY(left), rty = tY(right)
    const waterY = Math.max(lty, rty)
    cuts.push({ kind: 'water', left, right, leftTopY: lty, rightTopY: rty, floorY: waterY + hz.h, waterY })
  }
  return cuts.sort((a, b) => a.left - b.left)
}

function addTerrainPath(cuts: Cutout[]) {
  ctx.moveTo(0, tY(0))
  let wx = 20
  for (const cut of cuts) {
    while (wx < cut.left) { ctx.lineTo(wx, tY(wx)); wx += 20 }
    const r = cut.kind === 'water' ? 10 : 0
    if (r === 0) {
      ctx.lineTo(cut.left,  cut.leftTopY); ctx.lineTo(cut.left,  cut.floorY)
      ctx.lineTo(cut.right, cut.floorY);   ctx.lineTo(cut.right, cut.rightTopY)
    } else {
      ctx.arcTo(cut.left,  cut.leftTopY,  cut.left,       cut.floorY,         r)
      ctx.arcTo(cut.left,  cut.floorY,    cut.right,      cut.floorY,         r)
      ctx.arcTo(cut.right, cut.floorY,    cut.right,      cut.rightTopY,      r)
      ctx.lineTo(cut.right, cut.rightTopY + r)
      ctx.arcTo(cut.right, cut.rightTopY, cut.right + 20, tY(cut.right + 20), r)
    }
    wx = Math.ceil(cut.right / 20) * 20
  }
  while (wx <= course.worldW) { ctx.lineTo(wx, tY(wx)); wx += 20 }
}

function drawHazards() {
  for (const hz of hazards) {
    if (hz.kind === 'water') continue
    const ty = tY(hz.cx)
    if (hz.kind === 'sand') {
      ctx.fillStyle = 'rgba(210,185,100,0.72)'
      ctx.beginPath(); ctx.ellipse(hz.cx, ty - hz.h / 2, hz.w / 2, hz.h / 2, 0, 0, Math.PI * 2); ctx.fill()
    } else if (hz.kind === 'tree') {
      ctx.fillStyle = '#5a3510'; ctx.fillRect(hz.cx - 4, ty - hz.h, 8, hz.h)
      ctx.fillStyle = '#1e5218'
      ctx.beginPath(); ctx.arc(hz.cx, ty - hz.h - hz.w * 0.15, hz.w / 2, 0, Math.PI * 2); ctx.fill()
    }
  }
}

// ---- State ----
let physBallX = course.teeBackX
let physBallY = tY(course.teeBackX) - TEE_H - BALL_RADIUS
let ballX = physBallX, ballY = physBallY
let prevResting = true
let cameraMode: 'follow' | 'free' = 'free'
let restingDebounceStart: number | null = null
let trulyResting = true, shotAllowedAt = 0
let showingHole = false, prevInHole = false
let inWaterPenalty = false, inWaterSinking = false, waterSinkStartMs = 0

function canShootNow() { return trulyResting && Date.now() >= shotAllowedAt }

let camX = Math.max(0, Math.min(ballX - CANVAS_W / 2, course.worldW - CANVAS_W))
let camY = Math.max(0, Math.min(ballY - CANVAS_H * 0.65, course.worldH - CANVAS_H))
let zoom = 1.0, dragging = false, dragX = 0, dragY = 0

function worldToScreen(wx: number, wy: number) {
  return { sx: (wx - camX) * zoom, sy: (wy - camY) * zoom }
}
function powerColor(ratio: number) { return `hsl(${240 - ratio * 240}, 90%, 55%)` }

// ---- Minimap ----
const MINI_X = 8, MINI_Y = 8, MINI_W = 200, MINI_H = 50

function drawMinimap() {
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  ctx.fillRect(MINI_X, MINI_Y, MINI_W, MINI_H)
  ctx.strokeStyle = '#444'; ctx.lineWidth = 1
  ctx.strokeRect(MINI_X, MINI_Y, MINI_W, MINI_H)

  const mwx = (wx: number) => MINI_X + (wx / course.worldW) * MINI_W
  const mwy = (wy: number) => MINI_Y + (wy / course.worldH) * MINI_H

  ctx.strokeStyle = '#556644'; ctx.lineWidth = 1; ctx.beginPath()
  for (let wx = 0; wx <= course.worldW; wx += 60) {
    wx === 0 ? ctx.moveTo(mwx(wx), mwy(tY(wx))) : ctx.lineTo(mwx(wx), mwy(tY(wx)))
  }
  ctx.stroke()

  for (const cut of buildCutouts()) {
    if (cut.kind !== 'water') continue
    const mx = mwx(cut.left), my = mwy(cut.waterY!)
    const mw = mwx(cut.right) - mx, mh = Math.max(mwy(cut.floorY) - my, 2)
    ctx.fillStyle = 'rgba(22,85,225,0.75)'; ctx.beginPath()
    ctx.roundRect(mx, my, mw, mh, 1); ctx.fill()
  }

  const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom
  const rectX = mwx(camX), rectY = mwy(camY)
  const rectW = (visW / course.worldW) * MINI_W, rectH = (visH / course.worldH) * MINI_H
  ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(rectX, rectY, rectW, rectH)
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1
  ctx.strokeRect(rectX, rectY, rectW, rectH)

  ctx.fillStyle = '#e44'; ctx.beginPath()
  ctx.arc(mwx(course.holeX), mwy(tY(course.holeX)), 3, 0, Math.PI * 2); ctx.fill()
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
  ctx.rect(0, 0, course.worldW, course.worldH)
  ctx.clip()

  // Sky inside world
  const sky = ctx.createLinearGradient(0, 0, 0, course.worldH)
  sky.addColorStop(0, '#07071a'); sky.addColorStop(1, '#111125')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, course.worldW, course.worldH)

  const cuts = buildCutouts()

  ctx.beginPath(); addTerrainPath(cuts)
  ctx.lineTo(course.worldW, course.worldH); ctx.lineTo(0, course.worldH); ctx.closePath()
  ctx.fillStyle = '#252515'; ctx.fill()

  for (const cut of cuts) {
    const topY = Math.min(cut.leftTopY, cut.rightTopY), w = cut.right - cut.left
    if (cut.kind === 'hole') {
      const g = ctx.createLinearGradient(0, topY, 0, cut.floorY)
      g.addColorStop(0, '#0c0c14'); g.addColorStop(1, '#040406')
      ctx.fillStyle = g; ctx.fillRect(cut.left, topY, w, cut.floorY - topY)
    } else if (cut.kind === 'water') {
      const CORNER_R = 10, wy = cut.waterY! + CORNER_R
      const g = ctx.createLinearGradient(0, wy, 0, cut.floorY)
      g.addColorStop(0, 'rgba(22,85,225,0.92)'); g.addColorStop(1, 'rgba(8,40,140,0.97)')
      const r = Math.min(CORNER_R, (cut.floorY - wy) / 2.5, w / 4)
      ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(cut.left, wy, w, cut.floorY - wy, [0, 0, r, r]); ctx.fill()
      ctx.strokeStyle = 'rgba(150,210,255,0.70)'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(cut.left, wy); ctx.lineTo(cut.right, wy); ctx.stroke()
      ctx.strokeStyle = 'rgba(190,230,255,0.30)'; ctx.lineWidth = 1; ctx.beginPath()
      ctx.moveTo(cut.left + w * 0.08, wy + 7); ctx.lineTo(cut.left + w * 0.50, wy + 7)
      ctx.moveTo(cut.left + w * 0.44, wy + 14); ctx.lineTo(cut.left + w * 0.86, wy + 14)
      ctx.stroke()
    }
  }

  ctx.beginPath(); addTerrainPath(cuts)
  ctx.strokeStyle = '#667755'; ctx.lineWidth = 2; ctx.stroke()

  // World boundary — box only, not tic-tac-toe
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6 / zoom
  ctx.strokeRect(0, 0, course.worldW, course.worldH)

  ctx.fillStyle = '#ffffff'
  for (const tx of [course.teeBackX, course.teeForwardX]) ctx.fillRect(tx - 3, tY(tx) - TEE_H, 6, TEE_H)

  drawHazards()

  const flagBaseX = course.holeX + HOLE_W / 2, flagBaseY = tY(course.holeX + HOLE_W / 2)
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
  const holeDist = Math.max(0, Math.round(course.holeX - ballX))
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
    const targetCamX = visW >= course.worldW
      ? (course.worldW - visW) / 2
      : Math.max(0, Math.min(ballX - visW / 2, course.worldW - visW))
    const targetCamY = visH >= course.worldH
      ? (course.worldH - visH) / 2
      : Math.max(0, Math.min(ballY - visH * 0.65, course.worldH - visH))
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
      const worldX = ((px - MINI_X) / MINI_W) * course.worldW
      const worldY = ((py - MINI_Y) / MINI_H) * course.worldH
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
    camX = Math.max(0, Math.min(physBallX - visW / 2, course.worldW - visW))
    camY = Math.max(0, Math.min(physBallY - visH * 0.65, course.worldH - visH))
    cameraMode = 'free'
  }
  if (!inWater) { inWaterSinking = false; inWaterPenalty = false; ballX = physBallX; ballY = physBallY }

  if (!resting) {
    restingDebounceStart = null
    if (trulyResting) { trulyResting = false; shotAllowedAt = 0 }
    if (prevResting) {
      ballX = physBallX; ballY = physBallY
      const visW = CANVAS_W / zoom, visH = CANVAS_H / zoom
      camX = Math.max(0, Math.min(physBallX - visW / 2, course.worldW - visW))
      camY = Math.max(0, Math.min(physBallY - visH * 0.65, course.worldH - visH))
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
const editor = initEditor({
  getCourse: () => course,
  onCourseChange: (c) => {
    updateCourse(c)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'course', data: c }))
    }
    localStorage.setItem('golf01_course', JSON.stringify(c))
  },
})

editorBtn.addEventListener('click', () => editor.show())

// Restore saved course from localStorage on startup.
// Merge with DEFAULT_COURSE so any fields added since the save don't end up undefined.
const saved = localStorage.getItem('golf01_course')
if (saved) {
  try { updateCourse({ ...DEFAULT_COURSE, ...JSON.parse(saved) }) } catch { /* ignore bad JSON */ }
}

// Suppress unused-variable TS warning (tSlope is used only implicitly via the exported signature)
void tSlope
