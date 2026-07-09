// GameCamera — shared camera + outer-chrome module for both single-player
// (main.ts) and multiplayer (screens/matchScreen.ts). Renderer-agnostic (no
// DOM, no network) — same pattern as SwingEngine in swing.ts. Owns camera
// state/math and minimap-frame drawing; per-screen content (terrain, balls,
// parabola, etc.) is drawn by the caller via the drawContent callback.
//
// mountGameChrome() builds the actual DOM (wrap/canvas/hud/free-look-arrows/
// hamburger menu) both screens share, so the two GUIs can't drift apart again.

import { meterTickFracs } from './swing'

export type CamMode = 'follow' | 'free'

export interface GameCameraConfig {
  minZoom?: number
  maxZoom?: number
  followLerp?: number
  followBiasY?: number // fraction of viewport height the follow target sits down from the top
  panStep?: number      // screen px/frame per held arrow key, in free-look
  zoomLerp?: number      // per-frame lerp toward the target follow zoom (shot auto-zoom)
  framePad?: number      // fraction of extra margin around a framed region (ball+hole, or shot arc)
  holeFrameFrac?: number // frame ball+hole together when the hole is within this fraction of a viewport width
}

// followTarget can carry a secondary world point (the hole) to keep in frame,
// and whether the ball is currently moving (drives the shot auto-zoom).
export interface FollowTarget {
  x: number
  y: number
  secondary?: { x: number; y: number } | null
  ballMoving?: boolean
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)) }

export class GameCamera {
  cw = 0
  ch = 0
  camX = 0
  camY = 0
  zoom = 1
  mode: CamMode = 'follow'
  // Resting/idle zoom ceiling. 1 = fill the viewport at rest (desktop). Portrait
  // mobile sets this below 1 to sit more zoomed OUT (see more of the hole) since
  // the square shows less horizontally. Also scales the shot auto-zoom's wide end.
  baseZoom = 1

  private worldW = 1
  private worldH = 1
  private held = new Set<string>()
  private cfg: Required<GameCameraConfig>

  // Shot auto-zoom state (follow mode). On launch we predict the shot's flight
  // duration + how wide a zoom fits the whole arc, then drive zoom by an eased
  // progress p (0..1) over that duration: out fast-then-slow to the wide zoom by
  // mid-flight, then in slow-then-fast back toward 1 on the descent — instead of
  // chasing the ball's growing distance (which lags). shotActive is true from
  // launch until the ball rests (endShot).
  private shotActive = false
  private shotStartMs = 0
  private shotDurMs = 0
  private shotWideZoom = 1

  // Free-look zoom target: on entering free-look we ease toward this (half the
  // current zoom = 2× the visible course) over a few frames rather than snapping,
  // mirroring the quick-but-not-instant zoom-back on exit. Only meaningful while
  // mode === 'free'; update() lerps zoom toward it there.
  private freeTargetZoom = 1

  constructor(cfg: GameCameraConfig = {}) {
    this.cfg = {
      minZoom: cfg.minZoom ?? 0.35,
      maxZoom: cfg.maxZoom ?? 2.5,
      followLerp: cfg.followLerp ?? 0.2,
      followBiasY: cfg.followBiasY ?? 0.6,
      panStep: cfg.panStep ?? 14,
      zoomLerp: cfg.zoomLerp ?? 0.08,
      framePad: cfg.framePad ?? 0.22,
      holeFrameFrac: cfg.holeFrameFrac ?? 0.95,
    }
  }

  setWorld(worldW: number, worldH: number) {
    this.worldW = worldW; this.worldH = worldH
    this.clampCam()
  }

  resize(cw: number, ch: number) {
    this.cw = cw; this.ch = ch
    this.clampCam()
  }

  worldToScreen(wx: number, wy: number) { return { sx: (wx - this.camX) * this.zoom, sy: (wy - this.camY) * this.zoom } }
  screenToWorld(sx: number, sy: number) { return { wx: this.camX + sx / this.zoom, wy: this.camY + sy / this.zoom } }

  clampCam() {
    const visW = this.cw / this.zoom, visH = this.ch / this.zoom
    this.camX = this.worldW <= visW ? (this.worldW - visW) / 2 : clamp(this.camX, 0, this.worldW - visW)
    this.camY = this.worldH <= visH ? (this.worldH - visH) / 2 : clamp(this.camY, 0, this.worldH - visH)
  }

  enterFreeLook() {
    if (this.mode === 'free') return
    this.mode = 'free'
    // Zoom out so free-look surveys 1.5× as much course AREA as follow mode.
    // Visible area scales with 1/zoom², so 1.5× area = zoom × 1/√1.5 ≈ 0.816.
    // Eased in quickly over a few frames (see update's free-look branch) rather
    // than snapping. Respects the min-zoom floor.
    this.freeTargetZoom = clamp(this.zoom / Math.sqrt(1.5), this.cfg.minZoom, this.cfg.maxZoom)
  }
  exitFreeLook() {
    if (this.mode === 'follow') return
    this.mode = 'follow'
    this.zoom = this.baseZoom // revert to the ball at the resting zoom
    this.held.clear()
  }
  toggleFreeLook() { this.mode === 'free' ? this.exitFreeLook() : this.enterFreeLook() }

  zoomAt(screenX: number, screenY: number, factor: number) {
    this.setZoomAnchored(this.zoom * factor, screenX, screenY)
  }

  /** Sets an absolute zoom (clamped) while keeping the world point under the
   * given screen coordinate fixed. Shared by pinch/scroll zoom and the eased
   * free-look zoom-out. */
  setZoomAnchored(zoom: number, screenX: number, screenY: number) {
    const { wx, wy } = this.screenToWorld(screenX, screenY)
    this.zoom = clamp(zoom, this.cfg.minZoom, this.cfg.maxZoom)
    this.camX = wx - screenX / this.zoom
    this.camY = wy - screenY / this.zoom
    this.clampCam()
  }

  /**
   * Marks a shot launched with velocity (vx,vy) under `gravity`. Predicts the
   * flight duration and how far the arc travels, then follow mode drives an eased
   * zoom-out→zoom-in over that duration (see update()). Falls back gracefully for
   * a putt/near-zero shot (no meaningful zoom-out).
   */
  startShot(vx: number, vy: number, gravity: number) {
    // Ballistic flight time back to (roughly) launch height: t = -2*vy/g for an
    // up-shot; for a level/down shot use a short floor so the profile still runs.
    const tUp = vy < 0 ? (-2 * vy) / gravity : 0
    const dur = Math.max(0.35, tUp) * 1000
    // Predicted horizontal range + peak rise, to size how wide to zoom.
    const range = Math.abs(vx) * (dur / 1000)
    const rise = vy < 0 ? (vy * vy) / (2 * gravity) : 0
    const spanX = Math.max(1, range)
    const spanY = Math.max(1, rise)
    const pad = 1 + this.cfg.framePad * 2
    const fit = Math.min(this.cw / (spanX * pad), this.ch / (spanY * pad))
    const fullWide = clamp(Math.min(1, fit), this.cfg.minZoom, 1)
    // Subtle zoom-out: pull the wide target halfway back toward 1, so the swing
    // is about half as deep as a full arc-fit.
    this.shotWideZoom = 1 + (fullWide - 1) * 0.5
    this.shotStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    this.shotDurMs = dur
    this.shotActive = true
  }
  /** Ends the shot auto-zoom (ball has settled) — the camera eases back toward zoom 1. */
  endShot() { this.shotActive = false }

  // Eased shot "openness" 0..1 (0 = zoom 1, 1 = fully zoomed out) as a function
  // of flight progress p. Rising half [0,0.5]: ease-OUT (zoom out FAST then
  // slow). Falling half [0.5,1]: starts slow then FAST (zoom in slow then quick).
  private shotOpenness(p: number): number {
    if (p <= 0.5) { const u = p / 0.5; return 1 - (1 - u) * (1 - u) }
    const u = (p - 0.5) / 0.5; return 1 - u * u
  }

  /**
   * Call once per frame. followTarget is the world point to track in follow mode
   * (null if there's nothing to follow yet). It may carry a `secondary` point
   * (the hole) to keep in frame when it's close, and `ballMoving` to drive the
   * post-shot auto-zoom.
   */
  update(followTarget: FollowTarget | null) {
    if (this.mode === 'follow') {
      if (!followTarget) return

      // Region to frame (world space): the ball, plus the hole when it's close.
      let minX = followTarget.x, maxX = followTarget.x
      let minY = followTarget.y, maxY = followTarget.y

      if (this.shotActive && followTarget.ballMoving) {
        // ---- Shot auto-zoom: driven by eased flight PROGRESS (predicted at
        // launch), not the ball's growing distance, so it commits to zooming out
        // immediately. Zoom is set directly here (not via region-fit / lerp).
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
        const p = clamp((now - this.shotStartMs) / this.shotDurMs, 0, 1)
        const o = this.shotOpenness(p)
        // Interpolate between the resting baseZoom and the wide shot zoom.
        this.zoom = this.baseZoom + (this.shotWideZoom * this.baseZoom - this.baseZoom) * o
        // Follow the ball, but ease the focus toward mid-flight so the incoming
        // ground ahead is visible while zoomed out.
        const visW = this.cw / this.zoom, visH = this.ch / this.zoom
        let tx = followTarget.x - visW / 2
        let ty = followTarget.y - visH * this.cfg.followBiasY
        tx = this.worldW <= visW ? (this.worldW - visW) / 2 : clamp(tx, 0, this.worldW - visW)
        ty = this.worldH <= visH ? (this.worldH - visH) / 2 : clamp(ty, 0, this.worldH - visH)
        this.camX += (tx - this.camX) * this.cfg.followLerp
        this.camY += (ty - this.camY) * this.cfg.followLerp
        return
      }

      // ---- Idle / hole framing: fit the ball (+ hole when close) at up to zoom
      // 1, preferring a pure PAN; ease zoom back toward the fit each frame.
      let pad = 1
      if (followTarget.secondary) {
        const baseVisW = this.cw // zoom 1
        if (Math.abs(followTarget.secondary.x - followTarget.x) <= baseVisW * this.cfg.holeFrameFrac) {
          minX = Math.min(minX, followTarget.secondary.x); maxX = Math.max(maxX, followTarget.secondary.x)
          minY = Math.min(minY, followTarget.secondary.y); maxY = Math.max(maxY, followTarget.secondary.y)
          pad = 1.06 // slight breathing room; stays zoom 1 unless they overflow
        }
      }
      const regionW = Math.max(1, (maxX - minX) * pad)
      const regionH = Math.max(1, (maxY - minY) * pad)
      const fitZoom = Math.min(this.cw / regionW, this.ch / regionH)
      // baseZoom is the resting ceiling (≤1); portrait sits more zoomed out.
      const targetZoom = clamp(Math.min(this.baseZoom, fitZoom), this.cfg.minZoom, this.baseZoom)
      this.zoom += (targetZoom - this.zoom) * this.cfg.zoomLerp

      const visW = this.cw / this.zoom, visH = this.ch / this.zoom
      const cxWorld = (minX + maxX) / 2
      const cyWorld = (minY + maxY) / 2
      const focusY = (cyWorld + followTarget.y) / 2
      let tx = cxWorld - visW / 2
      let ty = focusY - visH * this.cfg.followBiasY
      tx = this.worldW <= visW ? (this.worldW - visW) / 2 : clamp(tx, 0, this.worldW - visW)
      ty = this.worldH <= visH ? (this.worldH - visH) / 2 : clamp(ty, 0, this.worldH - visH)
      this.camX += (tx - this.camX) * this.cfg.followLerp
      this.camY += (ty - this.camY) * this.cfg.followLerp
    } else {
      // Ease toward the free-look zoom target (set on entry), anchored on the
      // view center so the course stays put as it opens up — quick, not instant,
      // matching the zoom-back on exit. Snap the last sliver to settle cleanly.
      // Faster than the follow zoom-lerp so free-look opens up snappily.
      if (Math.abs(this.zoom - this.freeTargetZoom) > 1e-3) {
        const next = this.zoom + (this.freeTargetZoom - this.zoom) * 0.25
        this.setZoomAnchored(next, this.cw / 2, this.ch / 2)
      }
      const step = this.cfg.panStep / this.zoom
      if (this.held.has('ArrowLeft')) this.camX -= step
      if (this.held.has('ArrowRight')) this.camX += step
      if (this.held.has('ArrowUp')) this.camY -= step
      if (this.held.has('ArrowDown')) this.camY += step
      this.clampCam()
    }
  }

  /** Hard snap (no lerp) — hole load, water-penalty relocate, hole reset. */
  centerOn(wx: number, wy: number) {
    const visW = this.cw / this.zoom, visH = this.ch / this.zoom
    this.camX = this.worldW <= visW ? (this.worldW - visW) / 2 : clamp(wx - visW / 2, 0, this.worldW - visW)
    this.camY = this.worldH <= visH ? (this.worldH - visH) / 2 : clamp(wy - visH * this.cfg.followBiasY, 0, this.worldH - visH)
  }

  /** Edge-arrow-button panning, free-look only. */
  nudge(dir: 'up' | 'down' | 'left' | 'right') {
    const s = 90 / this.zoom
    if (dir === 'up') this.camY -= s
    else if (dir === 'down') this.camY += s
    else if (dir === 'left') this.camX -= s
    else this.camX += s
    this.clampCam()
  }

  /** Left-drag panning in free-look — dx/dy are screen-space deltas. */
  panBy(dxScreen: number, dyScreen: number) {
    this.camX -= dxScreen / this.zoom
    this.camY -= dyScreen / this.zoom
    this.clampCam()
  }

  /**
   * Enter/M toggles free-look both ways. Arrows enter free-look and start
   * panning. Space only ever exits free-look (back to Hit/follow mode) — it
   * does NOT enter free-look, so when already in follow mode this returns
   * false, leaving Space free for the caller to use as its own shortcut
   * (e.g. the Hit! button). Returns true if the key was consumed.
   */
  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Enter' || e.key === 'm' || e.key === 'M') { this.toggleFreeLook(); return true }
    if (e.key === ' ') {
      if (this.mode === 'free') { this.exitFreeLook(); return true }
      return false
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (this.mode === 'follow') this.enterFreeLook()
      this.held.add(e.key)
      return true
    }
    return false
  }
  onKeyUp(e: KeyboardEvent) { this.held.delete(e.key) }

  // ---- Minimap (top-right corner of the game canvas — desktop/overlay mode) ----
  miniBox(w = 200, h = 52, pad = 12) { return { x: this.cw - w - pad, y: pad, w, h } }

  miniHit(px: number, py: number): boolean {
    const b = this.miniBox()
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h
  }

  miniJump(px: number, py: number) { this.miniJumpInBox(px, py, this.miniBox()) }

  /** Draws the shared minimap frame into the game canvas's top-right corner. */
  drawMinimapFrame(ctx: CanvasRenderingContext2D, drawContent: (mwx: (wx: number) => number, mwy: (wy: number) => number) => void) {
    this.drawMinimapInBox(ctx, this.miniBox(), drawContent)
  }

  // ---- Generalized minimap (any box) — reused by the portrait strip canvas ----
  /** Scrubs the camera so a tap at strip/box-local (px,py) recenters on that world point. */
  miniJumpInBox(px: number, py: number, box: { x: number; y: number; w: number; h: number }) {
    const wx = ((px - box.x) / box.w) * this.worldW
    const wy = ((py - box.y) / box.h) * this.worldH
    this.camX = wx - this.cw / this.zoom / 2
    this.camY = wy - this.ch / this.zoom / 2
    this.clampCam()
  }

  /** Draws the minimap frame (bg/border/camera-rect) into an arbitrary box of the
   * given ctx; drawContent renders per-screen content via the mwx/mwy mappers. */
  drawMinimapInBox(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }, drawContent: (mwx: (wx: number) => number, mwy: (wy: number) => number) => void) {
    ctx.fillStyle = 'rgba(8,14,20,0.72)'; ctx.fillRect(b.x, b.y, b.w, b.h)

    const mwx = (wx: number) => b.x + (wx / this.worldW) * b.w
    const mwy = (wy: number) => b.y + (wy / this.worldH) * b.h
    drawContent(mwx, mwy)

    const visW = this.cw / this.zoom, visH = this.ch / this.zoom
    ctx.strokeStyle = 'rgba(246,239,206,0.75)'; ctx.lineWidth = 1
    ctx.strokeRect(mwx(this.camX), mwy(this.camY), (visW / this.worldW) * b.w, (visH / this.worldH) * b.h)

    // Black outline drawn LAST so the sky/terrain fill (which clips to the box)
    // doesn't paint over it. Inset half a line width so it's fully inside the box.
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2
    ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2)
  }
}

export interface ChromeMenuItem { label: string; onClick: () => void; style?: string }

/** Safe-area insets (CSS px) — how much of each edge is covered by system UI
 * (notch, home-indicator/gesture bar, rounded corners). Read from a CSS probe. */
export interface SafeInsets { top: number; right: number; bottom: number; left: number }

/** Live state the DOM control bar reflects (portrait mobile). Selected club/spin
 * highlight, the power-meter fill, and the bunker-penalty readout. */
export interface ControlsState {
  club: string
  spin: string
  swinging: boolean
  bunkerPct: number | null
  // Meter geometry as fractions (0-1) of the full extended track (underhang +
  // main), from swing.meterGeom(): ball position, the 0 origin, and the green
  // band edges. Lets the DOM place everything without knowing the constants.
  ballFrac: number
  greenLeftFrac: number
  greenRightFrac: number
  // Ghost "hit" ball parked where power was captured; null before the 2nd press.
  powerMarkerFrac: number | null
  powerPct: number | null        // captured power %, null before the 2nd press
  accuracyPct: number | null     // captured accuracy %, null before the 3rd press
}

export interface GameChromeHandle {
  root: HTMLElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  /** Current safe-area insets in CSS px; refreshed on resize. Mutated in place,
   * so callers can hold the reference and read the live values each frame. */
  insets: SafeInsets
  /** True when the portrait-mobile layout (square canvas + DOM controls) is
   * active — screens use it to skip the on-canvas HUD and render the strip minimap. */
  portrait: boolean
  /** Portrait only: the minimap strip's own 2D context (null in overlay mode). */
  miniCtx: CanvasRenderingContext2D | null
  /** Portrait only: the strip minimap box in strip-canvas CSS px (full strip). */
  miniStripBox(): { x: number; y: number; w: number; h: number }
  /** Sets the top-left hole/timer HUD text; null hides the pill entirely. */
  setHud(text: string | null): void
  /** Sets the wind indicator (desktop: in the HUD pill; mobile: bottom-left). mph +right/-left. */
  setWind(mph: number): void
  /** Portrait only: push live control state into the DOM control bar. No-op in overlay mode. */
  setControls(s: ControlsState | null): void
  /**
   * Reflects cam.mode into the arrows/cursor DOM. Call after any of *your own*
   * input handling that might have changed cam.mode (minimap click, keydown) —
   * not every frame, since that would fight the transient 'grabbing' cursor a
   * caller sets during an active pan-drag. mountGameChrome's own
   * contextmenu/wheel handlers already call this internally.
   */
  sync(): void
  /** Closes the hamburger menu panel if open — call on screen exit. */
  closeMenu(): void
  /** Opens/closes the hamburger menu panel — e.g. for an Escape-key shortcut. */
  toggleMenu(): void
  /** Recomputes canvas size + camera dims. Call when the screen becomes visible
   *  again (the resize observers skip while it's hidden). */
  resize(): void
}

// True when we should use the portrait-mobile layout (square canvas in a
// scrolling page + DOM controls) rather than the desktop full-viewport overlay.
function isPortraitMobile(): boolean {
  if (typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(orientation: portrait)').matches
}

// Builds the wrap/canvas/hud/free-look-arrows/hamburger-menu DOM shared by
// both screens (see gameChrome.css), and wires it to a GameCamera instance.
//
// Two layouts share this one function and the same GameCamera/SwingEngine:
//  - Desktop / landscape-desktop: canvas fills the viewport, HUD + minimap are
//    drawn ON the canvas, chrome (pill/arrows/menu) is absolutely overlaid.
//  - Portrait mobile: a square game canvas sits in a NORMALLY SCROLLING page,
//    with a minimap strip canvas above it and real DOM control buttons below.
//    (squigglegolf pattern — stops fighting the mobile address bar.)
export function mountGameChrome(host: HTMLElement, cam: GameCamera, opts: {
  menuItems: ChromeMenuItem[]
  minW?: number
  minH?: number
  /** Portrait controls fire these; the screen owns launch/prediction wiring. */
  onHit?: () => void
  onClub?: (club: string) => void
  onSpin?: (spin: string) => void
}): GameChromeHandle {
  const minW = opts.minW ?? 900, minH = opts.minH ?? 560

  const root = document.createElement('div')
  root.className = 'gc-wrap'
  root.innerHTML = `
    <div class="gc-rotate" data-rotate>Please rotate your phone to portrait to play ⛳</div>
    <div class="gc-mini-strip" data-mini-strip><canvas data-mini-canvas></canvas></div>
    <div class="gc-square" data-square>
      <canvas class="gc-canvas"></canvas>
      <div class="gc-hud" data-hud><span data-hud-left></span><span class="gc-hud-wind" data-hud-wind></span><span data-hud-right></span></div>
      <div class="gc-wind-mobile" data-wind-mobile></div>
      <div class="free-arrows" data-arrows style="display:none">
        <div class="free-hint"><span class="fh-desktop">Free look — Enter, M, Space, or right-click to exit</span><span class="fh-mobile">Free look mode<br>(Please tap the 🔍 to exit)</span></div>
        <button class="free-arrow fa-up" data-pan="up">▲</button>
        <button class="free-arrow fa-down" data-pan="down">▼</button>
        <button class="free-arrow fa-left" data-pan="left">◀</button>
        <button class="free-arrow fa-right" data-pan="right">▶</button>
      </div>
      <div class="gc-menu">
        <button class="gc-look-toggle" data-look-toggle aria-label="Free look">🔍</button>
        <button class="gc-menu-toggle" data-menu-toggle aria-label="Menu">☰</button>
        <div class="gc-menu-panel" data-menu-panel style="display:none"></div>
      </div>
    </div>
    <div class="gc-controls" data-controls>
      <div class="gc-ctl-row">
        <div class="gc-ctl-group" data-club-group>
          <button class="gc-ctl-btn" data-club="driver">D</button>
          <button class="gc-ctl-btn" data-club="wedge">PW</button>
          <button class="gc-ctl-btn" data-club="putter">P</button>
        </div>
        <div class="gc-ctl-bunker" data-bunker></div>
        <div class="gc-ctl-group" data-spin-group>
          <button class="gc-ctl-btn" data-spin="back">BS</button>
          <button class="gc-ctl-btn" data-spin="none">NS</button>
          <button class="gc-ctl-btn" data-spin="top">TS</button>
        </div>
      </div>
      <div class="gc-ctl-row">
        <button class="gc-ctl-hit" data-hit>Hit!</button>
        <div class="gc-ctl-meter" data-meter>
          <div class="gc-ctl-meter-green" data-meter-green></div>
          <div class="gc-ctl-meter-marker" data-meter-marker></div>
          <div class="gc-ctl-meter-ball" data-meter-ball></div>
          <div class="gc-ctl-meter-acc" data-meter-acc></div>
          <div class="gc-ctl-meter-pow" data-meter-pow></div>
        </div>
      </div>
    </div>
    <div class="gc-safe-probe" data-safe></div>`
  host.appendChild(root)

  const squareEl = root.querySelector<HTMLElement>('[data-square]')!
  const canvas = squareEl.querySelector('canvas')!
  const ctx = canvas.getContext('2d')!
  const miniCanvas = root.querySelector<HTMLCanvasElement>('[data-mini-canvas]')!
  const miniCtx = miniCanvas.getContext('2d')
  const controlsEl = root.querySelector<HTMLElement>('[data-controls]')!
  const bunkerEl = root.querySelector<HTMLElement>('[data-bunker]')!
  const meterBallEl = root.querySelector<HTMLElement>('[data-meter-ball]')!
  const meterGreenEl = root.querySelector<HTMLElement>('[data-meter-green]')!
  const meterMarkerEl = root.querySelector<HTMLElement>('[data-meter-marker]')!
  const meterAccEl = root.querySelector<HTMLElement>('[data-meter-acc]')!
  const meterPowEl = root.querySelector<HTMLElement>('[data-meter-pow]')!
  const meterEl = root.querySelector<HTMLElement>('[data-meter]')!
  // Tick marks (built once — positions are constant). Long ticks at the 0
  // origin and 50/100 power; minor ticks every 10% between. Mirrors the desktop
  // canvas HUD meter so the two layouts match.
  for (const t of meterTickFracs()) {
    const tick = document.createElement('div')
    tick.className = t.long ? 'gc-ctl-meter-tick long' : 'gc-ctl-meter-tick'
    tick.style.left = `${t.frac * 100}%`
    meterEl.appendChild(tick)
  }
  const hitBtnEl = root.querySelector<HTMLButtonElement>('[data-hit]')!
  const hudEl = root.querySelector<HTMLElement>('[data-hud]')!
  const hudLeftEl = root.querySelector<HTMLElement>('[data-hud-left]')!
  const hudRightEl = root.querySelector<HTMLElement>('[data-hud-right]')!
  const hudWindEl = root.querySelector<HTMLElement>('[data-hud-wind]')!
  const windMobileEl = root.querySelector<HTMLElement>('[data-wind-mobile]')!
  const arrowsEl = root.querySelector<HTMLElement>('[data-arrows]')!
  const menuToggleEl = root.querySelector<HTMLButtonElement>('[data-menu-toggle]')!
  const menuPanelEl = root.querySelector<HTMLElement>('[data-menu-panel]')!
  const lookToggleEl = root.querySelector<HTMLButtonElement>('[data-look-toggle]')!
  const safeEl = root.querySelector<HTMLElement>('[data-safe]')!

  // ---- DOM control buttons (portrait) → drive SwingEngine via the screen's opts ----
  // Fire on POINTERUP, not click. On iOS Safari the first `click` on a DOM button
  // right after a canvas touch-drag is suppressed (the gesture state from the
  // touch-action:none canvas hasn't cleared) — so a tap after panning needed two
  // taps. pointerup isn't subject to that click-suppression. We require the
  // pointerdown to have landed on the SAME button (tapStart) so a stray drag that
  // merely ends over a button doesn't trigger it.
  const onTap = (btn: HTMLElement, fn: () => void) => {
    let armed = false
    btn.addEventListener('pointerdown', (e) => { if (e.isPrimary) { armed = true } })
    btn.addEventListener('pointercancel', () => { armed = false })
    btn.addEventListener('pointerleave', () => { armed = false })
    btn.addEventListener('pointerup', (e) => {
      if (!armed) return
      armed = false
      e.preventDefault()
      fn()
    })
  }
  for (const btn of Array.from(controlsEl.querySelectorAll<HTMLButtonElement>('[data-club]'))) {
    onTap(btn, () => opts.onClub?.(btn.dataset.club!))
  }
  for (const btn of Array.from(controlsEl.querySelectorAll<HTMLButtonElement>('[data-spin]'))) {
    onTap(btn, () => opts.onSpin?.(btn.dataset.spin!))
  }
  onTap(hitBtnEl, () => {
    // In free-look the swing meter can't start (you must be aiming in follow
    // mode). Rather than a confusing no-op, tapping Hit! exits free-look so the
    // next tap starts the swing. The button is greyed while in free-look.
    if (cam.mode === 'free') { cam.exitFreeLook(); applySync(); return }
    opts.onHit?.()
  })

  // Live safe-area insets — refreshed in resize() from the probe's resolved
  // env() padding. Mutated in place so the handle's holder sees updates.
  const insets: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 }
  function readInsets() {
    const s = getComputedStyle(safeEl)
    insets.top = parseFloat(s.paddingTop) || 0
    insets.right = parseFloat(s.paddingRight) || 0
    insets.bottom = parseFloat(s.paddingBottom) || 0
    insets.left = parseFloat(s.paddingLeft) || 0
  }

  for (const item of opts.menuItems) {
    const btn = document.createElement('button')
    btn.className = 'gc-item'
    btn.textContent = item.label === 'Back to Menu' ? 'Quit Game' : item.label
    if (item.style) btn.style.cssText = item.style
    btn.addEventListener('click', () => { menuPanelEl.style.display = 'none'; item.onClick() })
    menuPanelEl.appendChild(btn)
  }

  function closeMenu() { menuPanelEl.style.display = 'none' }
  function toggleMenu() {
    menuPanelEl.style.display = menuPanelEl.style.display === 'none' ? '' : 'none'
  }
  menuToggleEl.addEventListener('click', toggleMenu)
  root.addEventListener('click', (e) => {
    if (menuPanelEl.style.display !== 'none' && e.target !== menuToggleEl && !menuPanelEl.contains(e.target as Node)) {
      closeMenu()
    }
  })
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuPanelEl.style.display !== 'none') {
      closeMenu()
    }
  })

  const nudge = (dir: string) => cam.nudge(dir as 'up' | 'down' | 'left' | 'right')
  for (const btn of Array.from(arrowsEl.querySelectorAll<HTMLButtonElement>('[data-pan]'))) {
    btn.addEventListener('click', () => nudge(btn.dataset.pan!))
  }

  function applySync() {
    arrowsEl.style.display = cam.mode === 'free' ? '' : 'none'
    canvas.style.cursor = cam.mode === 'free' ? 'grab' : 'crosshair'
    lookToggleEl.classList.toggle('active', cam.mode === 'free')
    // Grey the Hit! button in free-look — the meter can't start there (tapping it
    // just exits free-look).
    hitBtnEl.classList.toggle('disabled', cam.mode === 'free')
  }
  applySync()

  // ---- Portrait strip minimap: tap/drag to scrub the camera along the hole. ----
  // (In overlay mode the minimap lives in the game canvas and is handled by the
  // screens' own pointerdown; the strip is a separate canvas, so wire it here.)
  const stripLocal = (e: PointerEvent) => {
    const r = miniCanvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  miniCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return
    e.preventDefault()
    miniCanvas.setPointerCapture(e.pointerId)
    cam.enterFreeLook(); applySync()
    const box = { x: 0, y: 0, w: miniCanvas.clientWidth, h: miniCanvas.clientHeight }
    const scrub = (ev: PointerEvent) => { const p = stripLocal(ev); cam.miniJumpInBox(p.x, p.y, box) }
    scrub(e)
    const up = (ev: PointerEvent) => {
      try { miniCanvas.releasePointerCapture(ev.pointerId) } catch { /* already released */ }
      miniCanvas.removeEventListener('pointermove', scrub)
      miniCanvas.removeEventListener('pointerup', up)
      miniCanvas.removeEventListener('pointercancel', up)
    }
    miniCanvas.addEventListener('pointermove', scrub)
    miniCanvas.addEventListener('pointerup', up)
    miniCanvas.addEventListener('pointercancel', up)
  })

  // Free-look toggle button — touch equivalent of right-click (which has no touch
  // gesture). Always visible; harmless on desktop.
  lookToggleEl.addEventListener('click', () => { cam.toggleFreeLook(); applySync() })

  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); cam.toggleFreeLook(); applySync() })
  canvas.addEventListener('wheel', (e) => {
    if (cam.mode !== 'free') return
    e.preventDefault()
    const r = canvas.getBoundingClientRect()
    cam.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1)
  }, { passive: false })

  // ---- Pinch-to-zoom (touch equivalent of the wheel) ----
  // Track active touch pointers; when exactly two are down, zoom about their
  // centroid by the change in finger distance. Free-look only (mirrors wheel),
  // so an aim in follow mode is never disturbed. A two-finger gesture is distinct
  // from the one-finger aim/pan/tap the screens handle, so they don't conflict.
  const touches = new Map<number, { x: number; y: number }>()
  let pinchPrevDist = 0
  const touchPt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return
    touches.set(e.pointerId, touchPt(e))
    if (touches.size === 2) {
      const [a, b] = [...touches.values()]
      pinchPrevDist = Math.hypot(a.x - b.x, a.y - b.y)
    }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return
    touches.set(e.pointerId, touchPt(e))
    if (touches.size === 2 && cam.mode === 'free') {
      const [a, b] = [...touches.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchPrevDist > 0 && dist > 0) {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
        cam.zoomAt(cx, cy, dist / pinchPrevDist)
      }
      pinchPrevDist = dist
    }
  })
  const endTouch = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    touches.delete(e.pointerId)
    if (touches.size < 2) pinchPrevDist = 0
  }
  canvas.addEventListener('pointerup', endTouch)
  canvas.addEventListener('pointercancel', endTouch)

  // Live layout flag — updated each resize (portrait can toggle on rotation).
  let portrait = isPortraitMobile()

  const dprOf = () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1

  // Sizes the minimap strip canvas to its CSS box (portrait only).
  function resizeStrip() {
    if (!miniCtx) return
    const w = miniCanvas.clientWidth, h = miniCanvas.clientHeight
    if (w === 0 || h === 0) return
    const dpr = dprOf()
    miniCanvas.width = Math.round(w * dpr); miniCanvas.height = Math.round(h * dpr)
    miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function resize() {
    // Skip while the screen is hidden (display:none — e.g. the Ken menu is open):
    // a hidden element measures 0×0, and resizing to that zero/minW fallback would
    // leave the camera zoomed wrong until the next real resize. A resize() is
    // re-fired when the game screen re-enters (see the returned handle), so we lose
    // nothing by ignoring the hidden state here. host is the always-in-flow parent,
    // so its 0×0 reliably means "an ancestor is display:none".
    if (host.clientWidth === 0 && host.clientHeight === 0) return

    portrait = isPortraitMobile()
    root.classList.toggle('gc-portrait', portrait)
    // Portrait sits ~50% more zoomed out (baseZoom 0.66) so the small square
    // still shows a useful stretch of the hole; desktop fills at zoom 1.
    cam.baseZoom = portrait ? 0.66 : 1

    let cw: number, ch: number
    if (portrait) {
      // Square canvas laid out in normal page flow (the .gc-square element is
      // width:100%; aspect-ratio:1/1 via CSS). We DON'T pin to the visual
      // viewport or fill dvh — the page scrolls normally, so the mobile address
      // bar collapses on scroll like any web page. Size the canvas to the
      // square element's rendered box.
      root.style.position = ''; root.style.left = ''; root.style.top = ''
      const side = Math.round(squareEl.clientWidth) || Math.round(host.clientWidth) || 320
      cw = ch = side
      resizeStrip()
    } else {
      // Desktop / landscape-desktop: canvas fills the viewport (visual viewport
      // on touch, host size floored at minW/minH on mouse). Unchanged behavior.
      const vv = window.visualViewport
      const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
      const small = coarse || Math.min(window.innerWidth, window.innerHeight) < minH
      if (small && vv) {
        cw = Math.round(vv.width); ch = Math.round(vv.height)
        root.style.position = 'fixed'
        root.style.left = vv.offsetLeft + 'px'
        root.style.top = vv.offsetTop + 'px'
      } else {
        const hostW = host.clientWidth || minW
        const hostH = host.clientHeight || minH
        cw = small ? hostW : Math.max(minW, hostW)
        ch = small ? hostH : Math.max(minH, hostH)
        root.style.position = ''; root.style.left = ''; root.style.top = ''
      }
    }
    // Backing store at devicePixelRatio for crisp rendering on retina/mobile; the
    // ctx is scaled so all draw code keeps working in CSS px (== cam.cw/cam.ch).
    const dpr = dprOf()
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr)
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px'
    if (!portrait) { root.style.width = cw + 'px'; root.style.height = ch + 'px' }
    else { root.style.width = ''; root.style.height = '' }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cam.resize(cw, ch)
    readInsets()
  }
  resize()
  new ResizeObserver(resize).observe(host)
  new ResizeObserver(resize).observe(squareEl)
  // Address-bar show/hide and orientation changes fire on the visual viewport,
  // not always on the host — re-read insets/size there too.
  window.addEventListener('orientationchange', resize)
  // The visual viewport resizes AND scrolls as the address bar shows/hides — both
  // change the visible height/offset, so re-sync on either.
  window.visualViewport?.addEventListener('resize', resize)
  window.visualViewport?.addEventListener('scroll', resize)

  return {
    root,
    canvas,
    ctx,
    insets,
    get portrait() { return portrait },
    miniCtx,
    miniStripBox() {
      return { x: 0, y: 0, w: miniCanvas.clientWidth, h: miniCanvas.clientHeight }
    },
    setHud(text: string | null) {
      hudEl.style.display = text === null ? 'none' : ''
      if (text === null) { windMobileEl.textContent = ''; return }
      // Split "Hole 1/9    ⏱ 2.5s" into a left (hole) and right (time) part so
      // the pill can span the top with the center free (portrait: the up-arrow
      // sits in the center gap). The ⏱ marks the boundary.
      const i = text.indexOf('⏱')
      if (i >= 0) {
        hudLeftEl.textContent = text.slice(0, i).trim()
        hudRightEl.textContent = text.slice(i).trim()
      } else {
        hudLeftEl.textContent = text.trim()
        hudRightEl.textContent = ''
      }
    },
    setWind(mph: number) {
      // "Wind: →→ 5 mph" — arrow points in the wind's direction, its length grows
      // with strength (one glyph per ~4 mph, min one when non-zero). At 0 mph no
      // arrow. Shown desktop top-left (in the HUD pill) and mobile bottom-left.
      const n = Math.round(mph)
      let txt: string
      if (n === 0) {
        txt = 'Wind: 0 mph'
      } else {
        const glyph = n > 0 ? '→' : '←'
        const len = Math.min(6, Math.max(1, Math.round(Math.abs(n) / 4)))
        txt = `Wind: ${glyph.repeat(len)} ${Math.abs(n)} mph`
      }
      hudWindEl.textContent = txt
      windMobileEl.textContent = txt
    },
    setControls(s: ControlsState | null) {
      if (!portrait) return
      // Spectators (or any ball-less viewer) pass null — hide the controls entirely.
      controlsEl.style.display = s === null ? 'none' : ''
      if (s === null) return
      // Club/spin can't change mid-swing — grey the buttons while swinging.
      for (const btn of Array.from(controlsEl.querySelectorAll<HTMLButtonElement>('[data-club]'))) {
        btn.classList.toggle('active', btn.dataset.club === s.club)
        btn.classList.toggle('locked', s.swinging)
      }
      for (const btn of Array.from(controlsEl.querySelectorAll<HTMLButtonElement>('[data-spin]'))) {
        btn.classList.toggle('active', btn.dataset.spin === s.spin)
        btn.classList.toggle('locked', s.swinging)
      }
      hitBtnEl.classList.toggle('active', s.swinging)
      meterBallEl.style.left = `${s.ballFrac * 100}%`
      // Green accuracy band, symmetric around the origin, always shown. Position/
      // width from the track-fraction geometry.
      meterGreenEl.style.left = `${s.greenLeftFrac * 100}%`
      meterGreenEl.style.width = `${(s.greenRightFrac - s.greenLeftFrac) * 100}%`
      // Power marker ghost ball — parked at the captured-power position.
      if (s.powerMarkerFrac !== null) meterMarkerEl.style.left = `${s.powerMarkerFrac * 100}%`
      meterMarkerEl.classList.toggle('show', s.powerMarkerFrac !== null)
      // Readouts: accuracy on the left, power on the right.
      meterAccEl.textContent = s.accuracyPct !== null ? `A ${s.accuracyPct}%` : ''
      meterAccEl.classList.toggle('duff', s.accuracyPct !== null && s.accuracyPct < 60)
      meterPowEl.textContent = s.powerPct !== null ? `P ${s.powerPct}%` : ''
      if (s.bunkerPct === null) { bunkerEl.textContent = ''; bunkerEl.classList.remove('show') }
      else { bunkerEl.textContent = `${s.bunkerPct}%`; bunkerEl.classList.add('show') }
    },
    sync: applySync,
    closeMenu() { menuPanelEl.style.display = 'none' },
    toggleMenu,
    resize,
  }
}
