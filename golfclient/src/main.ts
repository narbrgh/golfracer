const CANVAS_W = 800
const CANVAS_H = 540
const BASE_GROUND = 650
const WORLD_W = 4000
const WORLD_H = 1000
const BALL_RADIUS = 10
const HOLE_X = 3700
const HOLE_W = BALL_RADIUS * 3  // 1.5 × ball diameter — must match server holeW
const HOLE_D = 40               // pit depth in world px — must match server holeD
const POWER_SCALE = 10
const MAX_DRAG = 150
// min zoom so the viewport rect never overflows the minimap in either axis
const MIN_ZOOM = 0.15
// Camera lerp during ball flight — high enough to stay close, low enough to feel smooth.
const FOLLOW_CAM_LERP = 0.5
// Visual ball position lerps toward physics position each frame to smooth discrete steps.
const BALL_LERP = 0.85
// Server resting flag debounce: require this many ms of continuous rest before treating
// as truly stopped. Filters out brief slope-reversal flickers.
const REST_DEBOUNCE_MS = 250
// Cooldown after ball truly stops before another shot is allowed.
const SHOT_DELAY_MS = 2500

// Must match server terrainY formula exactly.
function terrainY(x: number): number {
  return BASE_GROUND + 80 * Math.sin(x / 800) + 40 * Math.sin(x / 300) + 20 * Math.sin(x / 150)
}

// --- DOM setup ---
document.body.style.cssText = 'background:#111;margin:0;display:flex;flex-direction:column;align-items:center;padding-top:40px'

const canvas = document.createElement('canvas')
canvas.width = CANVAS_W
canvas.height = CANVAS_H
canvas.style.cssText = 'border:1px solid #333;cursor:crosshair;display:block'
document.body.appendChild(canvas)
const ctx = canvas.getContext('2d')!

const sliderRow = document.createElement('div')
sliderRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:8px'
const zoomSlider = document.createElement('input')
zoomSlider.type = 'range'
zoomSlider.min = String(MIN_ZOOM.toFixed(2))
zoomSlider.max = '2'
zoomSlider.step = '0.05'
zoomSlider.value = '1'
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
sliderRow.append(zoomText, zoomSlider, zoomLabel)
document.body.appendChild(sliderRow)

// --- Hazards ---
// Each entry describes a course feature that overlays or modifies the terrain.
// The hole is handled separately (it needs a terrain cutout + server detection).
// Sand/water/trees are rendered client-side; physics effects will follow.
type HazardKind = 'sand' | 'water' | 'tree'
interface Hazard {
  kind: HazardKind
  cx: number  // world-space centre x
  w: number   // width (or crown diameter for tree)
  h: number   // height above terrain surface
}
const hazards: Hazard[] = [
  // Examples (uncomment to activate):
  // { kind: 'sand',  cx: 1100, w: 200, h: 14 },
  // { kind: 'water', cx: 2300, w: 160, h: 18 },
  // { kind: 'tree',  cx:  700, w:  44, h: 70 },
]

function drawHazards() {
  for (const hz of hazards) {
    const ty = terrainY(hz.cx)
    if (hz.kind === 'sand') {
      ctx.fillStyle = 'rgba(210,185,100,0.72)'
      ctx.beginPath()
      ctx.ellipse(hz.cx, ty - hz.h / 2, hz.w / 2, hz.h / 2, 0, 0, Math.PI * 2)
      ctx.fill()
    } else if (hz.kind === 'water') {
      ctx.fillStyle = 'rgba(30,90,200,0.70)'
      ctx.beginPath()
      ctx.ellipse(hz.cx, ty - hz.h / 2, hz.w / 2, hz.h / 2, 0, 0, Math.PI * 2)
      ctx.fill()
      // Shimmer line
      ctx.strokeStyle = 'rgba(120,190,255,0.4)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(hz.cx - hz.w * 0.3, ty - hz.h * 0.55)
      ctx.lineTo(hz.cx + hz.w * 0.3, ty - hz.h * 0.55)
      ctx.stroke()
    } else if (hz.kind === 'tree') {
      // Trunk
      ctx.fillStyle = '#5a3510'
      ctx.fillRect(hz.cx - 4, ty - hz.h, 8, hz.h)
      // Canopy layers
      ctx.fillStyle = '#1e5218'
      ctx.beginPath()
      ctx.arc(hz.cx, ty - hz.h - hz.w * 0.15, hz.w / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#2a6e22'
      ctx.beginPath()
      ctx.arc(hz.cx - hz.w * 0.15, ty - hz.h + hz.w * 0.1, hz.w * 0.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.arc(hz.cx + hz.w * 0.15, ty - hz.h + hz.w * 0.1, hz.w * 0.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

// --- State ---
// physBall* = authoritative position from server; ballX/Y = visual (lerped) position used for rendering.
let physBallX = 100
let physBallY = terrainY(100) - BALL_RADIUS
let ballX = physBallX
let ballY = physBallY
let prevResting = true
let cameraMode: 'follow' | 'free' = 'free'
// Rest debounce: server resting flag must be stable for REST_DEBOUNCE_MS before UI accepts it.
let restingDebounceStart: number | null = null
let trulyResting = true  // debounced rest state used by UI and shooting
let shotAllowedAt = 0    // timestamp when next shot becomes allowed; 0 = immediately
let showingHole = false  // true while "HOLE!" overlay is displayed
let prevInHole = false

function canShootNow(): boolean {
  return trulyResting && Date.now() >= shotAllowedAt
}
// Initialize camera so the ball is visible immediately without waiting for follow mode
let camX = Math.max(0, Math.min(ballX - CANVAS_W / 2, WORLD_W - CANVAS_W))
let camY = Math.max(0, Math.min(ballY - CANVAS_H * 0.65, WORLD_H - CANVAS_H))
let zoom = 1.0
let dragging = false
let dragX = 0
let dragY = 0

function worldToScreen(wx: number, wy: number) {
  return { sx: (wx - camX) * zoom, sy: (wy - camY) * zoom }
}

function powerColor(ratio: number) {
  return `hsl(${240 - ratio * 240}, 90%, 55%)`
}

// --- Minimap ---
const MINI_X = 8, MINI_Y = 8, MINI_W = 200, MINI_H = 50

function drawMinimap() {
  ctx.fillStyle = 'rgba(0,0,0,0.65)'
  ctx.fillRect(MINI_X, MINI_Y, MINI_W, MINI_H)
  ctx.strokeStyle = '#444'
  ctx.lineWidth = 1
  ctx.strokeRect(MINI_X, MINI_Y, MINI_W, MINI_H)

  // full world-to-minimap mapping for both axes
  const mwx = (wx: number) => MINI_X + (wx / WORLD_W) * MINI_W
  const mwy = (wy: number) => MINI_Y + (wy / WORLD_H) * MINI_H

  // terrain line
  ctx.strokeStyle = '#556644'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let wx = 0; wx <= WORLD_W; wx += 60) {
    wx === 0 ? ctx.moveTo(mwx(wx), mwy(terrainY(wx))) : ctx.lineTo(mwx(wx), mwy(terrainY(wx)))
  }
  ctx.stroke()

  // viewport rect — both dimensions reflect actual camera extent
  const visW = CANVAS_W / zoom
  const visH = CANVAS_H / zoom
  const rectX = mwx(camX)
  const rectY = mwy(camY)
  const rectW = (visW / WORLD_W) * MINI_W
  const rectH = (visH / WORLD_H) * MINI_H
  ctx.fillStyle = 'rgba(255,255,255,0.07)'
  ctx.fillRect(rectX, rectY, rectW, rectH)
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'
  ctx.lineWidth = 1
  ctx.strokeRect(rectX, rectY, rectW, rectH)

  // hole dot
  ctx.fillStyle = '#e44'
  ctx.beginPath()
  ctx.arc(mwx(HOLE_X), mwy(terrainY(HOLE_X)), 3, 0, Math.PI * 2)
  ctx.fill()

  // ball dot
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(mwx(ballX), mwy(ballY), 3, 0, Math.PI * 2)
  ctx.fill()
}

// --- Draw ---
function draw() {
  // sky gradient fills empty air space intentionally
  const sky = ctx.createLinearGradient(0, 0, 0, CANVAS_H)
  sky.addColorStop(0, '#07071a')
  sky.addColorStop(1, '#111125')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  // world transform
  ctx.save()
  ctx.scale(zoom, zoom)
  ctx.translate(-camX, -camY)

  const visBottom = camY + CANVAS_H / zoom + 20

  // Hole geometry (shared by terrain fill and surface line).
  const holeLeft  = HOLE_X - HOLE_W / 2
  const holeRight = HOLE_X + HOLE_W / 2
  const holeSurfY = terrainY(HOLE_X)
  // First terrain wx step that falls past the right edge of the hole.
  const holeRightWx = Math.ceil(holeRight / 20) * 20

  // terrain fill — the hole notch is cut out by routing the path down the left
  // wall, across the pit bottom, and up the right wall.  Path winding means the
  // notch interior is outside the fill region (verified by even-odd ray test).
  ctx.beginPath()
  ctx.moveTo(0, terrainY(0))
  for (let wx = 20; wx < holeLeft; wx += 20) ctx.lineTo(wx, terrainY(wx))
  ctx.lineTo(holeLeft,  terrainY(holeLeft))
  ctx.lineTo(holeLeft,  holeSurfY + HOLE_D)   // down left wall
  ctx.lineTo(holeRight, holeSurfY + HOLE_D)   // across pit bottom
  ctx.lineTo(holeRight, terrainY(holeRight))  // up right wall
  for (let wx = holeRightWx; wx <= WORLD_W; wx += 20) ctx.lineTo(wx, terrainY(wx))
  ctx.lineTo(WORLD_W, visBottom)
  ctx.lineTo(0, visBottom)
  ctx.closePath()
  ctx.fillStyle = '#252515'
  ctx.fill()

  // Dark pit interior (sky background shows through the notch — paint it dark).
  const holeGrad = ctx.createLinearGradient(0, holeSurfY, 0, holeSurfY + HOLE_D)
  holeGrad.addColorStop(0, '#0c0c14')
  holeGrad.addColorStop(1, '#040406')
  ctx.fillStyle = holeGrad
  ctx.fillRect(holeLeft, holeSurfY, HOLE_W, HOLE_D)

  // terrain surface line (including hole walls and pit bottom)
  ctx.beginPath()
  ctx.moveTo(0, terrainY(0))
  for (let wx = 20; wx < holeLeft; wx += 20) ctx.lineTo(wx, terrainY(wx))
  ctx.lineTo(holeLeft,  terrainY(holeLeft))
  ctx.lineTo(holeLeft,  holeSurfY + HOLE_D)
  ctx.lineTo(holeRight, holeSurfY + HOLE_D)
  ctx.lineTo(holeRight, terrainY(holeRight))
  for (let wx = holeRightWx; wx <= WORLD_W; wx += 20) ctx.lineTo(wx, terrainY(wx))
  ctx.strokeStyle = '#667755'
  ctx.lineWidth = 2
  ctx.stroke()

  // world boundary lines — always 6px on screen regardless of zoom
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 6 / zoom
  ctx.beginPath(); ctx.moveTo(0, -2000); ctx.lineTo(0, WORLD_H + 2000); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(WORLD_W, -2000); ctx.lineTo(WORLD_W, WORLD_H + 2000); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(-2000, 0); ctx.lineTo(WORLD_W + 2000, 0); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(-2000, WORLD_H); ctx.lineTo(WORLD_W + 2000, WORLD_H); ctx.stroke()

  // tee marker
  ctx.fillStyle = '#888'
  ctx.fillRect(98, terrainY(100) - 18, 4, 18)

  drawHazards()

  // hole: flag pole stands at the right lip of the hole
  const flagBaseX = holeRight
  const flagBaseY = terrainY(holeRight)
  ctx.strokeStyle = '#bbb'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(flagBaseX, flagBaseY)
  ctx.lineTo(flagBaseX, flagBaseY - 55)
  ctx.stroke()
  ctx.fillStyle = '#e44'
  ctx.beginPath()
  ctx.moveTo(flagBaseX, flagBaseY - 55)
  ctx.lineTo(flagBaseX + 24, flagBaseY - 44)
  ctx.lineTo(flagBaseX, flagBaseY - 33)
  ctx.closePath()
  ctx.fill()

  // ball
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(ballX, ballY, BALL_RADIUS, 0, Math.PI * 2)
  ctx.fill()

  if (trulyResting && shotAllowedAt > 0 && Date.now() < shotAllowedAt) {
    // Countdown arc: full circle at start, drains clockwise, disappears when ready.
    const ratio = (shotAllowedAt - Date.now()) / SHOT_DELAY_MS  // 1 → 0
    const arcR = BALL_RADIUS + 8
    const lw = 3 / zoom
    // Dim background ring so the draining foreground reads clearly.
    ctx.strokeStyle = 'rgba(255,80,10,0.18)'
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.arc(ballX, ballY, arcR, 0, Math.PI * 2)
    ctx.stroke()
    // Foreground: remaining portion, starts full, drains CW from 12 o'clock.
    const elapsed = 1 - ratio
    ctx.strokeStyle = `hsl(${(1 - ratio) * 25}, 100%, 55%)`  // red → orange
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(ballX, ballY, arcR, -Math.PI / 2 + elapsed * Math.PI * 2, Math.PI * 1.5)
    ctx.stroke()
    ctx.lineCap = 'butt'
  } else if (canShootNow()) {
    ctx.strokeStyle = '#4f4'
    ctx.lineWidth = 2 / zoom
    ctx.beginPath()
    ctx.arc(ballX, ballY, BALL_RADIUS + 4, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.restore()

  // HOLE! overlay
  if (showingHole) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 72px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('HOLE!', CANVAS_W / 2, CANVAS_H / 2 - 10)
    ctx.font = '22px monospace'
    ctx.fillStyle = '#aaa'
    ctx.fillText('ball resets in a moment…', CANVAS_W / 2, CANVAS_H / 2 + 34)
    ctx.textAlign = 'left'
  }

  // drag line (screen space)
  const { sx: bsx, sy: bsy } = worldToScreen(ballX, ballY)
  if (dragging) {
    const dist = Math.hypot(dragX - bsx, dragY - bsy)
    const ratio = Math.min(dist / MAX_DRAG, 1)
    const grad = ctx.createLinearGradient(bsx, bsy, dragX, dragY)
    grad.addColorStop(0, '#4af')
    grad.addColorStop(1, powerColor(ratio))
    ctx.strokeStyle = grad
    ctx.lineWidth = 2.5
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(bsx, bsy)
    ctx.lineTo(dragX, dragY)
    ctx.stroke()
    ctx.setLineDash([])
  }

  drawMinimap()

  // HUD
  const holeDist = Math.max(0, Math.round(HOLE_X - ballX))
  ctx.fillStyle = '#888'
  ctx.font = '12px monospace'
  ctx.fillText(`hole: ${holeDist}px`, MINI_X + 2, MINI_Y + MINI_H + 18)
}

// --- Loop ---
function tick() {
  // Smooth visual ball position toward the server's authoritative position.
  // This hides the discrete 60 Hz physics steps without adding input latency.
  ballX += (physBallX - ballX) * BALL_LERP
  ballY += (physBallY - ballY) * BALL_LERP

  // Promote debounced rest: only once server resting flag has been stable long enough.
  if (!trulyResting && restingDebounceStart !== null && Date.now() - restingDebounceStart >= REST_DEBOUNCE_MS) {
    trulyResting = true
    shotAllowedAt = Date.now() + SHOT_DELAY_MS
    cameraMode = 'free'
  }

  if (cameraMode === 'follow') {
    const visW = CANVAS_W / zoom
    const visH = CANVAS_H / zoom
    const targetCamX = visW >= WORLD_W
      ? (WORLD_W - visW) / 2
      : Math.max(0, Math.min(ballX - visW / 2, WORLD_W - visW))
    const targetCamY = visH >= WORLD_H
      ? (WORLD_H - visH) / 2
      : Math.max(0, Math.min(ballY - visH * 0.65, WORLD_H - visH))
    camX += (targetCamX - camX) * FOLLOW_CAM_LERP
    camY += (targetCamY - camY) * FOLLOW_CAM_LERP
  }
  draw()
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

// --- Input ---
canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top

  // minimap click/drag → pan camera (only when camera is free)
  if (cameraMode === 'free' && cx >= MINI_X && cx <= MINI_X + MINI_W && cy >= MINI_Y && cy <= MINI_Y + MINI_H) {
    function panTo(px: number, py: number) {
      const worldX = ((px - MINI_X) / MINI_W) * WORLD_W
      const worldY = ((py - MINI_Y) / MINI_H) * WORLD_H
      const visW = CANVAS_W / zoom
      const visH = CANVAS_H / zoom
      camX = worldX - visW / 2
      camY = worldY - visH / 2
    }
    panTo(cx, cy)
    function onMiniMove(ev: MouseEvent) {
      const r = canvas.getBoundingClientRect()
      panTo(ev.clientX - r.left, ev.clientY - r.top)
    }
    function onMiniUp() {
      window.removeEventListener('mousemove', onMiniMove)
      window.removeEventListener('mouseup', onMiniUp)
    }
    window.addEventListener('mousemove', onMiniMove)
    window.addEventListener('mouseup', onMiniUp)
    return
  }

  if (!canShootNow()) return
  dragging = true

  function clamp(mx: number, my: number) {
    const { sx, sy } = worldToScreen(ballX, ballY)
    const dx = mx - sx, dy = my - sy
    const d = Math.hypot(dx, dy)
    if (d > MAX_DRAG) {
      const s = MAX_DRAG / d
      return { x: sx + dx * s, y: sy + dy * s }
    }
    return { x: mx, y: my }
  }

  const init = clamp(cx, cy)
  dragX = init.x
  dragY = init.y

  function onMove(ev: MouseEvent) {
    const rect = canvas.getBoundingClientRect()
    const c = clamp(ev.clientX - rect.left, ev.clientY - rect.top)
    dragX = c.x
    dragY = c.y
  }

  function onUp(ev: MouseEvent) {
    dragging = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    const rect = canvas.getBoundingClientRect()
    const mx = ev.clientX - rect.left
    const my = ev.clientY - rect.top
    const { sx, sy } = worldToScreen(ballX, ballY)
    // Release inside the ball = cancel shot, don't send
    if (Math.hypot(mx - sx, my - sy) <= BALL_RADIUS * zoom + 4) return
    const c = clamp(mx, my)
    ws.send(JSON.stringify({
      vx: (sx - c.x) * POWER_SCALE,
      vy: (sy - c.y) * POWER_SCALE,
    }))
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
})

// --- WebSocket ---
const ws = new WebSocket('ws://localhost:8080/ws')

ws.onmessage = (e) => {
  const { x, y, resting, inHole } = JSON.parse(e.data)
  physBallX = x
  physBallY = y

  // Handle hole entry and ball reset.
  if (inHole && !prevInHole) {
    showingHole = true
    setTimeout(() => { showingHole = false }, 3500)
  }
  if (prevInHole && !inHole) {
    // Server just reset ball — snap visual position so it doesn't lerp from the hole.
    ballX = physBallX
    ballY = physBallY
  }
  prevInHole = !!inHole

  if (!resting) {
    // Ball is moving — reset all rest tracking.
    restingDebounceStart = null
    if (trulyResting) {
      trulyResting = false
      shotAllowedAt = 0
    }
    if (prevResting) {
      // First moving frame after rest: snap camera and visual ball, enter follow mode.
      ballX = physBallX
      ballY = physBallY
      const visW = CANVAS_W / zoom
      const visH = CANVAS_H / zoom
      camX = Math.max(0, Math.min(physBallX - visW / 2, WORLD_W - visW))
      camY = Math.max(0, Math.min(physBallY - visH * 0.65, WORLD_H - visH))
      cameraMode = 'follow'
    }
  } else if (!inHole && restingDebounceStart === null) {
    // Ball resting (and not in-hole freeze) — start debounce timer.
    restingDebounceStart = Date.now()
  }

  prevResting = resting
}

ws.onclose = () => {
  ctx.fillStyle = '#f55'
  ctx.font = '20px monospace'
  ctx.fillText('disconnected', 10, 30)
}
