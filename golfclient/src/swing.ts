// SwingEngine — Mario-Golf-style swing HUD + aim, renderer-agnostic.
//
// This module owns club/spin selection, drag-to-aim, the live trajectory
// preview, the bottom HUD (canvas-drawn), the power-meter swing state
// machine, and the distance readout format. It knows nothing about
// networking or the server; callers (main.ts, eventually matchScreen.ts)
// own the canvas/camera/websocket and wire this in.
//
// Swing mechanic (2-press, for now): first Hit! press starts the meter
// (ball icon sweeps 0->100 over risingMs, then 100->0 over fallingMs,
// auto-cancelling with no penalty if it runs all the way back to 0
// untouched). A second press mid-sweep captures the current % as power and
// reports it back to the caller — accuracy (a 3rd press) is deferred.
//
// NOTE (anti-cheat, flagged for later): today the caller fires the shot by
// sending this module's computed (vx, vy) straight to the server — a
// client-computed-velocity path that's a cheat vector. The plan is to
// eventually have the client send aimAngle + press timestamps instead and
// let the server derive power/accuracy/duff itself; getLaunchVelocity's
// math would move server-side at that point. Not done yet.

import type { SafeInsets } from './gameCamera'

export type Club = 'driver' | 'wedge' | 'putter'
export type Spin = 'back' | 'none' | 'top'
export type HudRegion = `club:${Club}` | `spin:${Spin}` | 'hit' | 'meter'

const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

const CLUBS: Club[] = ['driver', 'wedge', 'putter']
const SPINS: Spin[] = ['back', 'none', 'top']
const CLUB_LABEL: Record<Club, string> = { driver: 'D', wedge: 'PW', putter: 'P' }
const SPIN_LABEL: Record<Spin, string> = { back: 'BS', none: 'NS', top: 'TS' }

// Max launch speed per club, px/s. Tuned for a more golf-like feel.
// NOTE: the multiplayer server still clamps shots to maxShotSpeed=1500
// (rooms/match.go), so driver shots there are capped until that constant is
// raised to match; single-player (main.go) does not cap, so full speeds apply.
// Mutable and exported so the Ken debug menu can retune club distance live;
// DEFAULT_CLUB_MAX_SPEED is the fixed reference it resets to / labels as "default".
export const DEFAULT_CLUB_MAX_SPEED: Record<Club, number> = { driver: 2000, wedge: 1500, putter: 450 }
export const CLUB_MAX_SPEED: Record<Club, number> = { ...DEFAULT_CLUB_MAX_SPEED }

// Shot-power multiplier applied when the ball is shot while sitting on/in a
// bunker (0-1). The SERVER is authoritative and applies these to the launch
// velocity (single-player main.go "shoot" handler; multiplayer applyShoot); the
// client mirrors them here so the shot-prediction arc and the HUD % readout
// match. Keep in sync with physics.Config defaults (driver 0.25 / wedge 0.7 /
// putter 0.5) — the Ken menu tunes the server copy.
export const DEFAULT_CLUB_BUNKER_PENALTY: Record<Club, number> = { driver: 0.25, wedge: 0.7, putter: 0.5 }
export const CLUB_BUNKER_PENALTY: Record<Club, number> = { ...DEFAULT_CLUB_BUNKER_PENALTY }

const GRAVITY = 1500          // matches golfserver physics.Gravity
const PUTTER_RAY_LEN = 220    // world px — fixed preview length for the putter's ground ray

// ---- HUD layout constants (screen space) ----
// The HUD is a floating overlay drawn directly over the game view (no opaque
// backing bar) — individual controls carry their own translucent fill. It's
// laid out in TWO centered rows so nothing gets cramped on a phone:
//   Row 1: club icons · bunker% · spin icons
//   Row 2: Hit! button · power meter
// A generous bottom margin keeps both rows clear of the on-screen edge.
const ICON = 44        // finger-friendly tap target (≥44px)
const ICON_GAP = 8
const GROUP_GAP = 22   // gap between the club and spin groups (row 1)
const BUNKER_W = 40    // reserved slot for the bunker-% readout (between the groups)
const ROW_GAP = 14     // vertical gap between the two rows
const BOTTOM_MARGIN = 34 // more room at the bottom (was 18)
const SIDE_MARGIN = 22   // landscape: distance from the left/right screen edge
const HIT_W = 58, HIT_H = 44
const HIT_METER_GAP = 14
const METER_W = 220   // wider now that it owns its own row
const METER_H = 26
const BALL_R = 8

interface HudLayout {
  // Per-element top-left corners (screen px). Portrait stacks them in two bottom
  // rows; landscape splits them to the left (clubs+spin) and right (Hit!+meter)
  // edges — but the draw/hit-test code only reads these coordinates, so it's
  // orientation-agnostic.
  clubXs: number[]; clubY: number
  spinXs: number[]; spinY: number
  bunkerX: number; bunkerY: number   // center-x anchor is bunkerX + BUNKER_W/2
  hitX: number; hitY: number
  meterX: number; meterY: number; meterW: number
  hitBox: { x: number; y: number; w: number; h: number }  // union bbox for hit-test gating
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)) }

const SWING_RISE_MS = 750, SWING_FALL_MS = 750
type MeterPhase = 'idle' | 'rising' | 'falling'

export interface SwingConfig { ballColorHex?: string }

export interface HitResult { fired: true; powerPct: number }

export class SwingEngine {
  club: Club = 'driver'
  spin: Spin = 'none'
  // Launch direction, radians, standard atan2 convention in a y-down (screen/world)
  // coordinate system: 0 = +x (right), positive = downward, negative = upward.
  // Default: 45° up-and-to-the-right.
  aimAngle: number = -Math.PI / 4

  // Swing-meter state. meterPct is the ball icon's current position (0-100),
  // recomputed each update() from meterPhase/meterPhaseStartMs.
  private meterPhase: MeterPhase = 'idle'
  private meterPhaseStartMs = 0
  meterPct = 0

  ballColorHex: string

  // Set by the screen each frame: true when the ball is currently sitting on/in
  // a bunker. Drives the bunker-penalty % HUD readout and the client's
  // shot-prediction power (the server applies the real penalty authoritatively).
  inBunker = false

  constructor(cfg: SwingConfig = {}) {
    this.ballColorHex = cfg.ballColorHex ?? '#fff'
  }

  // Reset the swing selections at the start of a hole: driver, no spin, and a
  // 45° launch aimed toward the hole. holeX/ballX pick the horizontal side —
  // hole to the right → up-and-right (-45°), to the left → up-and-left (-135°).
  resetForHole(holeX: number, ballX: number): void {
    this.club = 'driver'
    this.spin = 'none'
    this.aimAngle = holeX >= ballX ? -Math.PI / 4 : (-3 * Math.PI) / 4
  }

  private layout(cw: number, ch: number, insets: SafeInsets = ZERO_INSETS): HudLayout {
    const groupW = 3 * ICON + 2 * ICON_GAP
    // Landscape screens are short: a stacked bottom HUD would run off the top of
    // the play area and under the gesture bar. So in landscape we move the HUD to
    // the SIDES — clubs+spin on the left, Hit!+meter on the right — where the tall
    // dimension gives room. Portrait keeps the two centered bottom rows.
    const landscape = cw > ch

    if (landscape) {
      const left = SIDE_MARGIN + insets.left
      const right = cw - SIDE_MARGIN - insets.right
      // Left column: clubs row above spin row, vertically centered on screen.
      const colH = ICON + ROW_GAP + ICON
      let ly = (ch - colH) / 2
      const clubXs: number[] = []
      for (let i = 0; i < 3; i++) clubXs.push(left + i * (ICON + ICON_GAP))
      const clubY = ly
      ly += ICON + ROW_GAP
      const spinXs: number[] = []
      for (let i = 0; i < 3; i++) spinXs.push(left + i * (ICON + ICON_GAP))
      const spinY = ly
      // Bunker % sits just right of the club/spin block, centered vertically.
      const bunkerX = left + groupW + 10
      const bunkerY = (clubY + spinY + ICON) / 2 - ICON / 2

      // Right column: Hit! above the meter, vertically centered.
      const rColH = HIT_H + ROW_GAP + METER_H
      let ry = (ch - rColH) / 2
      const hitX = right - HIT_W
      const hitY = ry
      ry += HIT_H + ROW_GAP
      const meterW = METER_W
      const meterX = right - meterW
      const meterY = ry + 4

      const hbX = Math.min(clubXs[0], hitX)
      const hbW = Math.max(spinXs[2] + ICON, right) - hbX
      const hbY = Math.min(clubY, hitY)
      const hbH = Math.max(spinY + ICON, meterY + METER_H) - hbY
      return {
        clubXs, clubY, spinXs, spinY, bunkerX, bunkerY, hitX, hitY,
        meterX, meterY, meterW, hitBox: { x: hbX, y: hbY, w: hbW, h: hbH },
      }
    }

    // ---- Portrait: two centered bottom rows, lifted above the safe-area. ----
    const row2Y = ch - HIT_H - BOTTOM_MARGIN - insets.bottom
    const row1Y = row2Y - ROW_GAP - ICON

    // Row 1: clubs · bunker% · spin as ONE compact centered cluster (not
    // justified to the screen edges — that left an odd empty middle). The gap
    // is fixed so the two groups stay close; the bunker% slot lives between them.
    const g1 = GROUP_GAP
    const row1W = groupW + g1 + BUNKER_W + g1 + groupW
    const row1Left = (cw - row1W) / 2
    const clubXs: number[] = []
    for (let i = 0; i < 3; i++) clubXs.push(row1Left + i * (ICON + ICON_GAP))
    const bunkerX = row1Left + groupW + g1
    const spinLeft = bunkerX + BUNKER_W + g1
    const spinXs: number[] = []
    for (let i = 0; i < 3; i++) spinXs.push(spinLeft + i * (ICON + ICON_GAP))

    // Row 2: Hit! · meter, centered — but within the width left of the
    // bottom-right button column (🔍/☰, ~44px + margins) so the meter's right
    // end doesn't slide under those buttons.
    const btnGutter = 72
    const row2W = HIT_W + HIT_METER_GAP + METER_W
    let rx = Math.max(8, (cw - btnGutter - row2W) / 2)
    const hitX = rx
    const hitY = row2Y
    rx += HIT_W + HIT_METER_GAP
    const meterX = rx, meterW = METER_W
    const meterY = row2Y + (HIT_H - METER_H) / 2

    return {
      clubXs, clubY: row1Y, spinXs, spinY: row1Y, bunkerX, bunkerY: row1Y,
      hitX, hitY, meterX, meterY, meterW,
      hitBox: { x: 0, y: row1Y, w: cw, h: ch - row1Y },
    }
  }

  /** Hit-tests a screen-space point against the HUD. Returns null if outside it. */
  hitTestHud(x: number, y: number, cw: number, ch: number, insets: SafeInsets = ZERO_INSETS): HudRegion | null {
    const L = this.layout(cw, ch, insets)
    const b = L.hitBox
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return null
    const inBox = (bx: number, by: number, bw: number, bh: number) =>
      x >= bx && x <= bx + bw && y >= by && y <= by + bh
    for (let i = 0; i < 3; i++) if (inBox(L.clubXs[i], L.clubY, ICON, ICON)) return `club:${CLUBS[i]}`
    for (let i = 0; i < 3; i++) if (inBox(L.spinXs[i], L.spinY, ICON, ICON)) return `spin:${SPINS[i]}`
    if (inBox(L.hitX, L.hitY, HIT_W, HIT_H)) return 'hit'
    if (inBox(L.meterX, L.meterY - 10, L.meterW, METER_H + 20)) return 'meter'
    return null
  }

  /** Applies a club/spin HUD click. Hit! goes through pressHit() instead. */
  handleHudClick(region: HudRegion) {
    if (region.startsWith('club:')) this.club = region.slice(5) as Club
    else if (region.startsWith('spin:')) this.spin = region.slice(5) as Spin
  }

  /**
   * Advances the swing meter. Call once per animation frame regardless of
   * input — the sweep runs on a clock, not on clicks. If the meter reaches
   * the end of its fall back to 0 untouched, it auto-cancels to idle (no
   * penalty, no report — the caller never hears about it).
   */
  update(nowMs: number) {
    if (this.meterPhase === 'idle') { this.meterPct = 0; return }
    const elapsed = nowMs - this.meterPhaseStartMs
    if (this.meterPhase === 'rising') {
      if (elapsed >= SWING_RISE_MS) { this.meterPhase = 'falling'; this.meterPhaseStartMs = nowMs; this.meterPct = 100 }
      else this.meterPct = (elapsed / SWING_RISE_MS) * 100
    } else {
      if (elapsed >= SWING_FALL_MS) { this.meterPhase = 'idle'; this.meterPct = 0 }
      else this.meterPct = 100 - (elapsed / SWING_FALL_MS) * 100
    }
  }

  /**
   * Handles a Hit! press. First press (from idle) starts the meter sweep and
   * returns null. A second press, mid-sweep, captures the current % as
   * power, resets to idle, and reports it back for the caller to launch.
   */
  pressHit(nowMs: number): HitResult | null {
    if (this.meterPhase === 'idle') {
      this.meterPhase = 'rising'; this.meterPhaseStartMs = nowMs; this.meterPct = 0
      return null
    }
    const powerPct = this.meterPct
    this.meterPhase = 'idle'; this.meterPct = 0
    return { fired: true, powerPct }
  }

  // Sets aimAngle from a slingshot drag: the launch direction is AWAY from the
  // cursor (drag back to launch forward), matching the existing shot feel.
  // Drag distance is ignored — power comes from the meter, later. Driver/wedge
  // have no angle bounds — full 360°, including straight down. Putter is
  // horizontal-only, direction by which side of the ball the cursor is on.
  setAimFromScreen(ballSx: number, ballSy: number, cursorSx: number, cursorSy: number) {
    const rawDx = ballSx - cursorSx, rawDy = ballSy - cursorSy

    if (this.club === 'putter') {
      const side = rawDx >= 0 ? 1 : -1
      this.aimAngle = side > 0 ? 0 : Math.PI
      return
    }

    this.aimAngle = Math.atan2(rawDy, rawDx)
  }

  // 100%-power projectile preview at aimAngle, g = GRAVITY, no drag/wind/collision.
  // Putter returns a short horizontal ground ray instead of an arc. For an arc
  // that goes up first, sampling stops once it's come back down to launch
  // height (an approximation of "landed") or left world bounds. A shot aimed
  // level or downward from the start never rises above launch height, so that
  // condition would trip immediately — instead it's capped by worldH of drop,
  // enough to draw a clear downward segment without an unbounded line.
  computeParabolaWorld(ballWx: number, ballWy: number, worldW: number, worldH: number): { x: number; y: number }[] {
    if (this.club === 'putter') {
      const dir = Math.cos(this.aimAngle) >= 0 ? 1 : -1
      return [{ x: ballWx, y: ballWy }, { x: ballWx + dir * PUTTER_RAY_LEN, y: ballWy }]
    }

    // Preview at max power, reduced by the bunker penalty when applicable so the
    // arc visibly shrinks when the ball sits in sand (matches the actual shot).
    let speed = CLUB_MAX_SPEED[this.club]
    if (this.inBunker) speed *= CLUB_BUNKER_PENALTY[this.club]
    const vx0 = Math.cos(this.aimAngle) * speed, vy0 = Math.sin(this.aimAngle) * speed
    const pts: { x: number; y: number }[] = [{ x: ballWx, y: ballWy }]
    const dt = 1 / 60
    let wentUp = false
    for (let i = 1; i <= 600; i++) {
      const t = i * dt
      const x = ballWx + vx0 * t
      const y = ballWy + vy0 * t + 0.5 * GRAVITY * t * t
      if (y < ballWy) wentUp = true
      pts.push({ x, y })
      if (x < 0 || x > worldW) break
      if (wentUp && y >= ballWy) break
      if (y - ballWy > worldH) break
    }
    return pts
  }

  /** Dashed vector polyline — call inside the world transform (after ctx.scale/translate). */
  drawParabolaWorld(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], zoom: number, color = 'rgba(255,255,255,0.85)') {
    if (pts.length < 2) return
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2 / zoom
    ctx.setLineDash([6 / zoom, 5 / zoom])
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
    ctx.restore()
  }

  /**
   * The central "aim zone" (screen px): a fixed circle at screen center. On
   * touch this is the only region where a drag starts an aim — drags outside it
   * pan/scroll the view, so the player can survey the hole without accidentally
   * re-aiming every time they try to scroll. Radius scales gently with the
   * smaller screen dimension so it's a comfortable thumb target on any device.
   */
  aimZone(cw: number, ch: number): { x: number; y: number; r: number } {
    const r = clamp(Math.min(cw, ch) * 0.16, 60, 130)
    return { x: cw / 2, y: ch / 2, r }
  }

  /** True if a screen point is inside the central aim zone. */
  inAimZone(sx: number, sy: number, cw: number, ch: number): boolean {
    const z = this.aimZone(cw, ch)
    return Math.hypot(sx - z.x, sy - z.y) <= z.r
  }

  /** Draws the hashed blue aim-zone circle (screen space). Call when aiming is
   * available so the player sees where to grab to aim. */
  drawAimZone(ctx: CanvasRenderingContext2D, cw: number, ch: number, active = false) {
    const z = this.aimZone(cw, ch)
    ctx.save()
    ctx.strokeStyle = active ? 'rgba(120,200,255,0.95)' : 'rgba(120,200,255,0.55)'
    ctx.lineWidth = 2
    ctx.setLineDash([7, 6])
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
    // A small center tick so the zone reads as an aim target, not just a ring.
    ctx.fillStyle = 'rgba(120,200,255,0.7)'
    ctx.beginPath(); ctx.arc(z.x, z.y, 3, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  /**
   * HUD overlay — call in screen space (after the world transform is
   * restored). Floats directly over the game view: no opaque backing bar,
   * each control just carries its own translucent fill.
   */
  drawHud(ctx: CanvasRenderingContext2D, cw: number, ch: number, insets: SafeInsets = ZERO_INSETS) {
    const L = this.layout(cw, ch, insets)
    ctx.save()

    const drawIcon = (x: number, y: number, label: string, selected: boolean) => {
      ctx.beginPath()
      ctx.roundRect(x, y, ICON, ICON, 6)
      ctx.fillStyle = 'rgba(128,128,128,0.5)'; ctx.fill()
      ctx.strokeStyle = selected ? '#fff' : '#000'
      ctx.lineWidth = selected ? 2 : 1.5
      ctx.stroke()
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px monospace'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(label, x + ICON / 2, y + ICON / 2 + 1)
    }
    CLUBS.forEach((c, i) => drawIcon(L.clubXs[i], L.clubY, CLUB_LABEL[c], this.club === c))
    SPINS.forEach((s, i) => drawIcon(L.spinXs[i], L.spinY, SPIN_LABEL[s], this.spin === s))

    // Bunker penalty readout — the selected club's power multiplier as a
    // percentage (e.g. 25% / 70% / 50%), shown only while the ball sits in sand.
    if (this.inBunker) {
      const pct = Math.round(CLUB_BUNKER_PENALTY[this.club] * 100)
      const px = L.bunkerX + BUNKER_W / 2
      const py = L.bunkerY + ICON / 2
      ctx.font = 'bold 16px monospace'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillText(`${pct}%`, px + 1, py + 1)     // shadow for legibility over terrain
      ctx.fillStyle = '#ffcf5c'                    // sandy amber
      ctx.fillText(`${pct}%`, px, py)
    }

    // Hit! button — outlined white while a swing is in progress.
    const swinging = this.meterPhase !== 'idle'
    ctx.beginPath()
    ctx.roundRect(L.hitX, L.hitY, HIT_W, HIT_H, 6)
    ctx.fillStyle = 'rgba(128,128,128,0.5)'; ctx.fill()
    ctx.strokeStyle = swinging ? '#fff' : '#000'; ctx.lineWidth = swinging ? 2 : 1.5; ctx.stroke()
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('Hit!', L.hitX + HIT_W / 2, L.hitY + HIT_H / 2 + 1)

    // Power meter track — narrow, fixed width.
    ctx.beginPath()
    ctx.roundRect(L.meterX, L.meterY, L.meterW, METER_H, METER_H / 2)
    ctx.fillStyle = 'rgba(128,128,128,0.5)'; ctx.fill()
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke()

    ctx.font = '10px monospace'; ctx.fillStyle = '#ccc'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    for (let p = 0; p <= 100; p += 10) {
      const tx = L.meterX + (p / 100) * L.meterW
      const long = p === 0 || p === 50 || p === 100
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = long ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(tx, L.meterY - (long ? 6 : 3))
      ctx.lineTo(tx, L.meterY + METER_H + (long ? 6 : 3))
      ctx.stroke()
      if (long) ctx.fillText(String(p), tx, L.meterY + METER_H + 8)
    }

    // Ball tracks the live meter position (0 at rest, sweeps while swinging).
    const ballX = L.meterX + (this.meterPct / 100) * L.meterW
    ctx.beginPath()
    ctx.arc(ballX, L.meterY + METER_H / 2, BALL_R, 0, Math.PI * 2)
    ctx.fillStyle = this.ballColorHex; ctx.fill()
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke()

    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.restore()
  }

  /** True while a swing meter is sweeping (used by DOM controls to highlight Hit!). */
  isSwinging(): boolean { return this.meterPhase !== 'idle' }

  /** The selected club's bunker-penalty as a percentage (e.g. 25 / 70 / 50). */
  clubBunkerPct(): number { return CLUB_BUNKER_PENALTY[this.club] * 100 }

  // Converts a captured power % (0-100, from pressHit's HitResult) into a
  // launch velocity at the current club/aimAngle. accuracyOffsetRad is
  // unused today (no 3rd press yet) — defaults to dead-on.
  getLaunchVelocity(powerPct: number, accuracyOffsetRad = 0): { vx: number; vy: number } {
    const angle = this.aimAngle + accuracyOffsetRad
    let speed = CLUB_MAX_SPEED[this.club] * clamp(powerPct, 0, 100) / 100
    // Bunker penalty mirrors the server so the predicted arc matches. The server
    // re-applies it authoritatively from its own bunker check, so a spoofed
    // client can't dodge it — this is prediction fidelity, not the enforcement.
    if (this.inBunker) speed *= CLUB_BUNKER_PENALTY[this.club]
    return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed }
  }
}

// Straight-line distance readout, 50 px/ft. Whole numbers only.
//   >100 ft  -> yards
//   10-100ft -> feet
//   <10 ft   -> feet + inches
export function formatDistance(distPx: number): string {
  const feet = distPx / 50
  if (feet > 100) return `${Math.round(feet / 3)} yd`
  if (feet >= 10) return `${Math.round(feet)} ft`
  let wholeFt = Math.floor(feet)
  let inches = Math.round((feet - wholeFt) * 12)
  if (inches === 12) { inches = 0; wholeFt += 1 }
  return `${wholeFt}' ${inches}"`
}
