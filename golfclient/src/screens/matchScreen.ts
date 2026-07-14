import './match.css'
import '../gameChrome.css'
import type { Screen } from './screenManager'
import type { MatchHole, MatchState, MatchLeaderboard, MatchBall } from '../lobbyNet'
import type { Hole, BuiltSegment, SplineCoeff } from '../terrain'
import { buildSegments, terrainY, buildSpline, splineY, waterPoolBounds, hexWithAlpha, SPLINE_BASE_REF, baseOffset, bunkerRimCoeffs, normalizeTees } from '../terrain'
import { colorHex } from './roomLobby'
import { GameCamera, mountGameChrome } from '../gameCamera'
import { SwingEngine, formatDistance, airStep, WIND_MPH_SCALE, NO_SPIN_BACKSPIN_FRAC } from '../swing'

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
  onShoot: (vx: number, vy: number, club: string, spin: string) => void
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
  const AIM_DRAG_COLOR = 'rgba(150,215,255,1)'
  const AIM_DEADZONE_R = BALL_R * 4
  // While actively changing the angle, the aim guides pulse between a bright and
  // a near-white cyan on a slow (~1.6s) sine so they read as "live".
  const AIM_PULSE_MS = 1600
  const aimPulseColor = (nowMs: number): string => {
    const t = (Math.sin((nowMs / AIM_PULSE_MS) * Math.PI * 2) + 1) / 2 // 0..1
    return `rgb(${Math.round(150 + t * 75)},${Math.round(215 + t * 30)},255)`
  }

  let clockBaseMs = 0
  let clockAt = 0
  let stateAt = 0

  let predActive = false
  let predX = 0, predY = 0, predVX = 0, predVY = 0, predStart = 0
  let predSpin = 0 // -1/0/+1, captured at fire so prediction matches the shot's spin
  let windMph = 0  // current hole's wind (mph, +right), from match:state/match:hole
  let lastFrameMs = 0
  let myWasMoving = false // rest-edge tracking for the shot auto-zoom end

  let canvas!: HTMLCanvasElement
  let ctx!: CanvasRenderingContext2D
  let countdownEl!: HTMLElement
  let boardEl!: HTMLElement
  let chrome!: ReturnType<typeof mountGameChrome>

  // Offscreen cache for the static world (terrain, water, bunkers, hole, tees,
  // flag, border). It's re-baked only when the camera moves or the hole/canvas
  // changes — so a settled camera (e.g. during the Hit! meter) collapses the
  // whole scene to a single drawImage instead of re-tracing every path.
  const staticCanvas: HTMLCanvasElement = document.createElement('canvas')
  const staticCtx: CanvasRenderingContext2D = staticCanvas.getContext('2d')!
  let staticDirty = true
  // Snapshot of the camera/canvas state the offscreen was last baked at.
  let bakedCamX = NaN, bakedCamY = NaN, bakedZoom = NaN, bakedCW = 0, bakedCH = 0, bakedDpr = 0

  // Sub-pixel easing tails shouldn't force a re-bake every frame; a re-bake only
  // matters once the change is visible (~half a device pixel).
  const camMoved = (dpr: number): boolean =>
    canvas.width !== bakedCW || canvas.height !== bakedCH || dpr !== bakedDpr ||
    Math.abs(cam.zoom - bakedZoom) > 1e-4 ||
    Math.abs((cam.camX - bakedCamX) * cam.zoom) > 0.5 / dpr ||
    Math.abs((cam.camY - bakedCamY) * cam.zoom) > 0.5 / dpr

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
    staticDirty = true
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

  // A spectator is a member with no ball of their own once a match is running.
  // They watch passively — no aim, no swing HUD, no controls.
  const isSpectator = (): boolean => !!state && state.balls.length > 0 && !myBall()

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
  // Sends a resolved (3rd-press or auto) shot: launch velocity + prediction.
  function launchFromResult(res: Extract<ReturnType<typeof swing.pressHit>, { fired: true }>) {
    const pos = myBallPos()
    if (!myBall() || !pos) return
    const { vx, vy } = swing.resolveLaunch(res)
    // A duff fires with no spin (see resolveLaunch); send 'none' so the server's
    // ball flight and our local prediction both drop the spin.
    const shotSpin = res.duff ? 'none' : swing.spin
    handlers.onShoot(vx, vy, swing.club, shotSpin)
    predX = pos.x; predY = pos.y; predVX = vx; predVY = vy; predStart = performance.now()
    predSpin = shotSpin === 'back' ? -1 : shotSpin === 'top' ? 1 : 0
    predActive = true
    // Auto-zoom out to capture the trajectory; eases back in when the ball rests.
    cam.startShot(vx, vy, GRAVITY)
  }

  function fireHit() {
    if (!canShoot()) return
    const res = swing.pressHit(performance.now())
    // Press 1 -> null, press 2 -> power captured (keep swinging), press 3 -> launch.
    if (res && res.fired) launchFromResult(res)
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

  // Draws the void + static world into context `g` (the offscreen), applying the
  // current dpr + camera transform so its output is a screen-space bitmap ready
  // to blit 1:1. Kept byte-identical to the previous inline block.
  function drawStaticWorld(g: CanvasRenderingContext2D, dpr: number) {
    if (!hole) return
    const h = hole
    const th = hole.theme
    const iz = 1 / cam.zoom // keep certain strokes a constant screen width regardless of zoom

    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = '#050505'
    g.fillRect(0, 0, cam.cw, cam.ch)

    g.save()
    g.scale(cam.zoom, cam.zoom)
    g.translate(-cam.camX, -cam.camY)
    g.beginPath()
    g.rect(0, 0, h.worldW, h.worldH)
    g.clip()

    const sky = g.createLinearGradient(0, cam.camY, 0, cam.camY + cam.ch / cam.zoom)
    sky.addColorStop(0, th.skyTop)
    sky.addColorStop(1, th.skyBottom)
    g.fillStyle = sky
    g.fillRect(0, 0, h.worldW, h.worldH)

    for (const p of waterPools) {
      const wg = g.createLinearGradient(0, p.level, 0, p.floorY)
      wg.addColorStop(0, hexWithAlpha(th.waterFill, 0.92))
      wg.addColorStop(1, hexWithAlpha(th.waterFill, 0.97))
      g.fillStyle = wg
      g.fillRect(p.left, p.level, p.right - p.left, h.worldH - p.level)
      g.strokeStyle = hexWithAlpha(th.waterLine, 0.7)
      g.lineWidth = th.waterLineW * iz
      g.beginPath(); g.moveTo(p.left, p.level); g.lineTo(p.right, p.level); g.stroke()
    }
    for (const bk of bunkerPools) {
      g.beginPath()
      g.moveTo(bk.leftX, splineY(bk.leftX, bk.coeffs))
      for (let x = bk.leftX + 5; x <= bk.rightX; x += 5) g.lineTo(x, splineY(x, bk.coeffs))
      g.lineTo(bk.rightX, h.worldH)
      g.lineTo(bk.leftX, h.worldH)
      g.closePath()
      g.fillStyle = 'rgba(210,185,100,0.88)'
      g.fill()
    }

    const hL = h.holeX - HOLE_W / 2
    const hR = h.holeX + HOLE_W / 2
    const floorY = tY(h.holeX) + HOLE_D
    const path = () => {
      g.moveTo(0, tY(0))
      let x = 20
      while (x < hL) { g.lineTo(x, tY(x)); x += 20 }
      g.lineTo(hL, tY(hL)); g.lineTo(hL, floorY)
      g.lineTo(hR, floorY); g.lineTo(hR, tY(hR))
      x = Math.ceil(hR / 20) * 20
      while (x <= h.worldW) { g.lineTo(x, tY(x)); x += 20 }
    }
    g.beginPath(); path()
    g.lineTo(h.worldW, h.worldH); g.lineTo(0, h.worldH); g.closePath()
    g.fillStyle = th.groundFill; g.fill()
    const pg = g.createLinearGradient(0, Math.min(tY(hL), tY(hR)), 0, floorY)
    pg.addColorStop(0, '#0c0c14'); pg.addColorStop(1, '#040406')
    g.fillStyle = pg
    g.fillRect(hL, Math.min(tY(hL), tY(hR)), hR - hL, floorY - Math.min(tY(hL), tY(hR)))
    g.beginPath(); path()
    g.strokeStyle = th.groundLine; g.lineWidth = th.groundLineW * iz; g.stroke()

    g.fillStyle = '#fff'
    for (const tx of h.tees) g.fillRect(tx - 3, tY(tx) - TEE_H, 6, TEE_H)

    const fx = h.holeX + HOLE_W / 2, fy = tY(h.holeX + HOLE_W / 2)
    g.strokeStyle = '#bbb'; g.lineWidth = 2 * iz
    g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx, fy - 55); g.stroke()
    g.fillStyle = '#e44'
    g.beginPath(); g.moveTo(fx, fy - 55); g.lineTo(fx + 22, fy - 45); g.lineTo(fx, fy - 35); g.closePath(); g.fill()

    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 6 * iz
    g.strokeRect(0, 0, h.worldW, h.worldH)
    g.restore()
  }

  function draw() {
    if (!hole) {
      ctx.fillStyle = '#050505'
      ctx.fillRect(0, 0, cam.cw, cam.ch)
      return
    }
    const h = hole
    const iz = 1 / cam.zoom // keep certain strokes a constant screen width regardless of zoom
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1

    // Bake the static world offscreen only when it can actually have changed:
    // hole/canvas swap (staticDirty) or a visible camera move. A settled camera
    // (during the Hit! meter, resting balls) reuses the last bitmap.
    if (staticCanvas.width !== canvas.width || staticCanvas.height !== canvas.height) {
      staticCanvas.width = canvas.width
      staticCanvas.height = canvas.height
      staticDirty = true
    }
    if (staticDirty || camMoved(dpr)) {
      drawStaticWorld(staticCtx, dpr)
      bakedCamX = cam.camX; bakedCamY = cam.camY; bakedZoom = cam.zoom
      bakedCW = canvas.width; bakedCH = canvas.height; bakedDpr = dpr
      staticDirty = false
    }

    // Blit the baked static world (screen-space, backing-store pixels → CSS box).
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(staticCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Dynamic layer shares the same world transform the static bake used.
    ctx.save()
    ctx.scale(cam.zoom, cam.zoom)
    ctx.translate(-cam.camX, -cam.camY)
    ctx.beginPath()
    ctx.rect(0, 0, h.worldW, h.worldH)
    ctx.clip()

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
      ? swing.computeParabolaWorld(pos.x, pos.y, h.worldW, h.worldH, (x) => tY(x) - BALL_R)
      : null
    // While actively changing the angle, the aim guides glow with a slow pulse;
    // otherwise they use the steady bright blue.
    const engaged = aiming && aimEngaged
    const aimColor = engaged ? aimPulseColor(performance.now()) : AIM_DRAG_COLOR

    const parabolaColor = engaged ? aimColor : 'rgba(255,255,255,0.85)'
    if (parabolaPts) swing.drawParabolaWorld(ctx, parabolaPts, cam.zoom, parabolaColor)

    ctx.restore()

    // Central aim zone — the hashed blue circle where a drag starts an aim
    // (drags outside it scroll the view). Shown whenever aiming is available,
    // highlighted (and pulsing) while actively aiming.
    if (canShoot()) swing.drawAimZone(ctx, cam.cw, cam.ch, engaged, engaged ? aimColor : undefined)

    // Aim-drag visualization (screen space): dead-zone circle at the origin —
    // red while inside it (cancelable), light blue once dragged past — plus a
    // dashed line to the cursor.
    if (aiming) {
      ctx.strokeStyle = aimEngaged ? aimColor : 'rgba(255,60,60,0.85)'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(aimStartSx, aimStartSy, AIM_DEADZONE_R, 0, Math.PI * 2); ctx.stroke()
      ctx.strokeStyle = aimColor; ctx.lineWidth = 2; ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(aimStartSx, aimStartSy); ctx.lineTo(aimCurSx, aimCurSy); ctx.stroke()
      ctx.setLineDash([])
    }

    // Minimap content, renderer-agnostic (draws via the mwx/mwy mappers) so it
    // works whether the frame targets the game canvas (desktop, top-right) or the
    // portrait strip canvas above the square.
    const mc = chrome.portrait && chrome.miniCtx ? chrome.miniCtx : ctx
    const drawMiniContent = (box: { x: number; y: number; w: number; h: number }, mwx: (x: number) => number, mwy: (y: number) => number) => {
      const stepx = h.worldW / 60
      // Sky gradient (no sun) + filled terrain, same theme as the main view.
      const sky = mc.createLinearGradient(0, box.y, 0, box.y + box.h)
      sky.addColorStop(0, h.theme.skyTop); sky.addColorStop(1, h.theme.skyBottom)
      mc.save()
      mc.beginPath(); mc.rect(box.x, box.y, box.w, box.h); mc.clip()
      mc.fillStyle = sky; mc.fillRect(box.x, box.y, box.w, box.h)
      mc.beginPath(); mc.moveTo(mwx(0), mwy(tY(0)))
      for (let x = stepx; x <= h.worldW; x += stepx) mc.lineTo(mwx(x), mwy(tY(x)))
      mc.lineTo(box.x + box.w, box.y + box.h); mc.lineTo(box.x, box.y + box.h); mc.closePath()
      mc.fillStyle = h.theme.groundFill; mc.fill()
      mc.strokeStyle = h.theme.groundLine; mc.lineWidth = 1; mc.beginPath()
      for (let x = 0; x <= h.worldW; x += stepx) { const px = mwx(x), py = mwy(tY(x)); x === 0 ? mc.moveTo(px, py) : mc.lineTo(px, py) }
      mc.stroke()
      mc.fillStyle = 'rgba(47,121,194,0.65)'
      for (const p of waterPools) mc.fillRect(mwx(p.left), mwy(p.level), Math.max(2, mwx(p.right) - mwx(p.left)), 3)
      mc.strokeStyle = 'rgba(210,185,100,0.95)'; mc.lineWidth = 2
      for (const bk of bunkerPools) {
        mc.beginPath()
        mc.moveTo(mwx(bk.leftX), mwy(splineY(bk.leftX, bk.coeffs)))
        for (let x = bk.leftX + 20; x <= bk.rightX; x += 20) mc.lineTo(mwx(x), mwy(splineY(x, bk.coeffs)))
        mc.stroke()
      }
      mc.fillStyle = '#e44'; mc.beginPath(); mc.arc(mwx(h.holeX), mwy(tY(h.holeX)), 2, 0, Math.PI * 2); mc.fill()
      if (state) for (const b of state.balls) {
        if (b.sunk) continue
        const rp = render.get(b.playerId) ?? { x: b.x, y: b.y }
        mc.fillStyle = colorHex(b.color); mc.beginPath(); mc.arc(mwx(rp.x), mwy(rp.y), 2.5, 0, Math.PI * 2); mc.fill()
      }
      if (parabolaPts) {
        mc.strokeStyle = parabolaColor; mc.lineWidth = 1; mc.beginPath()
        parabolaPts.forEach((p, i) => { const px = mwx(p.x), py = mwy(p.y); i === 0 ? mc.moveTo(px, py) : mc.lineTo(px, py) })
        mc.stroke()
      }
      mc.restore()
    }

    if (chrome.portrait) {
      // Portrait: minimap → strip canvas; controls → DOM below the square.
      if (chrome.miniCtx) {
        const b = chrome.miniStripBox()
        chrome.miniCtx.clearRect(0, 0, b.w, b.h)
        cam.drawMinimapInBox(chrome.miniCtx, b, (mwx, mwy) => drawMiniContent(b, mwx, mwy))
      }
      if (isSpectator()) {
        chrome.setControls(null)
      } else {
        const mgeom = swing.meterGeom()
        chrome.setControls({
          club: swing.club, spin: swing.spin,
          swinging: swing.isSwinging(),
          bunkerPct: swing.inBunker ? Math.round(swing.clubBunkerPct()) : null,
          ballFrac: mgeom.ballFrac, greenLeftFrac: mgeom.greenLeftFrac, greenRightFrac: mgeom.greenRightFrac,
          powerMarkerFrac: mgeom.powerMarkerFrac,
          powerPct: swing.lastPowerPct, accuracyPct: swing.lastAccuracyPct,
        })
      }
    } else {
      const miniBox = cam.miniBox()
      cam.drawMinimapFrame(ctx, (mwx, mwy) => drawMiniContent(miniBox, mwx, mwy))
      if (pos) {
        const holeDistPx = Math.hypot(h.holeX - pos.x, tY(h.holeX) - pos.y)
        ctx.fillStyle = '#888'; ctx.font = '12px monospace'
        ctx.fillText(`hole: ${formatDistance(holeDistPx)}`, miniBox.x + 2, miniBox.y + miniBox.h + 18)
      }
      // Swing HUD (club/spin selectors + Hit! meter), drawn last, screen space.
      // Spectators have no ball to swing, so skip it.
      if (!isSpectator()) swing.drawHud(ctx, cam.cw, cam.ch, chrome.insets)
    }
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
    swing.freeLook = cam.mode === 'free'
    swing.windVel = windMph * WIND_MPH_SCALE
    // Keep the cup/ball anchors current so putter selection auto-aims (item 2),
    // and re-aim the putter each time the ball settles (a putt past the cup flips
    // its aim back toward the hole for the next stroke).
    if (hole) swing.holeX = hole.holeX
    if (bpos) swing.ballX = bpos.x
    swing.setReady(canPreviewShot())
    swing.update(now)
    // Accuracy ball ran to the far-left end untouched -> auto-fire a 0% duff.
    if (canShoot()) {
      const auto = swing.takeAutoFire()
      if (auto) launchFromResult(auto)
    }

    if (state) {
      for (const b of state.balls) {
        const rp = render.get(b.playerId)
        if (!rp) render.set(b.playerId, { x: b.x, y: b.y })
        else { rp.x += (b.x - rp.x) * BALL_LERP; rp.y += (b.y - rp.y) * BALL_LERP }
      }
    }

    if (predActive) {
      // Mirror the server's airborne physics (gravity + wind drag + spin Magnus)
      // so the local prediction tracks the authoritative ball.
      ;({ vx: predVX, vy: predVY } = airStep(predVX, predVY, dt, windMph * WIND_MPH_SCALE, predSpin, NO_SPIN_BACKSPIN_FRAC))
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
        cam.update({ x: (hole.tees[0] + hole.holeX) / 2, y: tY((hole.tees[0] + hole.holeX) / 2) })
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
      chrome.setWind(windMph)
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

  function screenPos(ev: MouseEvent | PointerEvent) {
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
    if (e.key === '1') { swing.setClub('driver'); return }
    if (e.key === '2') { swing.setClub('wedge'); return }
    if (e.key === '3') { swing.setClub('putter'); return }
    if (e.key === '4') { swing.setSpin('back'); return }
    if (e.key === '5') { swing.setSpin('none'); return }
    if (e.key === '6') { swing.setSpin('top'); return }
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
        onHit: () => fireHit(),
        onClub: (c) => { swing.setClub(c as typeof swing.club) },
        onSpin: (s) => { swing.setSpin(s as typeof swing.spin) },
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

      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        if (!e.isPrimary) return // second touch drives pinch-zoom (mountGameChrome)
        const p = screenPos(e)
        // Portrait: minimap (strip canvas) + controls (DOM) live outside this
        // canvas, so skip their on-canvas hit-tests — a press here is aim or pan.
        if (!chrome.portrait) {
          // Minimap: enter free-look and scrub the camera by clicking/dragging on it.
          if (cam.miniHit(p.x, p.y)) {
            cam.enterFreeLook()
            chrome.sync()
            cam.miniJump(p.x, p.y)
            const onMove = (ev: PointerEvent) => { const q = screenPos(ev); cam.miniJump(q.x, q.y) }
            const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp) }
            window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
            return
          }
          // Swing HUD (club/spin selectors + Hit! button) — hit-tested before the
          // free-look/aim branches so the controls work in either camera mode.
          const hud = swing.hitTestHud(p.x, p.y, cam.cw, cam.ch, chrome.insets)
          if (hud) {
            if (hud === 'hit') {
              // In free-look the meter can't start — a Hit! click exits free-look
              // so the next click starts the swing (mirrors the mobile control).
              if (cam.mode === 'free') { cam.exitFreeLook(); chrome.sync() }
              else fireHit()
            }
            else swing.handleHudClick(hud)
            return
          }
        }

        // No setPointerCapture — on touch it makes the browser swallow the first
        // tap after a drag (re-focusing off the canvas), so a tap on a DOM button
        // right after panning needed two taps. Window listeners track the drag.
        const startPanDrag = (sx: number, sy: number) => {
          let panLastX = sx, panLastY = sy
          canvas.style.cursor = 'grabbing'
          const onMove = (ev: PointerEvent) => {
            const q = screenPos(ev)
            cam.panBy(q.x - panLastX, q.y - panLastY)
            panLastX = q.x; panLastY = q.y
          }
          const onUp = () => {
            canvas.style.cursor = cam.mode === 'free' ? 'grab' : 'crosshair'
            window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
          }
          window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
        }

        if (cam.mode === 'free') { startPanDrag(p.x, p.y); return }

        // Follow mode: a drag OUTSIDE the central aim zone scrolls the view
        // (enters free-look so the pan sticks against the auto-follow). Only a
        // press INSIDE the aim zone starts an aim.
        if (canShoot() && !swing.inAimZone(p.x, p.y, cam.cw, cam.ch)) {
          cam.enterFreeLook(); chrome.sync()
          startPanDrag(p.x, p.y)
          return
        }

        // Aim-drag (slingshot, dead-zone cancel) — same model as single-player.
        // The aim is set from the drag's start->current point. Firing is via the
        // Hit! meter, not release, so onUp just finalizes the angle.
        if (!canShoot()) return
        // (No setPointerCapture — see startPanDrag note; window listeners track it.)
        // On mobile (portrait): anchor the aim origin to the pre-drawn aim circle's
        // center so the slingshot + dead-zone circle stay centered on it. Desktop
        // keeps the click-anywhere press-point origin.
        const az = swing.aimZone(cam.cw, cam.ch)
        const startSx = chrome.portrait ? az.x : p.x
        const startSy = chrome.portrait ? az.y : p.y
        const preDragAngle = swing.aimAngle
        aiming = true; aimStartSx = startSx; aimStartSy = startSy; aimCurSx = startSx; aimCurSy = startSy
        const applyAim = (mx: number, my: number) => {
          aimCurSx = mx; aimCurSy = my
          aimEngaged = Math.hypot(mx - startSx, my - startSy) > AIM_DEADZONE_R
          if (aimEngaged) swing.setAimFromScreen(startSx, startSy, mx, my)
          else swing.aimAngle = preDragAngle
        }
        applyAim(startSx, startSy)
        const onMove = (ev: PointerEvent) => { const q = screenPos(ev); applyAim(q.x, q.y) }
        const onUp = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
          aiming = false
          const q = screenPos(ev); applyAim(q.x, q.y)
        }
        window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp)
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
      hole = normalizeTees(m.hole)
      windMph = m.wind ?? 0
      render.clear()
      rebuildCaches()
      myWasMoving = false; cam.endShot()
      cam.setWorld(hole.worldW, hole.worldH)
      cam.centerOn(hole.tees[0], tY(hole.tees[0]))
      // Each hole starts with the driver, no spin, aimed 45° toward the hole.
      swing.resetForHole(hole.holeX, hole.tees[0])
    },
    setState(m) {
      state = m
      windMph = m.wind ?? windMph
      stateAt = performance.now()
      if (m.phase === 'playing') { clockBaseMs = m.holeMs; clockAt = stateAt }
      else predActive = false
      if (m.phase === 'playing' || m.phase === 'countdown') boardEl.style.display = 'none'
    },
    setLeaderboard(m) {
      const title = m.final ? 'Final Results' : `Hole ${m.holeIndex + 1} of ${m.holeCount}`
      // Victory = metric (speed|strokes) x scope (total|match). Match scope ranks
      // by rank points; total scope ranks by the raw aggregate. See match.go.
      const strokes = m.victory === 'strokes-total' || m.victory === 'strokes-match'
      const isMatch = m.victory === 'speed-match' || m.victory === 'strokes-match'
      const totalLabel = isMatch ? 'Points' : strokes ? 'Shots' : 'Total'
      const totalCell = (e: typeof m.entries[number]) =>
        isMatch ? `${e.matchPts} pts` : strokes ? `${e.totalShots}` : `${(e.totalMs / 1000).toFixed(1)}s`
      const holeCellOf = (e: typeof m.entries[number]) =>
        e.dnf ? 'DNF' : strokes ? `${e.holeShots}` : `${(e.holeMs / 1000).toFixed(1)}s`
      // Sort: primary by scope metric, tiebreak by the raw aggregate (lower time / fewer shots).
      const sortKey = isMatch
        ? (a: typeof m.entries[number], b: typeof m.entries[number]) => b.matchPts - a.matchPts || (strokes ? a.totalShots - b.totalShots : a.totalMs - b.totalMs)
        : strokes
          ? (a: typeof m.entries[number], b: typeof m.entries[number]) => a.totalShots - b.totalShots || a.totalMs - b.totalMs
          : (a: typeof m.entries[number], b: typeof m.entries[number]) => a.totalMs - b.totalMs
      const rows = m.entries
        .slice()
        .sort(sortKey)
        .map((e, i) => {
          return `<div class="mb-row">
            <span class="mb-rank">${i + 1}</span>
            <span class="mb-dot" style="background:${colorHex(e.color)}"></span>
            <span class="mb-name">${escapeHtml(e.name)}</span>
            <span class="mb-hole">${holeCellOf(e)}</span>
            <span class="mb-total">${totalCell(e)}</span>
          </div>`
        })
        .join('')
      boardEl.innerHTML = `
        <div class="mb-card">
          <h2 class="mb-title">${title}</h2>
          <div class="mb-head"><span class="mb-rank"></span><span class="mb-dot"></span><span class="mb-name"></span><span class="mb-hole">This hole</span><span class="mb-total">${totalLabel}</span></div>
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
