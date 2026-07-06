import './match.css'
import '../gameChrome.css'
import type { Screen } from './screenManager'
import type { MatchHole, MatchState, MatchLeaderboard, MatchBall } from '../lobbyNet'
import type { Hole, BuiltSegment, SplineCoeff } from '../terrain'
import { buildSegments, terrainY, buildSpline, splineY, waterPoolBounds, hexWithAlpha, SPLINE_BASE_REF, baseOffset, bunkerRimCoeffs } from '../terrain'
import { colorHex } from './roomLobby'
import { GameCamera, mountGameChrome } from '../gameCamera'
import { SwingEngine, formatDistance } from '../swing'

// The rendered canvas grows to fill the window but never shrinks below this — the
// old fixed size, which reads well as a floor.
const MIN_W = 900
const MIN_H = 560
const BALL_R = 10
const HOLE_W = 30
const HOLE_D = 40
const TEE_H = 10
const BALL_LERP = 0.85
const GRAVITY = 1500 // must match physics.Gravity on the server (for shot prediction)
const PRED_MAX_MS = 500
const SHOT_DELAY_MS = 2500 // matches server shotDelayTicks; water penalty is 2×

export interface MatchHandlers {
  onShoot: (vx: number, vy: number, club: string) => void
  onReturn: () => void
  onLeave: () => void
}

export interface MatchScreenApi extends Screen {
  setMyId(id: number): void
  setHole(m: MatchHole): void
  setState(m: MatchState): void
  setLeaderboard(m: MatchLeaderboard): void
}

// Blends a #rrggbb color toward the water blue by fraction t (0-1) — used to
// tint a ball bluer as it sinks (instead of fading it out).
function tintTowardWater(hex: string, t: number): string {
  const wr = 90, wg = 175, wb = 235 // ~ #5fb8e6 water tone
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const mix = (c: number, w: number) => Math.round(c + (w - c) * t)
  return `rgb(${mix(r, wr)},${mix(g, wg)},${mix(b, wb)})`
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
  // When each ball started sinking underwater (perf-clock ms), for the fade-out.
  const sinkStart = new Map<number, number>()

  const cam = new GameCamera()

  const swing = new SwingEngine({ ballColorHex: '#fff' })

  // Aim-drag visualization + dead-zone (ported from single-player main.ts): a
  // screen-space line from the click's start point to the cursor, shown while
  // held. Staying within AIM_DEADZONE_R of the start leaves the angle at its
  // pre-drag value (a cancelable dead zone). Both the threshold and its circle
  // are fixed screen-space sizes (no zoom scaling — cursor travel, not world
  // distance, is what matters).
  let aiming = false, aimEngaged = false
  let aimStartSx = 0, aimStartSy = 0, aimCurSx = 0, aimCurSy = 0
  const AIM_DRAG_COLOR = 'rgba(120,200,255,0.9)'
  const AIM_DEADZONE_R = BALL_R * 4

  let clockBaseMs = 0
  let clockAt = 0
  let stateAt = 0

  let predActive = false
  let predX = 0, predY = 0, predVX = 0, predVY = 0, predStart = 0
  let lastFrameMs = 0
  let myWasMoving = false // rest-edge tracking for the shot auto-zoom end

  let canvas!: HTMLCanvasElement
  let ctx!: CanvasRenderingContext2D
  let countdownEl!: HTMLElement
  let boardEl!: HTMLElement
  let chrome!: ReturnType<typeof mountGameChrome>

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

  // Ready to shoot again (ball settled, not predicting, cooldown elapsed). Split
  // like single-player: canPreviewShot gates the parabola display (visible in
  // free-look too); canShoot additionally requires Hit/follow mode for actual
  // aiming + firing.
  const canPreviewShot = (): boolean => {
    const b = myBall()
    return !predActive && !!b && state?.phase === 'playing' && b.resting && !b.sunk && shotRemainingMs(b) <= 0
  }
  const canShoot = (): boolean => cam.mode === 'follow' && canPreviewShot()

  // Rendered world position of my ball (falls back to the authoritative state).
  const myBallPos = (): { x: number; y: number } | null => {
    const b = myBall()
    if (!b) return null
    const rp = render.get(b.playerId)
    return { x: rp?.x ?? b.x, y: rp?.y ?? b.y }
  }

  // Whether world-x sits over a bunker (rim above bare terrain there) — mirrors
  // the server's bunker check, drives the swing bunker-penalty % + prediction.
  const xInBunker = (x: number): boolean => {
    for (const bp of bunkerPools) {
      if (x < bp.leftX || x > bp.rightX) continue
      if (splineY(x, bp.coeffs) < tY(x)) return true
    }
    return false
  }

  // Fire the current swing: capture power from the Hit! meter (or start the
  // sweep on the first press), convert to a launch velocity, send it, and kick
  // off the local shot prediction. Shared by the Hit! HUD button and Space.
  function fireHit() {
    if (!canShoot()) return
    const res = swing.pressHit(performance.now())
    if (!res) return
    const mb = myBall()
    const pos = myBallPos()
    if (!mb || !pos) return
    const { vx, vy } = swing.getLaunchVelocity(res.powerPct)
    handlers.onShoot(vx, vy, swing.club)
    predX = pos.x; predY = pos.y; predVX = vx; predVY = vy; predStart = performance.now()
    predActive = true
    // Auto-zoom out to capture the trajectory; eases back in when the ball rests.
    cam.startShot(vx, vy, GRAVITY)
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
    ctx.fillRect(0, 0, cam.cw, cam.ch)
    if (!hole) return
    const h = hole
    const th = hole.theme
    const iz = 1 / cam.zoom // keep certain strokes a constant screen width regardless of zoom

    ctx.save()
    ctx.scale(cam.zoom, cam.zoom)
    ctx.translate(-cam.camX, -cam.camY)
    ctx.beginPath()
    ctx.rect(0, 0, h.worldW, h.worldH)
    ctx.clip()

    const sky = ctx.createLinearGradient(0, cam.camY, 0, cam.camY + cam.ch / cam.zoom)
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
      const now = performance.now()
      for (const b of state.balls) {
        const rp = render.get(b.playerId) ?? { x: b.x, y: b.y }
        if (b.sunk) { render.delete(b.playerId); sinkStart.delete(b.playerId); continue }
        // Sinking underwater: don't fade the ball out — tint it slightly bluer
        // (toward the water color) so it stays clearly visible while reading as
        // submerged (matches single-player).
        let fill = colorHex(b.color)
        if (b.inWater) {
          const t0 = sinkStart.get(b.playerId) ?? (sinkStart.set(b.playerId, now), now)
          const t = Math.min(1, (now - t0) / 1000)
          fill = tintTowardWater(fill, 0.45 * t)
        } else {
          sinkStart.delete(b.playerId)
        }
        ctx.fillStyle = fill
        ctx.beginPath(); ctx.arc(rp.x, rp.y, BALL_R, 0, Math.PI * 2); ctx.fill()
        ctx.lineWidth = 2 * iz
        ctx.strokeStyle = b.playerId === myId ? '#fff' : 'rgba(0,0,0,0.35)'
        ctx.stroke()
        if (b.playerId === myId) drawShotRing(rp.x, rp.y, b, iz)
      }
    }

    // Parabola preview (world space, drawn inside the camera transform) — shown
    // whenever the ball is ready to shoot again, in both Hit mode and free-look.
    // Aim-drag color while a drag has moved the angle past the dead zone; white
    // otherwise. Computed here so the minimap can reuse the same world points.
    const pos = myBallPos()
    const parabolaPts = pos && canPreviewShot()
      ? swing.computeParabolaWorld(pos.x, pos.y, h.worldW, h.worldH)
      : null
    const parabolaColor = aiming && aimEngaged ? AIM_DRAG_COLOR : 'rgba(255,255,255,0.85)'
    if (parabolaPts) swing.drawParabolaWorld(ctx, parabolaPts, cam.zoom, parabolaColor)

    ctx.restore()

    // Aim-drag visualization (screen space): dead-zone circle at the origin —
    // red while inside it (cancelable), light blue once dragged past — plus a
    // dashed line to the cursor.
    if (aiming) {
      ctx.strokeStyle = aimEngaged ? AIM_DRAG_COLOR : 'rgba(255,60,60,0.85)'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(aimStartSx, aimStartSy, AIM_DEADZONE_R, 0, Math.PI * 2); ctx.stroke()
      ctx.strokeStyle = AIM_DRAG_COLOR; ctx.lineWidth = 2; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(aimStartSx, aimStartSy); ctx.lineTo(aimCurSx, aimCurSy); ctx.stroke()
      ctx.setLineDash([])
    }

    cam.drawMinimapFrame(ctx, (mwx, mwy) => {
      ctx.strokeStyle = 'rgba(120,190,130,0.85)'; ctx.lineWidth = 1; ctx.beginPath()
      const stepx = h.worldW / 60
      for (let x = 0; x <= h.worldW; x += stepx) { const px = mwx(x), py = mwy(tY(x)); x === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py) }
      ctx.stroke()
      ctx.fillStyle = 'rgba(47,121,194,0.65)'
      for (const p of waterPools) ctx.fillRect(mwx(p.left), mwy(p.level), Math.max(2, mwx(p.right) - mwx(p.left)), 3)
      // Bunkers: sandy rim line along each bunker's spline.
      ctx.strokeStyle = 'rgba(210,185,100,0.95)'; ctx.lineWidth = 2
      for (const bk of bunkerPools) {
        ctx.beginPath()
        ctx.moveTo(mwx(bk.leftX), mwy(splineY(bk.leftX, bk.coeffs)))
        for (let x = bk.leftX + 20; x <= bk.rightX; x += 20) ctx.lineTo(mwx(x), mwy(splineY(x, bk.coeffs)))
        ctx.stroke()
      }
      ctx.fillStyle = '#e44'; ctx.beginPath(); ctx.arc(mwx(h.holeX), mwy(tY(h.holeX)), 2, 0, Math.PI * 2); ctx.fill()
      if (state) for (const b of state.balls) {
        if (b.sunk) continue
        const rp = render.get(b.playerId) ?? { x: b.x, y: b.y }
        ctx.fillStyle = colorHex(b.color); ctx.beginPath(); ctx.arc(mwx(rp.x), mwy(rp.y), 2.5, 0, Math.PI * 2); ctx.fill()
      }
      if (parabolaPts) {
        ctx.strokeStyle = parabolaColor; ctx.lineWidth = 1; ctx.beginPath()
        parabolaPts.forEach((p, i) => { const px = mwx(p.x), py = mwy(p.y); i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py) })
        ctx.stroke()
      }
    })

    // Distance-to-hole readout under the minimap (matches single-player).
    if (pos) {
      const miniBox = cam.miniBox()
      const holeDistPx = Math.hypot(h.holeX - pos.x, tY(h.holeX) - pos.y)
      ctx.fillStyle = '#888'; ctx.font = '12px monospace'
      ctx.fillText(`hole: ${formatDistance(holeDistPx)}`, miniBox.x + 2, miniBox.y + miniBox.h + 18)
    }

    // Swing HUD (club/spin selectors + Hit! meter), drawn last, screen space.
    swing.drawHud(ctx, cam.cw, cam.ch)
  }

  function tick() {
    requestAnimationFrame(tick)
    const now = performance.now()
    const dt = lastFrameMs ? Math.min((now - lastFrameMs) / 1000, 0.05) : 1 / 60
    lastFrameMs = now

    // Only flag the bunker penalty when the ball is settled and ready to shoot,
    // not while it's still flying over the sand (matches canPreviewShot gating).
    const bpos = myBallPos()
    swing.inBunker = !!bpos && canPreviewShot() && xInBunker(bpos.x)
    swing.update(now)

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

    if (hole) {
      const b = myBall()
      if (b) {
        const bx = render.get(b.playerId)?.x ?? b.x
        const by = render.get(b.playerId)?.y ?? b.y
        const moving = predActive || !b.resting
        if (myWasMoving && !moving) cam.endShot() // rest edge — ease the camera back in
        myWasMoving = moving
        cam.update({
          x: bx, y: by,
          secondary: { x: hole.holeX, y: tY(hole.holeX) },
          ballMoving: moving,
        })
      } else {
        cam.update({ x: (hole.teeBackX + hole.holeX) / 2, y: tY((hole.teeBackX + hole.holeX) / 2) })
      }
    }
    draw()
    updateHud()
  }

  function updateHud() {
    if (!state) { chrome.setHud(null); countdownEl.style.display = 'none'; return }
    if (state.phase === 'playing') {
      const ms = clockBaseMs + (performance.now() - clockAt)
      chrome.setHud(`Hole ${state.holeIndex + 1}/${state.holeCount}    ⏱ ${(ms / 1000).toFixed(1)}s`)
    } else {
      chrome.setHud(null)
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
  // Escape toggles the hamburger menu; Enter/M/arrows/Space are handled by
  // cam.onKeyDown (see gameCamera.ts) — same bindings as single-player.
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
    if (e.key === 'Escape') { e.preventDefault(); chrome.toggleMenu(); return }
    if (cam.onKeyDown(e)) { e.preventDefault(); chrome.sync(); return }
    // Swing shortcuts (mirror single-player): 1/2/3 club, 4/5/6 spin, Space = Hit!
    if (e.key === ' ') { e.preventDefault(); fireHit(); return }
    if (e.key === '1') { swing.club = 'driver'; return }
    if (e.key === '2') { swing.club = 'wedge'; return }
    if (e.key === '3') { swing.club = 'putter'; return }
    if (e.key === '4') { swing.spin = 'back'; return }
    if (e.key === '5') { swing.spin = 'none'; return }
    if (e.key === '6') { swing.spin = 'top'; return }
  }
  const onKeyUp = (e: KeyboardEvent) => { cam.onKeyUp(e) }

  return {
    id: 'match',
    mount() {
      const root = document.createElement('div')
      root.className = 'screen match-screen'

      chrome = mountGameChrome(root, cam, {
        minW: MIN_W,
        minH: MIN_H,
        menuItems: [
          { label: 'Leave Game', onClick: () => handlers.onLeave() },
        ],
      })
      canvas = chrome.canvas
      ctx = chrome.ctx

      countdownEl = document.createElement('div')
      countdownEl.className = 'match-countdown'
      countdownEl.style.display = 'none'
      chrome.root.appendChild(countdownEl)

      boardEl = document.createElement('div')
      boardEl.className = 'match-board'
      boardEl.style.display = 'none'
      chrome.root.appendChild(boardEl)

      canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const p = screenPos(e)
        // Minimap: enter free-look and scrub the camera by clicking/dragging on it.
        if (cam.miniHit(p.x, p.y)) {
          cam.enterFreeLook()
          chrome.sync()
          cam.miniJump(p.x, p.y)
          const onMove = (ev: MouseEvent) => { const q = screenPos(ev); cam.miniJump(q.x, q.y) }
          const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
          return
        }
        // Swing HUD (club/spin selectors + Hit! button) — hit-tested before the
        // free-look/aim branches so the controls work in either camera mode.
        const hud = swing.hitTestHud(p.x, p.y, cam.cw, cam.ch)
        if (hud) {
          if (hud === 'hit') fireHit()
          else swing.handleHudClick(hud)
          return
        }

        if (cam.mode === 'free') {
          // Left-drag pans the view.
          let panLastX = p.x, panLastY = p.y
          canvas.style.cursor = 'grabbing'
          const onMove = (ev: MouseEvent) => {
            const q = screenPos(ev)
            cam.panBy(q.x - panLastX, q.y - panLastY)
            panLastX = q.x; panLastY = q.y
          }
          const onUp = () => {
            canvas.style.cursor = 'grab'
            window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
          return
        }

        // Aim-drag (click-anywhere slingshot, dead-zone cancel) — same model as
        // single-player. The aim is set from the drag's start->current point, so
        // the click need not land on the ball. Firing is via the Hit! meter, not
        // release, so onUp just finalizes the angle.
        if (!canShoot()) return
        const startSx = p.x, startSy = p.y
        const preDragAngle = swing.aimAngle
        aiming = true; aimStartSx = startSx; aimStartSy = startSy; aimCurSx = startSx; aimCurSy = startSy
        const applyAim = (mx: number, my: number) => {
          aimCurSx = mx; aimCurSy = my
          aimEngaged = Math.hypot(mx - startSx, my - startSy) > AIM_DEADZONE_R
          if (aimEngaged) swing.setAimFromScreen(startSx, startSy, mx, my)
          else swing.aimAngle = preDragAngle
        }
        applyAim(startSx, startSy)
        const onMove = (ev: MouseEvent) => { const q = screenPos(ev); applyAim(q.x, q.y) }
        const onUp = (ev: MouseEvent) => {
          window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
          aiming = false
          const q = screenPos(ev); applyAim(q.x, q.y)
        }
        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
      })

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
      cam.exitFreeLook()
      chrome.sync()
      chrome.closeMenu()
      render.clear()
      sinkStart.clear()
      hole = null
      state = null
      predActive = false
      myWasMoving = false; cam.endShot()
      aiming = false; aimEngaged = false
      boardEl.style.display = 'none'
    },
    setMyId(id) { myId = id },
    setHole(m) {
      hole = m.hole
      render.clear()
      rebuildCaches()
      myWasMoving = false; cam.endShot()
      cam.setWorld(hole.worldW, hole.worldH)
      cam.centerOn(hole.teeBackX, tY(hole.teeBackX))
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
