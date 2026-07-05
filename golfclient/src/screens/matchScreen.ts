import './match.css'
import type { Screen } from './screenManager'
import type { MatchHole, MatchState, MatchLeaderboard, MatchBall } from '../lobbyNet'
import type { Hole, BuiltSegment, SplineCoeff } from '../terrain'
import { buildSegments, terrainY, buildSpline, splineY, waterPoolBounds, hexWithAlpha, SPLINE_BASE_REF, baseOffset, bunkerRimCoeffs } from '../terrain'
import { colorHex } from './roomLobby'

// The rendered canvas grows to fill the window but never shrinks below this — the
// old fixed size, which reads well as a floor.
const MIN_W = 900
const MIN_H = 560
const BALL_R = 10
const HOLE_W = 30
const HOLE_D = 40
const TEE_H = 10
const POWER_SCALE = 10
const MAX_DRAG = 150
const BALL_LERP = 0.85
const GRAVITY = 1500 // must match physics.Gravity on the server (for shot prediction)
const PRED_MAX_MS = 500
const SHOT_DELAY_MS = 2500 // matches server shotDelayTicks; water penalty is 2×
const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.5
const PAN_STEP = 14 // screen px/frame while an arrow key is held (in free-look)
const MINI_W = 200, MINI_H = 52, MINI_PAD = 12 // minimap box (top-right)

export interface MatchHandlers {
  onShoot: (vx: number, vy: number) => void
  onReturn: () => void
  onLeave: () => void
}

export interface MatchScreenApi extends Screen {
  setMyId(id: number): void
  setHole(m: MatchHole): void
  setState(m: MatchState): void
  setLeaderboard(m: MatchLeaderboard): void
}

export function createMatchScreen(handlers: MatchHandlers): MatchScreenApi {
  let myId: number | null = null
  let hole: Hole | null = null
  let segs: BuiltSegment[] = []
  let spline: SplineCoeff[] = []
  let waterPools: { left: number; right: number; level: number; floorY: number }[] = []
  let bunkerPools: { leftX: number; rightX: number; coeffs: SplineCoeff[] }[] = []

  let state: MatchState | null = null
  const render = new Map<number, { x: number; y: number }>()

  // Canvas size (responsive), camera, and zoom.
  let cw = MIN_W
  let ch = MIN_H
  let camX = 0
  let camY = 0
  let zoom = 1
  let camMode: 'follow' | 'free' = 'follow'
  const held = new Set<string>() // held arrow keys (free-look panning)
  let panning = false
  let panLastX = 0
  let panLastY = 0

  let dragging = false // shot drag
  let dragX = 0
  let dragY = 0

  let clockBaseMs = 0
  let clockAt = 0
  let stateAt = 0

  let predActive = false
  let predX = 0, predY = 0, predVX = 0, predVY = 0, predStart = 0
  let lastFrameMs = 0

  let canvas!: HTMLCanvasElement
  let ctx!: CanvasRenderingContext2D
  let wrapEl!: HTMLElement
  let hudEl!: HTMLElement
  let countdownEl!: HTMLElement
  let boardEl!: HTMLElement
  let arrowsEl!: HTMLElement
  let menuPanelEl!: HTMLElement

  const tY = (x: number): number => {
    if (!hole) return 0
    const s = hole.useSpline, w = hole.useWaves
    if (s && w) return splineY(x, spline) + terrainY(x, segs) - SPLINE_BASE_REF
    if (s) return splineY(x, spline) + hole.baseGround - SPLINE_BASE_REF
    if (w) return terrainY(x, segs)
    return hole.baseGround
  }

  function rebuildCaches() {
    if (!hole) return
    segs = buildSegments(hole)
    spline = buildSpline(hole.controlPoints)
    const off = baseOffset(hole)
    waterPools = []
    for (const hz of hole.hazards) {
      if (hz.kind !== 'water' || hz.level == null) continue
      const wl = hz.level + off
      const b = waterPoolBounds(hz.cx, wl, tY, hole.worldW)
      if (!b) continue
      waterPools.push({ left: b.left, right: b.right, level: wl, floorY: wl + 80 })
    }
    bunkerPools = []
    for (const bk of hole.bunkers) {
      if (bk.topEdge.length < 2) continue
      const coeffs = bunkerRimCoeffs(hole, bk.topEdge)
      const leftX = Math.min(...bk.topEdge.map((p) => p.x))
      const rightX = Math.max(...bk.topEdge.map((p) => p.x))
      bunkerPools.push({ leftX, rightX, coeffs })
    }
  }

  const myBall = (): MatchBall | undefined =>
    myId == null ? undefined : state?.balls.find((b) => b.playerId === myId)

  const shotRemainingMs = (b: MatchBall): number => Math.max(0, (b.readyInMs ?? 0) - (performance.now() - stateAt))

  const canShoot = (): boolean => {
    const b = myBall()
    return camMode === 'follow' && !predActive && !!b && state?.phase === 'playing' && b.resting && !b.sunk && shotRemainingMs(b) <= 0
  }

  // World↔screen (zoom-aware). Screen origin is the canvas top-left.
  const worldToScreen = (wx: number, wy: number) => ({ sx: (wx - camX) * zoom, sy: (wy - camY) * zoom })
  const screenToWorld = (sx: number, sy: number) => ({ wx: camX + sx / zoom, wy: camY + sy / zoom })

  function clampCam() {
    if (!hole) return
    const visW = cw / zoom, visH = ch / zoom
    camX = hole.worldW <= visW ? (hole.worldW - visW) / 2 : Math.max(0, Math.min(camX, hole.worldW - visW))
    camY = hole.worldH <= visH ? (hole.worldH - visH) / 2 : Math.max(0, Math.min(camY, hole.worldH - visH))
  }

  function resize() {
    if (!wrapEl) return
    const host = wrapEl.parentElement ?? wrapEl
    cw = Math.max(MIN_W, host.clientWidth || MIN_W)
    ch = Math.max(MIN_H, host.clientHeight || MIN_H)
    canvas.width = cw
    canvas.height = ch
    canvas.style.width = cw + 'px'
    canvas.style.height = ch + 'px'
    wrapEl.style.width = cw + 'px'
    wrapEl.style.height = ch + 'px'
    clampCam()
  }

  // ---- Free-look ----
  function enterFreeLook() {
    if (camMode === 'free') return
    camMode = 'free'
    arrowsEl.style.display = ''
    canvas.style.cursor = 'grab'
  }
  function exitFreeLook() {
    if (camMode === 'follow') return
    camMode = 'follow'
    zoom = 1 // revert camera to the ball at normal zoom
    held.clear()
    panning = false
    arrowsEl.style.display = 'none'
    canvas.style.cursor = 'crosshair'
  }
  const toggleFreeLook = () => (camMode === 'free' ? exitFreeLook() : enterFreeLook())

  function zoomAt(screenX: number, screenY: number, factor: number) {
    const { wx, wy } = screenToWorld(screenX, screenY)
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor))
    camX = wx - screenX / zoom
    camY = wy - screenY / zoom
    clampCam()
  }

  function updateCamera() {
    if (!hole) return
    const visW = cw / zoom, visH = ch / zoom
    if (camMode === 'follow') {
      const b = myBall()
      let tx: number, ty: number
      if (b) {
        tx = (render.get(b.playerId)?.x ?? b.x) - visW / 2
        ty = (render.get(b.playerId)?.y ?? b.y) - visH * 0.6
      } else {
        const mid = (hole.teeBackX + hole.holeX) / 2
        tx = mid - visW / 2
        ty = tY(mid) - visH * 0.55
      }
      tx = hole.worldW <= visW ? (hole.worldW - visW) / 2 : Math.max(0, Math.min(tx, hole.worldW - visW))
      ty = hole.worldH <= visH ? (hole.worldH - visH) / 2 : Math.max(0, Math.min(ty, hole.worldH - visH))
      camX += (tx - camX) * 0.2
      camY += (ty - camY) * 0.2
    } else {
      // Free-look: held arrow keys pan the view.
      const step = PAN_STEP / zoom
      if (held.has('ArrowLeft')) camX -= step
      if (held.has('ArrowRight')) camX += step
      if (held.has('ArrowUp')) camY -= step
      if (held.has('ArrowDown')) camY += step
      clampCam()
    }
  }

  function drawShotRing(x: number, y: number, b: MatchBall, iz: number) {
    if (state?.phase !== 'playing' || b.sunk || !b.resting || predActive) return
    const remaining = shotRemainingMs(b)
    if (remaining <= 0) {
      ctx.strokeStyle = '#4f4'; ctx.lineWidth = 2 * iz
      ctx.beginPath(); ctx.arc(x, y, BALL_R + 4, 0, Math.PI * 2); ctx.stroke()
      return
    }
    const arc = (r: number, ratio: number) => {
      if (ratio <= 0) return
      ctx.strokeStyle = 'rgba(255,80,10,0.18)'; ctx.lineWidth = 3 * iz
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke()
      ctx.strokeStyle = `hsl(${(1 - ratio) * 25},100%,55%)`; ctx.lineWidth = 3 * iz; ctx.lineCap = 'round'
      ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2 + (1 - ratio) * Math.PI * 2, Math.PI * 1.5); ctx.stroke()
      ctx.lineCap = 'butt'
    }
    if (b.penalty) {
      arc(BALL_R + 16, Math.max(0, (remaining - SHOT_DELAY_MS) / SHOT_DELAY_MS))
      arc(BALL_R + 8, Math.min(1, remaining / SHOT_DELAY_MS))
    } else {
      arc(BALL_R + 8, remaining / SHOT_DELAY_MS)
    }
  }

  function draw() {
    ctx.fillStyle = '#050505'
    ctx.fillRect(0, 0, cw, ch)
    if (!hole) return
    const h = hole
    const th = hole.theme
    const iz = 1 / zoom // keep certain strokes a constant screen width regardless of zoom

    ctx.save()
    ctx.scale(zoom, zoom)
    ctx.translate(-camX, -camY)
    ctx.beginPath()
    ctx.rect(0, 0, h.worldW, h.worldH)
    ctx.clip()

    const sky = ctx.createLinearGradient(0, camY, 0, camY + ch / zoom)
    sky.addColorStop(0, th.skyTop)
    sky.addColorStop(1, th.skyBottom)
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, h.worldW, h.worldH)

    for (const p of waterPools) {
      const g = ctx.createLinearGradient(0, p.level, 0, p.floorY)
      g.addColorStop(0, hexWithAlpha(th.waterFill, 0.92))
      g.addColorStop(1, hexWithAlpha(th.waterFill, 0.97))
      ctx.fillStyle = g
      ctx.fillRect(p.left, p.level, p.right - p.left, h.worldH - p.level)
      ctx.strokeStyle = hexWithAlpha(th.waterLine, 0.7)
      ctx.lineWidth = th.waterLineW * iz
      ctx.beginPath(); ctx.moveTo(p.left, p.level); ctx.lineTo(p.right, p.level); ctx.stroke()
    }
    for (const bk of bunkerPools) {
      ctx.beginPath()
      ctx.moveTo(bk.leftX, splineY(bk.leftX, bk.coeffs))
      for (let x = bk.leftX + 5; x <= bk.rightX; x += 5) ctx.lineTo(x, splineY(x, bk.coeffs))
      ctx.lineTo(bk.rightX, h.worldH)
      ctx.lineTo(bk.leftX, h.worldH)
      ctx.closePath()
      ctx.fillStyle = 'rgba(210,185,100,0.88)'
      ctx.fill()
    }

    const hL = h.holeX - HOLE_W / 2
    const hR = h.holeX + HOLE_W / 2
    const floorY = tY(h.holeX) + HOLE_D
    const path = () => {
      ctx.moveTo(0, tY(0))
      let x = 20
      while (x < hL) { ctx.lineTo(x, tY(x)); x += 20 }
      ctx.lineTo(hL, tY(hL)); ctx.lineTo(hL, floorY)
      ctx.lineTo(hR, floorY); ctx.lineTo(hR, tY(hR))
      x = Math.ceil(hR / 20) * 20
      while (x <= h.worldW) { ctx.lineTo(x, tY(x)); x += 20 }
    }
    ctx.beginPath(); path()
    ctx.lineTo(h.worldW, h.worldH); ctx.lineTo(0, h.worldH); ctx.closePath()
    ctx.fillStyle = th.groundFill; ctx.fill()
    const pg = ctx.createLinearGradient(0, Math.min(tY(hL), tY(hR)), 0, floorY)
    pg.addColorStop(0, '#0c0c14'); pg.addColorStop(1, '#040406')
    ctx.fillStyle = pg
    ctx.fillRect(hL, Math.min(tY(hL), tY(hR)), hR - hL, floorY - Math.min(tY(hL), tY(hR)))
    ctx.beginPath(); path()
    ctx.strokeStyle = th.groundLine; ctx.lineWidth = th.groundLineW * iz; ctx.stroke()

    ctx.fillStyle = '#fff'
    for (const tx of [h.teeBackX, h.teeForwardX]) ctx.fillRect(tx - 3, tY(tx) - TEE_H, 6, TEE_H)

    const fx = h.holeX + HOLE_W / 2, fy = tY(h.holeX + HOLE_W / 2)
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 2 * iz
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy - 55); ctx.stroke()
    ctx.fillStyle = '#e44'
    ctx.beginPath(); ctx.moveTo(fx, fy - 55); ctx.lineTo(fx + 22, fy - 45); ctx.lineTo(fx, fy - 35); ctx.closePath(); ctx.fill()

    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6 * iz
    ctx.strokeRect(0, 0, h.worldW, h.worldH)

    if (state) {
      for (const b of state.balls) {
        const rp = render.get(b.playerId) ?? { x: b.x, y: b.y }
        if (b.sunk) { render.delete(b.playerId); continue }
        ctx.globalAlpha = 1
        ctx.fillStyle = colorHex(b.color)
        ctx.beginPath(); ctx.arc(rp.x, rp.y, BALL_R, 0, Math.PI * 2); ctx.fill()
        ctx.lineWidth = 2 * iz
        ctx.strokeStyle = b.playerId === myId ? '#fff' : 'rgba(0,0,0,0.35)'
        ctx.stroke()
        if (b.playerId === myId) drawShotRing(rp.x, rp.y, b, iz)
      }
    }
    ctx.restore()

    // Drag line (screen space)
    const mb = myBall()
    if (dragging && mb) {
      const { sx, sy } = worldToScreen(render.get(mb.playerId)?.x ?? mb.x, render.get(mb.playerId)?.y ?? mb.y)
      const ratio = Math.min(Math.hypot(dragX - sx, dragY - sy) / MAX_DRAG, 1)
      const grad = ctx.createLinearGradient(sx, sy, dragX, dragY)
      grad.addColorStop(0, '#4af'); grad.addColorStop(1, `hsl(${240 - ratio * 240},90%,55%)`)
      ctx.strokeStyle = grad; ctx.lineWidth = 2.5; ctx.setLineDash([5, 4])
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(dragX, dragY); ctx.stroke()
      ctx.setLineDash([])
    }

    drawMinimap()
  }

  const miniX = () => cw - MINI_W - MINI_PAD

  // Click/drag inside the minimap → free-look, camera jumps to that spot.
  function miniHit(px: number, py: number): boolean {
    const MX = miniX()
    return px >= MX && px <= MX + MINI_W && py >= MINI_PAD && py <= MINI_PAD + MINI_H
  }
  function miniJump(px: number, py: number) {
    if (!hole) return
    const wx = ((px - miniX()) / MINI_W) * hole.worldW
    const wy = ((py - MINI_PAD) / MINI_H) * hole.worldH
    camX = wx - cw / zoom / 2
    camY = wy - ch / zoom / 2
    clampCam()
  }

  function drawMinimap() {
    if (!hole) return
    const MW = MINI_W, MH = MINI_H, MX = miniX(), MY = MINI_PAD
    ctx.fillStyle = 'rgba(8,14,20,0.72)'; ctx.fillRect(MX, MY, MW, MH)
    ctx.strokeStyle = 'rgba(246,239,206,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(MX, MY, MW, MH)
    const mx = (wx: number) => MX + (wx / hole!.worldW) * MW
    const my = (wy: number) => MY + (wy / hole!.worldH) * MH
    ctx.strokeStyle = 'rgba(120,190,130,0.85)'; ctx.lineWidth = 1; ctx.beginPath()
    const stepx = hole.worldW / 60
    for (let x = 0; x <= hole.worldW; x += stepx) { const px = mx(x), py = my(tY(x)); x === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py) }
    ctx.stroke()
    ctx.fillStyle = 'rgba(47,121,194,0.65)'
    for (const p of waterPools) ctx.fillRect(mx(p.left), my(p.level), Math.max(2, mx(p.right) - mx(p.left)), 3)
    ctx.fillStyle = '#e44'; ctx.beginPath(); ctx.arc(mx(hole.holeX), my(tY(hole.holeX)), 2, 0, Math.PI * 2); ctx.fill()
    const visW = cw / zoom, visH = ch / zoom
    ctx.strokeStyle = 'rgba(246,239,206,0.75)'; ctx.lineWidth = 1
    ctx.strokeRect(mx(camX), my(camY), (visW / hole.worldW) * MW, (visH / hole.worldH) * MH)
    if (state) for (const b of state.balls) {
      if (b.sunk) continue
      const rp = render.get(b.playerId) ?? { x: b.x, y: b.y }
      ctx.fillStyle = colorHex(b.color); ctx.beginPath(); ctx.arc(mx(rp.x), my(rp.y), 2.5, 0, Math.PI * 2); ctx.fill()
    }
  }

  function tick() {
    requestAnimationFrame(tick)
    const now = performance.now()
    const dt = lastFrameMs ? Math.min((now - lastFrameMs) / 1000, 0.05) : 1 / 60
    lastFrameMs = now

    if (state) {
      for (const b of state.balls) {
        const rp = render.get(b.playerId)
        if (!rp) render.set(b.playerId, { x: b.x, y: b.y })
        else { rp.x += (b.x - rp.x) * BALL_LERP; rp.y += (b.y - rp.y) * BALL_LERP }
      }
    }

    if (predActive) {
      predVY += GRAVITY * dt
      predX += predVX * dt
      predY += predVY * dt
      if (myId != null) render.set(myId, { x: predX, y: predY })
      const mb = myBall()
      if ((mb && !mb.resting) || now - predStart > PRED_MAX_MS || state?.phase !== 'playing') predActive = false
    }

    updateCamera()
    draw()
    updateHud()
  }

  function updateHud() {
    if (!state) { hudEl.textContent = ''; countdownEl.style.display = 'none'; return }
    if (state.phase === 'playing') {
      const ms = clockBaseMs + (performance.now() - clockAt)
      hudEl.textContent = `Hole ${state.holeIndex + 1}/${state.holeCount}    ⏱ ${(ms / 1000).toFixed(1)}s`
      hudEl.style.display = ''
    } else {
      hudEl.style.display = 'none'
    }
    if (state.phase === 'countdown') {
      countdownEl.style.display = ''
      countdownEl.textContent = String(Math.max(1, Math.ceil(state.phaseMsLeft / 1000)))
    } else {
      countdownEl.style.display = 'none'
    }
  }

  function screenPos(ev: MouseEvent) {
    const r = canvas.getBoundingClientRect()
    return { x: ev.clientX - r.left, y: ev.clientY - r.top }
  }

  // ---- keyboard (attached while the screen is active) ----
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
    if (e.key === ' ') { e.preventDefault(); toggleFreeLook(); return }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      if (camMode === 'follow') enterFreeLook()
      held.add(e.key)
    }
  }
  const onKeyUp = (e: KeyboardEvent) => { held.delete(e.key) }

  return {
    id: 'match',
    mount() {
      const root = document.createElement('div')
      root.className = 'screen match-screen'
      root.innerHTML = `
        <div class="match-wrap">
          <canvas class="match-canvas"></canvas>
          <div class="match-hud" data-hud></div>
          <div class="match-countdown" data-countdown style="display:none"></div>
          <div class="free-arrows" data-arrows style="display:none">
            <div class="free-hint">Free look — Space or right-click to exit</div>
            <button class="free-arrow fa-up" data-pan="up">▲</button>
            <button class="free-arrow fa-down" data-pan="down">▼</button>
            <button class="free-arrow fa-left" data-pan="left">◀</button>
            <button class="free-arrow fa-right" data-pan="right">▶</button>
          </div>
          <div class="match-menu">
            <button class="match-menu-toggle" data-menu-toggle aria-label="Menu">☰</button>
            <div class="match-menu-panel" data-menu-panel style="display:none">
              <button class="mm-item" data-leave>Leave Game</button>
              <button class="mm-item" data-close>Close Menu</button>
            </div>
          </div>
          <div class="match-board" data-board style="display:none"></div>
        </div>`
      wrapEl = root.querySelector('.match-wrap')!
      canvas = root.querySelector('canvas')!
      ctx = canvas.getContext('2d')!
      hudEl = root.querySelector('[data-hud]')!
      countdownEl = root.querySelector('[data-countdown]')!
      boardEl = root.querySelector('[data-board]')!
      arrowsEl = root.querySelector('[data-arrows]')!
      menuPanelEl = root.querySelector('[data-menu-panel]')!

      resize()
      new ResizeObserver(() => resize()).observe(root)

      // Hamburger menu
      root.querySelector('[data-menu-toggle]')!.addEventListener('click', () => {
        menuPanelEl.style.display = menuPanelEl.style.display === 'none' ? '' : 'none'
      })
      root.querySelector('[data-close]')!.addEventListener('click', () => { menuPanelEl.style.display = 'none' })
      root.querySelector('[data-leave]')!.addEventListener('click', () => { menuPanelEl.style.display = 'none'; handlers.onLeave() })

      // Free-look arrow buttons nudge the camera.
      const nudge = (dir: string) => {
        const s = 90 / zoom
        if (dir === 'up') camY -= s
        else if (dir === 'down') camY += s
        else if (dir === 'left') camX -= s
        else if (dir === 'right') camX += s
        clampCam()
      }
      for (const btn of Array.from(arrowsEl.querySelectorAll<HTMLButtonElement>('[data-pan]'))) {
        btn.addEventListener('click', () => nudge(btn.dataset.pan!))
      }

      // Right-click toggles free-look (and never shows the context menu).
      canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleFreeLook() })

      // Wheel zooms while in free-look.
      canvas.addEventListener('wheel', (e) => {
        if (camMode !== 'free') return
        e.preventDefault()
        const p = screenPos(e)
        zoomAt(p.x, p.y, e.deltaY < 0 ? 1.1 : 1 / 1.1)
      }, { passive: false })

      canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const p = screenPos(e)
        // Minimap: enter free-look and scrub the camera by clicking/dragging on it.
        if (miniHit(p.x, p.y)) {
          enterFreeLook()
          miniJump(p.x, p.y)
          const onMove = (ev: MouseEvent) => { const q = screenPos(ev); miniJump(q.x, q.y) }
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
          return
        }
        if (camMode === 'free') {
          // Left-drag pans the view.
          panning = true; panLastX = p.x; panLastY = p.y
          canvas.style.cursor = 'grabbing'
          const onMove = (ev: MouseEvent) => {
            if (!panning) return
            const q = screenPos(ev)
            camX -= (q.x - panLastX) / zoom
            camY -= (q.y - panLastY) / zoom
            panLastX = q.x; panLastY = q.y
            clampCam()
          }
          const onUp = () => {
            panning = false; canvas.style.cursor = 'grab'
            window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
          return
        }
        // Shoot mode
        if (!canShoot()) return
        const mb = myBall()!
        const { sx, sy } = worldToScreen(render.get(mb.playerId)?.x ?? mb.x, render.get(mb.playerId)?.y ?? mb.y)
        if (Math.hypot(p.x - sx, p.y - sy) > BALL_R + 10) return
        dragging = true
        const clamp = (mx: number, my: number) => {
          const dx = mx - sx, dy = my - sy, d = Math.hypot(dx, dy)
          if (d > MAX_DRAG) { const k = MAX_DRAG / d; return { x: sx + dx * k, y: sy + dy * k } }
          return { x: mx, y: my }
        }
        const init = clamp(p.x, p.y); dragX = init.x; dragY = init.y
        const onMove = (ev: MouseEvent) => { const q = screenPos(ev); const c = clamp(q.x, q.y); dragX = c.x; dragY = c.y }
        const onUp = (ev: MouseEvent) => {
          dragging = false
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          const q = screenPos(ev)
          if (Math.hypot(q.x - sx, q.y - sy) <= BALL_R + 4) return
          const c = clamp(q.x, q.y)
          const vx = (sx - c.x) * POWER_SCALE, vy = (sy - c.y) * POWER_SCALE
          handlers.onShoot(vx, vy)
          const rp = render.get(mb.playerId) ?? { x: mb.x, y: mb.y }
          predX = rp.x; predY = rp.y; predVX = vx; predVY = vy; predStart = performance.now()
          predActive = true
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      })

      canvas.style.cursor = 'crosshair'
      requestAnimationFrame(tick)
      return root
    },
    onEnter() {
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
    },
    onExit() {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      exitFreeLook()
      menuPanelEl.style.display = 'none'
      render.clear()
      hole = null
      state = null
      predActive = false
      boardEl.style.display = 'none'
    },
    setMyId(id) { myId = id },
    setHole(m) {
      hole = m.hole
      render.clear()
      rebuildCaches()
      const visW = cw / zoom, visH = ch / zoom
      camX = Math.max(0, Math.min(hole.teeBackX - visW / 2, Math.max(0, hole.worldW - visW)))
      camY = Math.max(0, Math.min(tY(hole.teeBackX) - visH * 0.55, Math.max(0, hole.worldH - visH)))
    },
    setState(m) {
      state = m
      stateAt = performance.now()
      if (m.phase === 'playing') { clockBaseMs = m.holeMs; clockAt = stateAt }
      else predActive = false
      if (m.phase === 'playing' || m.phase === 'countdown') boardEl.style.display = 'none'
    },
    setLeaderboard(m) {
      const title = m.final ? 'Final Results' : `Hole ${m.holeIndex + 1} of ${m.holeCount}`
      const rows = m.entries
        .slice()
        .sort((a, b) => (m.victory === 'holes' ? b.holesWon - a.holesWon || a.totalMs - b.totalMs : a.totalMs - b.totalMs))
        .map((e, i) => {
          const metric = m.victory === 'holes' ? `${e.holesWon} holes` : `${(e.totalMs / 1000).toFixed(1)}s`
          const holeCell = e.dnf ? 'DNF' : `${(e.holeMs / 1000).toFixed(1)}s`
          return `<div class="mb-row">
            <span class="mb-rank">${i + 1}</span>
            <span class="mb-dot" style="background:${colorHex(e.color)}"></span>
            <span class="mb-name">${escapeHtml(e.name)}</span>
            <span class="mb-hole">${holeCell}</span>
            <span class="mb-total">${metric}</span>
          </div>`
        })
        .join('')
      boardEl.innerHTML = `
        <div class="mb-card">
          <h2 class="mb-title">${title}</h2>
          <div class="mb-head"><span class="mb-rank"></span><span class="mb-dot"></span><span class="mb-name"></span><span class="mb-hole">This hole</span><span class="mb-total">${m.victory === 'holes' ? 'Won' : 'Total'}</span></div>
          ${rows}
          ${m.final ? '<button class="mb-return" type="button">Back to Lobby</button>' : '<div class="mb-next">Next hole starting…</div>'}
        </div>`
      boardEl.style.display = ''
      boardEl.querySelector<HTMLButtonElement>('.mb-return')?.addEventListener('click', () => handlers.onReturn())
    },
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
