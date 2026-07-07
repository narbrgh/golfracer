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

// Rolling friction (px/s² kinetic deceleration on grass) — mirrors golfserver
// physics.DefaultTunables.RollingFriction. Used only to precompute the putter
// preview line's LENGTH: how far a 100%-power putt rolls on LEVEL ground, from
// v²/(2·friction). The Ken menu can retune the server copy, so this may drift
// slightly (like GRAVITY does for the arc preview) — it's a guide, not physics.
const ROLLING_FRICTION = 400

/**
 * World-px roll distance of a putt struck at `powerPct` on perfectly level
 * ground: constant-deceleration stop distance v²/(2a). Independent of terrain —
 * the putter guide line is always this long regardless of hills (item 4).
 */
export function putterRollDistance(powerPct = 100): number {
  const v = CLUB_MAX_SPEED.putter * clamp(powerPct, 0, 100) / 100
  return (v * v) / (2 * ROLLING_FRICTION)
}

// Air/spin constants mirroring golfserver physics.DefaultTunables (AirDrag,
// SpinMagnus, WindMphScale). The SERVER is authoritative for real ball flight;
// these only shape the client's preview parabola and multiplayer prediction so
// they roughly match. If the Ken menu tunes the server copy the preview may drift
// slightly, exactly as it would for gravity today.
export const AIR_DRAG = 0.22
export const SPIN_MAGNUS = 0.30
export const WIND_MPH_SCALE = 55.0
// Mirrors golfserver ball.go backspinExtraDrag — extra horizontal drag on backspun
// shots so they carry shorter than no-spin. Keep equal to the server constant.
export const BACKSPIN_EXTRA_DRAG = 0.6

/** spin string → sign used by the Magnus term: back −1, top +1, else 0. */
export function spinSign(spin: Spin): number { return spin === 'back' ? -1 : spin === 'top' ? 1 : 0 }

/**
 * One airborne physics substep, mirroring golfserver ball.go Tick's air forces
 * (gravity + drag-toward-moving-air + Magnus). Mutates and returns the velocity.
 * windVel is the horizontal air velocity in px/s (mph × WIND_MPH_SCALE); spin is
 * −1/0/+1. Shared by the preview parabola and the multiplayer prediction loop so
 * both track the server. Ground/roll physics is not modeled here (preview only).
 */
export function airStep(vx: number, vy: number, dt: number, windVel: number, spin: number): { vx: number; vy: number } {
  vy += GRAVITY * dt
  if (AIR_DRAG > 0) {
    vx += -AIR_DRAG * (vx - windVel) * dt
    vy += -AIR_DRAG * vy * dt
  }
  if (spin !== 0 && SPIN_MAGNUS > 0) {
    const speed = Math.hypot(vx, vy)
    if (speed > 1) {
      if (spin > 0) {
        // Topspin: perpendicular Magnus (dives). Unchanged.
        const ux = vx / speed, uy = vy / speed
        const px = -uy, py = ux
        const mag = spin * SPIN_MAGNUS * speed * dt
        vx += px * mag
        vy += py * mag
      } else {
        // Backspin: lift only + extra horizontal drag → higher, steeper, shorter.
        // Mirrors golfserver ball.go. (Landing bite is server-only, not previewed.)
        const lift = SPIN_MAGNUS * speed * dt
        vy -= lift
        vx += -BACKSPIN_EXTRA_DRAG * AIR_DRAG * (vx - windVel) * dt
      }
    }
  }
  return { vx, vy }
}

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
const BOTTOM_MARGIN = 34 // more room at the bottom (was 18)
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

  // Set by the screen each frame: the current hole's horizontal air velocity in
  // px/s (+right), i.e. wind mph × WIND_MPH_SCALE. Shapes the preview parabola so
  // players can aim into the wind. 0 = calm.
  windVel = 0

  // Set by the screen each frame: true while the camera is in free-look. In
  // free-look the meter can't start (you must be aiming in follow mode), so the
  // Hit! button is greyed and a click just exits free-look — the same behavior
  // the mobile DOM control already has.
  freeLook = false

  // Set by the screen each frame: current hole cup + ball world-X. Used to
  // auto-aim the putter toward the hole the instant it's selected (item 2), from
  // whatever selection path (keyboard, DOM button, or on-canvas HUD tap).
  holeX = 0
  ballX = 0

  // Tracks the previous frame's "ready to shoot" state so setReady() can detect
  // the moment the ball settles (rising edge) and re-aim the putter at the hole.
  private wasReady = false

  constructor(cfg: SwingConfig = {}) {
    this.ballColorHex = cfg.ballColorHex ?? '#fff'
  }

  // Points the putter at the hole (horizontal-only aim: it just picks the side
  // the cup is on, from the holeX/ballX the screen keeps updated). No-op for
  // other clubs. Shared by club-selection (item 2) and settle re-aim.
  private aimPutterAtHole(): void {
    if (this.club !== 'putter') return
    this.aimAngle = this.holeX >= this.ballX ? 0 : Math.PI
  }

  // Called each frame with whether the ball is settled and ready to hit. On the
  // rising edge (ball just came to rest) it re-aims the putter at the hole, so a
  // putt that rolls PAST the cup flips the aim back toward it for the next stroke
  // instead of leaving it pointed the way the last putt travelled.
  setReady(ready: boolean): void {
    if (ready && !this.wasReady) this.aimPutterAtHole()
    this.wasReady = ready
  }

  // Reset the swing selections at the start of a hole: driver, no spin, and a
  // 45° launch aimed toward the hole. holeX/ballX pick the horizontal side —
  // hole to the right → up-and-right (-45°), to the left → up-and-left (-135°).
  resetForHole(holeX: number, ballX: number): void {
    this.club = 'driver'
    this.spin = 'none'
    this.aimAngle = holeX >= ballX ? -Math.PI / 4 : (-3 * Math.PI) / 4
  }

  // Selects a club. When switching TO the putter, auto-aims it toward the hole
  // (item 2): putter aim is horizontal-only, so this just points it to whichever
  // side the cup is on, using the holeX/ballX the screen keeps updated. Other
  // clubs keep their existing aimAngle untouched. All club-selection paths
  // (keyboard, DOM buttons, on-canvas HUD taps) go through here.
  setClub(club: Club): void {
    const switchingToPutter = club === 'putter' && this.club !== 'putter'
    this.club = club
    if (switchingToPutter) this.aimPutterAtHole()
  }

  private layout(cw: number, ch: number, insets: SafeInsets = ZERO_INSETS): HudLayout {
    const groupW = 3 * ICON + 2 * ICON_GAP
    // On-canvas HUD (desktop only — mobile portrait uses DOM controls, mobile
    // landscape shows a rotate prompt): ONE row at the BOTTOM. The left cluster
    // (clubs · bunker% · spin) and the right cluster (Hit! · meter) split to the
    // two sides of a reserved center gap — the free-look ▼ button lives dead
    // center at the bottom, so nothing may sit there.
    const rowY = ch - HIT_H - BOTTOM_MARGIN - insets.bottom
    // Controls are ICON tall (44) except the meter; align everything on this row.
    const iconY = rowY + (HIT_H - ICON) / 2

    // Reserved center gap for the free-look ▼ button (40px wide, centered).
    const centerGapHalf = 60
    const cx = cw / 2

    // Left cluster: clubs · bunker% · spin, packed against the center gap's left
    // edge (grows leftward from center).
    const g1 = GROUP_GAP
    const leftW = groupW + g1 + BUNKER_W + g1 + groupW
    const leftStart = cx - centerGapHalf - leftW
    const clubXs: number[] = []
    for (let i = 0; i < 3; i++) clubXs.push(leftStart + i * (ICON + ICON_GAP))
    const bunkerX = leftStart + groupW + g1
    const spinLeft = bunkerX + BUNKER_W + g1
    const spinXs: number[] = []
    for (let i = 0; i < 3; i++) spinXs.push(spinLeft + i * (ICON + ICON_GAP))

    // Right cluster: Hit! · meter, packed against the center gap's right edge —
    // but kept clear of the bottom-right button column (🔍/☰) so the meter's
    // right end doesn't slide under those buttons.
    const btnGutter = 72
    let rx = cx + centerGapHalf
    const rightEnd = rx + HIT_W + HIT_METER_GAP + METER_W
    // If it would run under the corner buttons, slide the whole right cluster
    // left just enough to clear them.
    const overshoot = Math.max(0, rightEnd - (cw - btnGutter))
    rx -= overshoot
    const hitX = rx
    const hitY = rowY
    rx += HIT_W + HIT_METER_GAP
    const meterX = rx, meterW = METER_W
    const meterY = rowY + (HIT_H - METER_H) / 2

    return {
      clubXs, clubY: iconY, spinXs, spinY: iconY, bunkerX, bunkerY: iconY,
      hitX, hitY, meterX, meterY, meterW,
      hitBox: { x: 0, y: rowY, w: cw, h: ch - rowY },
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
    if (region.startsWith('club:')) this.setClub(region.slice(5) as Club)
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

  // 100%-power flight preview at aimAngle. Euler-integrated with the same air
  // forces the server uses (gravity + wind drag + spin Magnus, via airStep) so the
  // arc reflects wind and the selected spin — no ground/collision. Putter returns a
  // short horizontal ground ray instead of an arc. For an arc that goes up first,
  // sampling stops once it's come back down to launch height (an approximation of
  // "landed") or left world bounds. A shot aimed level or downward never rises
  // above launch height, so that condition would trip immediately — instead it's
  // capped by worldH of drop, enough to draw a clear downward segment.
  // groundCenterY (optional) samples the world-Y a resting ball's CENTER would
  // sit at for a given world-X (i.e. terrain surface minus ball radius). When
  // supplied, the putter guide follows the terrain contour at ball-center height
  // (item 3) instead of drawing a flat ray. Its length is always the level-ground
  // 100%-power roll distance (item 4) — it does NOT stretch/shrink for hills.
  computeParabolaWorld(ballWx: number, ballWy: number, worldW: number, worldH: number, groundCenterY?: (x: number) => number): { x: number; y: number }[] {
    if (this.club === 'putter') {
      const dir = Math.cos(this.aimAngle) >= 0 ? 1 : -1
      const len = putterRollDistance(100)
      const endX = clamp(ballWx + dir * len, 0, worldW)
      if (!groundCenterY) return [{ x: ballWx, y: ballWy }, { x: endX, y: ballWy }]
      // Trace the ground contour from the ball to endX so the dashed line hugs
      // the hills. Step ~ a few world px for a smooth curve without over-sampling.
      const pts: { x: number; y: number }[] = []
      const step = 6
      const total = Math.abs(endX - ballWx)
      const n = Math.max(1, Math.ceil(total / step))
      for (let i = 0; i <= n; i++) {
        const x = ballWx + (endX - ballWx) * (i / n)
        pts.push({ x, y: groundCenterY(x) })
      }
      return pts
    }

    // Preview at max power, reduced by the bunker penalty when applicable so the
    // arc visibly shrinks when the ball sits in sand (matches the actual shot).
    let speed = CLUB_MAX_SPEED[this.club]
    if (this.inBunker) speed *= CLUB_BUNKER_PENALTY[this.club]
    let vx = Math.cos(this.aimAngle) * speed, vy = Math.sin(this.aimAngle) * speed
    let x = ballWx, y = ballWy
    const spin = spinSign(this.spin)
    const pts: { x: number; y: number }[] = [{ x, y }]
    const dt = 1 / 60
    let wentUp = false
    for (let i = 1; i <= 600; i++) {
      ;({ vx, vy } = airStep(vx, vy, dt, this.windVel, spin))
      x += vx * dt
      y += vy * dt
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
  drawAimZone(ctx: CanvasRenderingContext2D, cw: number, ch: number, active = false, color?: string) {
    const z = this.aimZone(cw, ch)
    // Brighter defaults than before; `color` (a solid pulse color) overrides
    // when the caller is animating an active aim.
    const stroke = color ?? (active ? 'rgba(170,225,255,1)' : 'rgba(150,215,255,0.8)')
    ctx.save()
    ctx.strokeStyle = stroke
    ctx.lineWidth = active ? 3 : 2
    ctx.setLineDash([7, 6])
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke()
    ctx.setLineDash([])
    // A small center tick so the zone reads as an aim target, not just a ring.
    ctx.fillStyle = stroke
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

    // Hit! button — outlined white while a swing is in progress; greyed while in
    // free-look (the meter can't start there — a click just exits free-look).
    const swinging = this.meterPhase !== 'idle'
    ctx.beginPath()
    ctx.roundRect(L.hitX, L.hitY, HIT_W, HIT_H, 6)
    ctx.fillStyle = this.freeLook ? 'rgba(128,128,128,0.25)' : 'rgba(128,128,128,0.5)'; ctx.fill()
    ctx.strokeStyle = swinging ? '#fff' : '#000'; ctx.lineWidth = swinging ? 2 : 1.5; ctx.stroke()
    ctx.fillStyle = this.freeLook ? 'rgba(255,255,255,0.4)' : '#fff'; ctx.font = 'bold 12px monospace'
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
