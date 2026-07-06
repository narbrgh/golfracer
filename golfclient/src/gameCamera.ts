// GameCamera — shared camera + outer-chrome module for both single-player
// (main.ts) and multiplayer (screens/matchScreen.ts). Renderer-agnostic (no
// DOM, no network) — same pattern as SwingEngine in swing.ts. Owns camera
// state/math and minimap-frame drawing; per-screen content (terrain, balls,
// parabola, etc.) is drawn by the caller via the drawContent callback.
//
// mountGameChrome() builds the actual DOM (wrap/canvas/hud/free-look-arrows/
// hamburger menu) both screens share, so the two GUIs can't drift apart again.

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
  }
  exitFreeLook() {
    if (this.mode === 'follow') return
    this.mode = 'follow'
    this.zoom = 1 // revert to the ball at normal zoom
    this.held.clear()
  }
  toggleFreeLook() { this.mode === 'free' ? this.exitFreeLook() : this.enterFreeLook() }

  zoomAt(screenX: number, screenY: number, factor: number) {
    const { wx, wy } = this.screenToWorld(screenX, screenY)
    this.zoom = clamp(this.zoom * factor, this.cfg.minZoom, this.cfg.maxZoom)
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
        this.zoom = 1 + (this.shotWideZoom - 1) * o
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
      const targetZoom = clamp(Math.min(1, fitZoom), this.cfg.minZoom, 1)
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

  // ---- Minimap (top-right) ----
  miniBox(w = 200, h = 52, pad = 12) { return { x: this.cw - w - pad, y: pad, w, h } }

  miniHit(px: number, py: number): boolean {
    const b = this.miniBox()
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h
  }

  miniJump(px: number, py: number) {
    const b = this.miniBox()
    const wx = ((px - b.x) / b.w) * this.worldW
    const wy = ((py - b.y) / b.h) * this.worldH
    this.camX = wx - this.cw / this.zoom / 2
    this.camY = wy - this.ch / this.zoom / 2
    this.clampCam()
  }

  /** Draws the shared minimap frame (bg/border/camera-viewport rect); drawContent renders per-screen content in between. */
  drawMinimapFrame(ctx: CanvasRenderingContext2D, drawContent: (mwx: (wx: number) => number, mwy: (wy: number) => number) => void) {
    const b = this.miniBox()
    ctx.fillStyle = 'rgba(8,14,20,0.72)'; ctx.fillRect(b.x, b.y, b.w, b.h)
    ctx.strokeStyle = 'rgba(246,239,206,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(b.x, b.y, b.w, b.h)

    const mwx = (wx: number) => b.x + (wx / this.worldW) * b.w
    const mwy = (wy: number) => b.y + (wy / this.worldH) * b.h
    drawContent(mwx, mwy)

    const visW = this.cw / this.zoom, visH = this.ch / this.zoom
    ctx.strokeStyle = 'rgba(246,239,206,0.75)'; ctx.lineWidth = 1
    ctx.strokeRect(mwx(this.camX), mwy(this.camY), (visW / this.worldW) * b.w, (visH / this.worldH) * b.h)
  }
}

export interface ChromeMenuItem { label: string; onClick: () => void; style?: string }

export interface GameChromeHandle {
  root: HTMLElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  /** Sets the top-left hole/timer HUD text; null hides the pill entirely. */
  setHud(text: string | null): void
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
}

// Builds the wrap/canvas/hud/free-look-arrows/hamburger-menu DOM shared by
// both screens (see gameChrome.css), and wires it to a GameCamera instance.
export function mountGameChrome(host: HTMLElement, cam: GameCamera, opts: {
  menuItems: ChromeMenuItem[]
  minW?: number
  minH?: number
}): GameChromeHandle {
  const minW = opts.minW ?? 900, minH = opts.minH ?? 560

  const root = document.createElement('div')
  root.className = 'gc-wrap'
  root.innerHTML = `
    <canvas class="gc-canvas"></canvas>
    <div class="gc-hud" data-hud></div>
    <div class="free-arrows" data-arrows style="display:none">
      <div class="free-hint">Free look — Enter, M, Space, or right-click to exit</div>
      <button class="free-arrow fa-up" data-pan="up">▲</button>
      <button class="free-arrow fa-down" data-pan="down">▼</button>
      <button class="free-arrow fa-left" data-pan="left">◀</button>
      <button class="free-arrow fa-right" data-pan="right">▶</button>
    </div>
    <div class="gc-menu">
      <button class="gc-look-toggle" data-look-toggle aria-label="Free look">🔍</button>
      <button class="gc-menu-toggle" data-menu-toggle aria-label="Menu">☰</button>
      <div class="gc-menu-panel" data-menu-panel style="display:none"></div>
    </div>`
  host.appendChild(root)

  const canvas = root.querySelector('canvas')!
  const ctx = canvas.getContext('2d')!
  const hudEl = root.querySelector<HTMLElement>('[data-hud]')!
  const arrowsEl = root.querySelector<HTMLElement>('[data-arrows]')!
  const menuToggleEl = root.querySelector<HTMLButtonElement>('[data-menu-toggle]')!
  const menuPanelEl = root.querySelector<HTMLElement>('[data-menu-panel]')!
  const lookToggleEl = root.querySelector<HTMLButtonElement>('[data-look-toggle]')!

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
  }
  applySync()

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

  function resize() {
    // CSS-pixel size the game logic works in. Use the host's actual size, but
    // never smaller than minW/minH ON DESKTOP — i.e. only enforce the floor when
    // the host is a mouse/large screen. On a small/touch screen we fit the host
    // exactly, so the canvas no longer overflows and forces page scroll/zoom.
    const hostW = host.clientWidth || minW
    const hostH = host.clientHeight || minH
    const small = Math.min(window.innerWidth, window.innerHeight) < minH ||
      (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
    const cw = small ? hostW : Math.max(minW, hostW)
    const ch = small ? hostH : Math.max(minH, hostH)
    // Backing store at devicePixelRatio for crisp rendering on retina/mobile; the
    // ctx is scaled so all draw code keeps working in CSS px (== cam.cw/cam.ch).
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr)
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px'
    root.style.width = cw + 'px'; root.style.height = ch + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cam.resize(cw, ch)
  }
  resize()
  new ResizeObserver(resize).observe(host)

  return {
    root,
    canvas,
    ctx,
    setHud(text: string | null) {
      hudEl.style.display = text === null ? 'none' : ''
      if (text !== null) hudEl.textContent = text
    },
    sync: applySync,
    closeMenu() { menuPanelEl.style.display = 'none' },
    toggleMenu,
  }
}
