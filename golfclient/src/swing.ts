// SwingEngine — Mario-Golf-style swing HUD + aim, renderer-agnostic.
//
// This module owns club/spin selection, drag-to-aim, the live trajectory
// preview, the bottom HUD (canvas-drawn), the power-meter swing state
// machine, and the distance readout format. It knows nothing about
// networking or the server; callers (main.ts, eventually matchScreen.ts)
// own the canvas/camera/websocket and wire this in.
//
// Swing mechanic (3-press): first Hit! press starts the meter (ball icon
// sweeps 0->100 over risingMs, then 100->0 over fallingMs, auto-cancelling
// with no penalty if it runs all the way back to 0 untouched). A second
// press mid-sweep captures the current % as POWER and reverses the ball into
// an accuracy sweep that oscillates toward the left (0%) origin. A third
// press captures ACCURACY from how close the ball is to that origin: dead-on
// = a perfect shot; within the light-green buffer band = a small random angle
// nudge; outside green (accuracy < 60%) = a "duff" (weak, near-flat shot to a
// random side). The caller only launches on the 3rd press.
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
// Mirrors golfserver NoSpinBackspinFrac — a "no spin" shot gets this fraction of the
// backspin lift/drag (and, server-side, check-up). Like SPIN_MAGNUS above, this is a
// static mirror for the preview; if the Ken menu tunes the server copy the preview
// may drift slightly, exactly as it would for the other air constants.
export const NO_SPIN_BACKSPIN_FRAC = 0.25
// Mirrors golfserver ball.go backspinExtraDrag — extra horizontal drag on backspun
// shots so they carry shorter than no-spin. Keep equal to the server constant.
export const BACKSPIN_EXTRA_DRAG = 0.6

// Backspin launch-power multiplier — a backspin shot fires at this fraction of the
// club's speed, so it flies genuinely SHORTER while keeping its landing check-up
// (the real trade-off). Applied client-side at launch (the server receives the
// already-reduced velocity and stays authoritative on it), so this is a client-only
// Ken knob like CLUB_MAX_SPEED. Held in a mutable object so the Ken menu can tune it
// live. Preview + multiplayer prediction inherit the reduced velocity automatically.
export const DEFAULT_BACKSPIN_POWER = 0.95
export const BACKSPIN_POWER = { value: DEFAULT_BACKSPIN_POWER }

/** spin string → sign used by the Magnus term: back −1, top +1, else 0. */
export function spinSign(spin: Spin): number { return spin === 'back' ? -1 : spin === 'top' ? 1 : 0 }

/**
 * One airborne physics substep, mirroring golfserver ball.go Tick's air forces
 * (gravity + drag-toward-moving-air + Magnus). Mutates and returns the velocity.
 * windVel is the horizontal air velocity in px/s (mph × WIND_MPH_SCALE); spin is
 * −1/0/+1. Shared by the preview parabola and the multiplayer prediction loop so
 * both track the server. Ground/roll physics is not modeled here (preview only).
 */
export function airStep(vx: number, vy: number, dt: number, windVel: number, spin: number, noSpinFrac = 0): { vx: number; vy: number } {
  vy += GRAVITY * dt
  if (AIR_DRAG > 0) {
    vx += -AIR_DRAG * (vx - windVel) * dt
    vy += -AIR_DRAG * vy * dt
  }
  if (SPIN_MAGNUS > 0 && (spin !== 0 || noSpinFrac > 0)) {
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
        // Backspin (spin<0): lift only + extra horizontal drag → higher, steeper,
        // shorter. No-spin (spin===0) gets the same, scaled by noSpinFrac, so a
        // "no spin" shot has a slight backspin. Mirrors golfserver ball.go.
        // (Landing bite is server-only, not previewed.)
        const frac = spin < 0 ? 1 : noSpinFrac
        const lift = frac * SPIN_MAGNUS * speed * dt
        vy -= lift
        vx += -frac * BACKSPIN_EXTRA_DRAG * AIR_DRAG * (vx - windVel) * dt
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
// The 'acc-*' phases are the accuracy sweep after power is set: the ball keeps
// oscillating with the SAME direction/position it had at the 2nd press (no
// forced reversal), sweeping between the far-left underhang (-UNDERHANG_PCT) and
// 100 until the 3rd press. The accuracy origin (dead-on target) is the 0 line.
// 'frozen' holds the meter-ball where the firing press landed while the shot is
// in flight — it stays there (not re-zeroed) until the ball rests (setReady's
// rising edge), so the player can see exactly where they stopped it.
type MeterPhase = 'idle' | 'rising' | 'falling' | 'acc-rising' | 'acc-falling' | 'frozen'

// Accuracy tuning. The meter extends UNDERHANG_PCT to the LEFT of the 0 origin
// so the accuracy sweep has room to miss left of the line. Accuracy is measured
// as distance (either side) from the 0 origin: dead-on (0) = 100%; the green
// band spans ±GREEN_HALF (edges = GREEN_EDGE_ACCURACY); outside green ramps down
// to a duff. Reaching the far-left end auto-fires at 0% (see update()).
const UNDERHANG_PCT = 10             // meter extends this far left of 0 (in 0-100 units)

/**
 * Tick-mark positions for the swing meter, as fractions (0-1) of the FULL
 * extended track (underhang + main). One tick every 10% of power from 0..100,
 * plus the far-left underhang end. `long` marks the emphasized ticks (the 0
 * origin and 50/100 power). Mirrors the canvas HUD ticks so the DOM meter
 * (portrait mobile) matches desktop. Positions are constant, so callers can
 * build the DOM once.
 */
export function meterTickFracs(): { frac: number; long: boolean }[] {
  const span = UNDERHANG_PCT + 100
  const toFrac = (pos: number) => (pos + UNDERHANG_PCT) / span
  const ticks: { frac: number; long: boolean }[] = [{ frac: 0, long: false }] // underhang end
  for (let p = 0; p <= 100; p += 10) ticks.push({ frac: toFrac(p), long: p === 0 || p === 50 || p === 100 })
  return ticks
}
const GREEN_HALF = 8                 // green band spans -8..+8 around the 0 origin
const GREEN_EDGE_ACCURACY = 60       // accuracy% at the green edge (== duff threshold)
const ACC_MAX_ANGLE_DEG = 4          // max random angle nudge (deg) at the green edge
const ACC_SPIN_FRACTION = 0.125      // spin nudge is this fraction of the angle nudge
const DUFF_POWER_FRACTION = 0.20     // duffed shots keep this fraction of the captured power
const DUFF_ANGLE_DEG = 15            // duff launch angle above horizontal (up-left or up-right)

export interface SwingConfig { ballColorHex?: string }

// A press either reports nothing (press 1), the captured power to display
// (press 2, fired:false), or the final resolved shot (press 3, fired:true).
export type HitResult =
  | { fired: false; powerPct: number }
  | {
      fired: true
      powerPct: number
      accuracyPct: number
      accuracyOffsetRad: number
      duff: boolean
    }

export class SwingEngine {
  club: Club = 'driver'
  spin: Spin = 'none'
  // Launch direction, radians, standard atan2 convention in a y-down (screen/world)
  // coordinate system: 0 = +x (right), positive = downward, negative = upward.
  // Default: 45° up-and-to-the-right. This is always the CURRENT club's aim.
  aimAngle: number = -Math.PI / 4
  // The putter aims horizontally and independently of the driver/wedge, so its
  // angle is stashed separately: switching to the putter and back must not reset
  // the driver/wedge aim. nonPutterAimAngle holds the driver/wedge aim while the
  // putter is selected; setClub swaps the right one into aimAngle on each change.
  private nonPutterAimAngle: number = -Math.PI / 4

  // Swing-meter state. meterPct is the ball icon's current position. During the
  // power sweep it is 0-100; during the accuracy sweep it can dip to
  // -UNDERHANG_PCT (left of the 0 origin). Recomputed each update().
  private meterPhase: MeterPhase = 'idle'
  private meterPhaseStartMs = 0
  meterPct = 0
  // Set by update() when the accuracy ball runs all the way to the far-left end
  // without a 3rd press — the caller polls takeAutoFire() to fire a 0% duff.
  private autoFire = false
  // Power captured on the 2nd press, carried into the accuracy sweep so the 3rd
  // press can combine power + accuracy into the final shot.
  private capturedPower = 0
  // Last power/accuracy % captured, for the HUD readouts. null = not shown.
  lastPowerPct: number | null = null
  lastAccuracyPct: number | null = null
  // Meter position where power was captured (2nd press), so a ghost "hit" ball
  // stays parked there through the accuracy sweep — a visual record of how hard
  // you hit it. null = no power captured yet (cleared on new swing / rest).
  powerMarkerPct: number | null = null

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
    if (ready && !this.wasReady) {
      this.aimPutterAtHole()
      // Ball just came to rest (red ready ring appears): release the frozen
      // meter-ball back to 0 and clear the % readouts for the next swing.
      if (this.meterPhase === 'frozen') {
        this.meterPhase = 'idle'; this.meterPct = 0
        this.lastPowerPct = null; this.lastAccuracyPct = null
        this.powerMarkerPct = null
      }
    }
    this.wasReady = ready
  }

  // Reset the swing selections at the start of a hole: driver, no spin, and a
  // 45° launch aimed toward the hole. holeX/ballX pick the horizontal side —
  // hole to the right → up-and-right (-45°), to the left → up-and-left (-135°).
  resetForHole(holeX: number, ballX: number): void {
    this.club = 'driver'
    this.spin = 'none'
    this.aimAngle = this.nonPutterAimAngle = holeX >= ballX ? -Math.PI / 4 : (-3 * Math.PI) / 4
    this.meterPhase = 'idle'; this.meterPct = 0
    this.lastPowerPct = null; this.lastAccuracyPct = null
    this.powerMarkerPct = null
  }

  // Selects a club. When switching TO the putter, auto-aims it toward the hole
  // (item 2): putter aim is horizontal-only, so this just points it to whichever
  // side the cup is on, using the holeX/ballX the screen keeps updated. Other
  // clubs keep their existing aimAngle untouched. All club-selection paths
  // (keyboard, DOM buttons, on-canvas HUD taps) go through here.
  // Locked once the swing meter is running: you can't change club mid-swing.
  setClub(club: Club): void {
    if (this.meterPhase !== 'idle') return
    const switchingToPutter = club === 'putter' && this.club !== 'putter'
    const switchingFromPutter = club !== 'putter' && this.club === 'putter'
    if (switchingToPutter) {
      // Stash the driver/wedge aim, then point the putter at the hole.
      this.nonPutterAimAngle = this.aimAngle
      this.club = club
      this.aimPutterAtHole()
    } else if (switchingFromPutter) {
      // Restore the driver/wedge aim we had before switching to the putter.
      this.club = club
      this.aimAngle = this.nonPutterAimAngle
    } else {
      this.club = club
    }
  }

  // Spin selection — locked once the swing meter is running, like setClub. All
  // spin-selection paths (keyboard, DOM buttons, HUD taps) go through here.
  setSpin(spin: Spin): void {
    if (this.meterPhase !== 'idle') return
    this.spin = spin
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
    // The meter's 0-origin sits at meterX; the accuracy underhang extends
    // UNDERHANG_PCT% of the track further LEFT of it, so reserve that width in
    // the gap after the Hit! button (else the underhang would slide under Hit!).
    const underhangW = (UNDERHANG_PCT / 100) * METER_W
    let rx = cx + centerGapHalf
    const rightEnd = rx + HIT_W + HIT_METER_GAP + underhangW + METER_W
    // If it would run under the corner buttons, slide the whole right cluster
    // left just enough to clear them.
    const overshoot = Math.max(0, rightEnd - (cw - btnGutter))
    rx -= overshoot
    const hitX = rx
    const hitY = rowY
    rx += HIT_W + HIT_METER_GAP + underhangW
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
    else if (region.startsWith('spin:')) this.setSpin(region.slice(5) as Spin)
  }

  /**
   * Advances the swing meter. Call once per animation frame regardless of
   * input — the sweep runs on a clock, not on clicks. If the meter reaches
   * the end of its fall back to 0 untouched, it auto-cancels to idle (no
   * penalty, no report — the caller never hears about it).
   */
  update(nowMs: number) {
    if (this.meterPhase === 'idle') { this.meterPct = 0; return }
    // Frozen: the shot has fired and the meter-ball holds its firing position
    // until the ball rests (setReady clears it). Don't advance or move it.
    if (this.meterPhase === 'frozen') return
    const elapsed = nowMs - this.meterPhaseStartMs
    if (this.meterPhase === 'rising') {
      if (elapsed >= SWING_RISE_MS) { this.meterPhase = 'falling'; this.meterPhaseStartMs = nowMs; this.meterPct = 100 }
      else this.meterPct = (elapsed / SWING_RISE_MS) * 100
    } else if (this.meterPhase === 'falling') {
      if (elapsed >= SWING_FALL_MS) { this.meterPhase = 'idle'; this.meterPct = 0 }
      else this.meterPct = 100 - (elapsed / SWING_FALL_MS) * 100
    } else if (this.meterPhase === 'acc-falling') {
      // Sweeping down toward -UNDERHANG_PCT (past the 0 origin). Same 750ms leg
      // speed as power (100 units in SWING_FALL_MS). When the ball runs all the
      // way to the far-left end, the 3rd hit is auto-registered there (0% duff).
      const pct = 100 - (elapsed / SWING_FALL_MS) * 100
      if (pct <= -UNDERHANG_PCT) { this.meterPct = -UNDERHANG_PCT; this.autoFire = true }
      else this.meterPct = pct
    } else { // acc-rising: sweeping back up from -UNDERHANG_PCT toward 100
      const pct = -UNDERHANG_PCT + (elapsed / SWING_RISE_MS) * 100
      if (pct >= 100) { this.meterPhase = 'acc-falling'; this.meterPhaseStartMs = nowMs; this.meterPct = 100 }
      else this.meterPct = pct
    }
  }

  /**
   * Handles a Hit! press — the swing machine.
   *   Press 1 (idle):        start the power sweep, return null.
   *   Press 2 (rising/fall):  capture power. Driver/wedge start the accuracy
   *                           sweep and return { fired:false }; the PUTTER (no
   *                           spin/angle) skips accuracy and fires immediately.
   *   Press 3 (acc-*):        capture accuracy from distance-to-origin, resolve
   *                           duff / angle nudge, reset to idle, return
   *                           { fired:true, ... } for the caller to launch.
   */
  pressHit(nowMs: number): HitResult | null {
    if (this.meterPhase === 'idle') {
      this.meterPhase = 'rising'; this.meterPhaseStartMs = nowMs; this.meterPct = 0
      this.lastPowerPct = null; this.lastAccuracyPct = null
      this.powerMarkerPct = null
      return null
    }

    if (this.meterPhase === 'rising' || this.meterPhase === 'falling') {
      this.capturedPower = this.meterPct
      this.lastPowerPct = Math.round(this.capturedPower)
      // Park a ghost ball at the power position for the rest of the swing.
      this.powerMarkerPct = this.meterPct

      // The putter uses neither spin nor angle, so the accuracy hit is pointless:
      // press 2 fires straight away (2-press swing), always dead-on, never a duff.
      if (this.club === 'putter') {
        this.lastAccuracyPct = null
        // Freeze at the power position; re-zeroes when the ball rests (setReady).
        this.meterPhase = 'frozen'  // meterPct stays where the 2nd hit landed
        return { fired: true, powerPct: this.capturedPower, accuracyPct: 100, accuracyOffsetRad: 0, duff: false }
      }

      // Press 2: lock power, then keep the ball moving in its CURRENT direction
      // (no forced reversal). 'rising' continues up to 100 first (acc-rising),
      // 'falling' continues down toward the origin (acc-falling). Seed the phase
      // clock so the position/direction is continuous — no visual jump.
      if (this.meterPhase === 'rising') {
        this.meterPhase = 'acc-rising'
        // acc-rising maps elapsed -> -UNDERHANG_PCT + elapsed/RISE*100.
        this.meterPhaseStartMs = nowMs - ((this.meterPct + UNDERHANG_PCT) / 100) * SWING_RISE_MS
      } else {
        this.meterPhase = 'acc-falling'
        // acc-falling maps elapsed -> 100 - elapsed/FALL*100.
        this.meterPhaseStartMs = nowMs - ((100 - this.meterPct) / 100) * SWING_FALL_MS
      }
      return { fired: false, powerPct: this.capturedPower }
    }

    // Press 3 (acc-rising/acc-falling): resolve accuracy from the ball's distance
    // to the 0 origin. In 'frozen' (shot in flight) a press does nothing.
    if (this.meterPhase === 'frozen') return null
    return this.resolveAccuracy(this.meterPct)
  }

  /**
   * Resolves an accuracy sweep into a fired HitResult from the ball's signed
   * position (0 = dead-on origin, negative = left underhang). Shared by the 3rd
   * press and the far-left auto-fire. Accuracy is distance from 0 on either
   * side: 100% dead-on, GREEN_EDGE_ACCURACY at ±GREEN_HALF, ramping to a duff
   * beyond the green band.
   */
  private resolveAccuracy(pos: number): Extract<HitResult, { fired: true }> {
    const dist = Math.abs(pos)
    const powerPct = this.capturedPower
    let accuracyPct: number
    if (dist <= GREEN_HALF) {
      accuracyPct = 100 - (dist / GREEN_HALF) * (100 - GREEN_EDGE_ACCURACY)
    } else {
      // Ramp below the green edge; reaches 0 by the far-left underhang end.
      accuracyPct = Math.max(0, GREEN_EDGE_ACCURACY - (dist - GREEN_HALF) * 30)
    }
    this.lastAccuracyPct = Math.round(accuracyPct)
    // Freeze the meter-ball where the 3rd hit landed (don't re-zero yet) — it
    // holds this spot while the shot flies, until the ball rests (setReady).
    this.meterPhase = 'frozen'; this.meterPct = pos; this.autoFire = false

    const duff = accuracyPct < GREEN_EDGE_ACCURACY
    let accuracyOffsetRad = 0
    if (!duff) {
      // accFrac: 1 dead-on -> 0 at the green edge. Angle nudge grows as accFrac
      // shrinks; spin adds a tiny extra random angle term. Random sign each shot.
      const accFrac = Math.max(0, 1 - dist / GREEN_HALF)
      const angleDeg = ACC_MAX_ANGLE_DEG * (1 - accFrac)
      const spinDeg = angleDeg * ACC_SPIN_FRACTION
      const nudge = (angleDeg + (Math.random() * 2 - 1) * spinDeg) * (Math.random() < 0.5 ? -1 : 1)
      accuracyOffsetRad = (nudge * Math.PI) / 180
    }
    return { fired: true, powerPct, accuracyPct, accuracyOffsetRad, duff }
  }

  /**
   * If the accuracy ball ran to the far-left end without a 3rd press, returns
   * the auto-fired (0% duff) shot once; otherwise null. Callers poll this each
   * frame (after update()) alongside their own press handling.
   */
  takeAutoFire(): Extract<HitResult, { fired: true }> | null {
    if (!this.autoFire) return null
    return this.resolveAccuracy(this.meterPct) // meterPct is pinned at -UNDERHANG_PCT
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

    // Driver/wedge: keep nonPutterAimAngle in sync so a later putter round-trip
    // restores this fresh aim, not a stale one from before the drag.
    this.aimAngle = this.nonPutterAimAngle = Math.atan2(rawDy, rawDx)
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
    // Backspin fires at reduced power (BACKSPIN_POWER) too — mirror it so the preview
    // arc shrinks to match the real shorter shot (see getLaunchVelocity).
    let speed = CLUB_MAX_SPEED[this.club]
    if (this.inBunker) speed *= CLUB_BUNKER_PENALTY[this.club]
    if (this.spin === 'back') speed *= BACKSPIN_POWER.value
    let vx = Math.cos(this.aimAngle) * speed, vy = Math.sin(this.aimAngle) * speed
    let x = ballWx, y = ballWy
    const spin = spinSign(this.spin)
    const pts: { x: number; y: number }[] = [{ x, y }]
    const dt = 1 / 60
    let wentUp = false
    for (let i = 1; i <= 600; i++) {
      ;({ vx, vy } = airStep(vx, vy, dt, this.windVel, spin, NO_SPIN_BACKSPIN_FRAC))
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

    // Club/spin can't change mid-swing — grey them out once the meter is running.
    const locked = this.meterPhase !== 'idle'
    const drawIcon = (x: number, y: number, label: string, selected: boolean) => {
      ctx.beginPath()
      ctx.roundRect(x, y, ICON, ICON, 6)
      ctx.fillStyle = locked ? 'rgba(128,128,128,0.25)' : 'rgba(128,128,128,0.5)'; ctx.fill()
      ctx.strokeStyle = selected ? '#fff' : '#000'
      ctx.lineWidth = selected ? 2 : 1.5
      ctx.stroke()
      ctx.fillStyle = locked ? 'rgba(255,255,255,0.4)' : '#fff'; ctx.font = 'bold 12px monospace'
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

    // A signed meter position (-UNDERHANG_PCT .. 100) -> screen x. 0 = origin at
    // L.meterX; the underhang extends left of it.
    const underhangW = (UNDERHANG_PCT / 100) * L.meterW
    const posToX = (pos: number) => L.meterX + (pos / 100) * L.meterW
    const trackLeft = L.meterX - underhangW
    const trackW = underhangW + L.meterW

    // Power meter track — spans the underhang (left of origin) + main 0..100.
    ctx.beginPath()
    ctx.roundRect(trackLeft, L.meterY, trackW, METER_H, METER_H / 2)
    ctx.fillStyle = 'rgba(128,128,128,0.5)'; ctx.fill()
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke()

    // Green accuracy buffer band — symmetric ±GREEN_HALF around the 0 origin.
    // Always shown (even before the swing) so the aim target is visible; ticks,
    // the power marker, and the live ball draw on top.
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(trackLeft, L.meterY, trackW, METER_H, METER_H / 2)
    ctx.clip()
    ctx.fillStyle = 'rgba(120,220,120,0.45)'
    const gx = posToX(-GREEN_HALF)
    ctx.fillRect(gx, L.meterY, posToX(GREEN_HALF) - gx, METER_H)
    ctx.restore()

    // % readouts above the meter (clearing the bottom tick labels): ACCURACY on
    // the LEFT (green ≥ threshold, red duff), POWER on the RIGHT (white).
    const readoutY = L.meterY - 12
    ctx.font = 'bold 13px monospace'
    ctx.textBaseline = 'alphabetic'
    if (this.lastAccuracyPct !== null) {
      const good = this.lastAccuracyPct >= GREEN_EDGE_ACCURACY
      ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillText(`A ${this.lastAccuracyPct}%`, trackLeft + 1, readoutY + 1)
      ctx.fillStyle = good ? '#7ddc7d' : '#ff6b6b'
      ctx.fillText(`A ${this.lastAccuracyPct}%`, trackLeft, readoutY)
    }
    if (this.lastPowerPct !== null) {
      ctx.textAlign = 'right'
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillText(`P ${this.lastPowerPct}%`, L.meterX + L.meterW + 1, readoutY + 1)
      ctx.fillStyle = '#fff'
      ctx.fillText(`P ${this.lastPowerPct}%`, L.meterX + L.meterW, readoutY)
    }

    ctx.font = '10px monospace'; ctx.fillStyle = '#ccc'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    for (let p = 0; p <= 100; p += 10) {
      const tx = posToX(p)
      const long = p === 0 || p === 50 || p === 100
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = long ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(tx, L.meterY - (long ? 6 : 3))
      ctx.lineTo(tx, L.meterY + METER_H + (long ? 6 : 3))
      ctx.stroke()
      if (long) ctx.fillText(String(p), tx, L.meterY + METER_H + 8)
    }

    // Power marker — a ghost ball parked where power was captured, so you can
    // see how hard you hit it while the accuracy ball sweeps.
    if (this.powerMarkerPct !== null) {
      const mx = posToX(this.powerMarkerPct)
      ctx.beginPath()
      ctx.arc(mx, L.meterY + METER_H / 2, BALL_R, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill()
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke()
    }

    // Ball tracks the live signed meter position (0 at rest, can dip into the
    // underhang during the accuracy sweep).
    const ballX = posToX(this.meterPct)
    ctx.beginPath()
    ctx.arc(ballX, L.meterY + METER_H / 2, BALL_R, 0, Math.PI * 2)
    ctx.fillStyle = this.ballColorHex; ctx.fill()
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke()

    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.restore()
  }

  /** True while a swing meter is sweeping (used by DOM controls to highlight Hit!). */
  isSwinging(): boolean { return this.meterPhase !== 'idle' }

  /**
   * Meter geometry for the DOM mirror, all as fractions (0-1) of the FULL
   * extended track (underhang + main). Lets the DOM place the ball, the 0
   * origin, and the symmetric green band without knowing the constants.
   */
  meterGeom(): { ballFrac: number; originFrac: number; greenLeftFrac: number; greenRightFrac: number; powerMarkerFrac: number | null } {
    const span = UNDERHANG_PCT + 100 // total track width in pct units
    const toFrac = (pos: number) => (pos + UNDERHANG_PCT) / span
    return {
      ballFrac: toFrac(this.meterPct),
      originFrac: toFrac(0),
      greenLeftFrac: toFrac(-GREEN_HALF),
      greenRightFrac: toFrac(GREEN_HALF),
      powerMarkerFrac: this.powerMarkerPct !== null ? toFrac(this.powerMarkerPct) : null,
    }
  }

  /** The selected club's bunker-penalty as a percentage (e.g. 25 / 70 / 50). */
  clubBunkerPct(): number { return CLUB_BUNKER_PENALTY[this.club] * 100 }

  // Converts a captured power % (0-100) into a launch velocity at the current
  // club/aimAngle. accuracyOffsetRad bends the launch angle (from the 3rd
  // press); 0 = dead-on.
  getLaunchVelocity(powerPct: number, accuracyOffsetRad = 0): { vx: number; vy: number } {
    const angle = this.aimAngle + accuracyOffsetRad
    let speed = CLUB_MAX_SPEED[this.club] * clamp(powerPct, 0, 100) / 100
    // Bunker penalty mirrors the server so the predicted arc matches. The server
    // re-applies it authoritatively from its own bunker check, so a spoofed
    // client can't dodge it — this is prediction fidelity, not the enforcement.
    if (this.inBunker) speed *= CLUB_BUNKER_PENALTY[this.club]
    // Backspin fires at reduced power so it flies shorter (the trade-off for its
    // landing check-up). This reduced velocity is what's sent to the server, so the
    // server stays authoritative on it and multiplayer prediction inherits it.
    if (this.spin === 'back') speed *= BACKSPIN_POWER.value
    return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed }
  }

  /**
   * Resolves a fired (3rd-press) HitResult into the final launch velocity,
   * owning the duff special-case. A duff ignores the captured power and aim:
   * it fires weakly (DUFF_POWER) at a small random upward angle toward a random
   * side, regardless of the selected club's direction. A clean shot just applies
   * the accuracy angle offset to the normal power/aim launch.
   */
  resolveLaunch(res: Extract<HitResult, { fired: true }>): { vx: number; vy: number } {
    if (res.duff) {
      // Duff: 20% of the power the player actually set, launched 15° above the
      // horizontal to a random side (screen/world y-down: negative vy = up).
      const powerPct = clamp(res.powerPct, 0, 100) * DUFF_POWER_FRACTION
      const speed = CLUB_MAX_SPEED[this.club] * powerPct / 100
        * (this.inBunker ? CLUB_BUNKER_PENALTY[this.club] : 1)
      const side = Math.random() < 0.5 ? -1 : 1
      const a = (DUFF_ANGLE_DEG * Math.PI) / 180
      return { vx: side * Math.cos(a) * speed, vy: -Math.sin(a) * speed }
    }
    return this.getLaunchVelocity(res.powerPct, res.accuracyOffsetRad)
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
