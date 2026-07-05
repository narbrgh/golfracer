export interface CourseTheme {
  skyTop: string       // hex — sky gradient top
  skyBottom: string    // hex — sky gradient bottom
  mountain1: string    // hex — far/back mountains
  mountain1Y: number   // baseline Y as fraction of worldH (0=top, 1=bottom)
  mountain2: string    // hex — near/front mountains
  mountain2Y: number   // baseline Y as fraction of worldH
  groundFill: string   // hex — terrain fill
  groundLine: string   // hex — terrain edge line
  groundLineW: number
  waterFill: string    // hex — water body fill
  waterLineW: number
  waterLine: string    // hex — water surface line
  sunColor: string     // hex — sun core
  sunRing1: string     // hex — inner glow ring
  sunRing2: string     // hex — outer glow ring
  sunSize: number      // px radius of sun core
}

export const DEFAULT_THEME: CourseTheme = {
  skyTop:     '#07071a',
  skyBottom:  '#111125',
  mountain1:  '#1c1c30',
  mountain1Y: 0.45,
  mountain2:  '#252540',
  mountain2Y: 0.58,
  groundFill: '#252515',
  groundLine: '#667755',
  groundLineW: 2,
  waterFill:  '#1655e1',
  waterLineW:  1.5,
  waterLine:  '#96d2ff',
  sunColor:   '#ffe9b8',
  sunRing1:   '#ffd27a',
  sunRing2:   '#ffd27a',
  sunSize:    32,
}

// Convert a #RRGGBB hex color to an rgba() string with the given alpha.
export function hexWithAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ---- Spline terrain ----

export interface ControlPoint { x: number; y: number }

export interface SplineCoeff {
  x0: number; x1: number
  a: number; b: number; c: number; d: number
}

// Catmull-Rom spline. Phantom endpoints are reflected so the curve passes
// through the first and last control points without clamping.
// Neutral Base-Y reference for spline terrain. Splines are authored as absolute
// control-point Y values; treating BaseGround as an offset from this reference lets
// the Base Y slider raise/lower the whole spline (and spline+wave) terrain, just
// like it already does for waves. Equal to the default hole's baseGround so
// existing courses at the default render identically. Must match the server
// (terrain.SplineBaseRef in golfserver/terrain/terrain.go).
export const SPLINE_BASE_REF = 650

// Vertical offset that Base Y applies to all authored-absolute geometry — spline
// control points, bunker rims, and water level — so they shift together with the
// terrain when the Base Y slider moves. (Wave terrain already bakes in baseGround.)
export function baseOffset(h: { baseGround: number }): number {
  return h.baseGround - SPLINE_BASE_REF
}

// Bunker rim spline coefficients, shifted by the hole's Base-Y offset so the sand
// rim tracks the terrain. Used by every renderer + the physics build.
export function bunkerRimCoeffs(h: { baseGround: number }, topEdge: ControlPoint[]): SplineCoeff[] {
  const off = baseOffset(h)
  return buildSpline(topEdge.map((p) => ({ x: p.x, y: p.y + off })))
}

export function buildSpline(pts: ControlPoint[]): SplineCoeff[] {
  if (pts.length < 2) return []
  const p = [...pts].sort((a, b) => a.x - b.x)
  const n = p.length
  const out: SplineCoeff[] = []
  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0     ? p[i-1].y : 2*p[0].y   - p[1].y
    const p1 = p[i].y
    const p2 = p[i+1].y
    const p3 = i < n - 2 ? p[i+2].y : 2*p[n-1].y - p[n-2].y
    out.push({
      x0: p[i].x, x1: p[i+1].x,
      a: p1,
      b: 0.5 * (-p0 + p2),
      c: 0.5 * (2*p0 - 5*p1 + 4*p2 - p3),
      d: 0.5 * (-p0 + 3*p1 - 3*p2 + p3),
    })
  }
  return out
}

export function splineY(x: number, coeffs: SplineCoeff[]): number {
  if (coeffs.length === 0) return 650
  let s = coeffs[0]
  for (let i = 0; i < coeffs.length; i++) {
    s = coeffs[i]
    if (x <= s.x1 || i === coeffs.length - 1) break
  }
  const t = s.x1 === s.x0 ? 0 : (x - s.x0) / (s.x1 - s.x0)
  return s.a + t*(s.b + t*(s.c + t*s.d))
}

export function splineSlope(x: number, coeffs: SplineCoeff[]): number {
  if (coeffs.length === 0) return 0
  let s = coeffs[0]
  for (let i = 0; i < coeffs.length; i++) {
    s = coeffs[i]
    if (x <= s.x1 || i === coeffs.length - 1) break
  }
  const h = s.x1 - s.x0
  if (h === 0) return 0
  const t = (x - s.x0) / h
  return (s.b + t*(2*s.c + t*3*s.d)) / h
}

// ---- Wave terrain ----

export interface TerrainWave {
  amplitude: number
  period: number
  phase: number
}

export interface TerrainSegment {
  length: number
  waves: TerrainWave[]
}

export type HazardKind = 'water' | 'sand' | 'tree'  // 'sand'/'tree' are legacy; bunkers replace them

// ---- Bunkers ----

export interface Bunker {
  topEdge: Pt[]           // Catmull-Rom control points for the rim (sorted by x)
}

// ---- Platforms ----

export interface Pt { x: number; y: number }

export interface Platform {
  points: Pt[]
  zOrder: 'front' | 'back'  // front = above terrain, back = behind terrain
  fillColor: string
  edgeColor: string
}

// Signed area of a polygon in screen/Y-down coordinates.
// Positive → clockwise (CW) on screen, which is what NewEdge expects for
// correct outward normals (right-perpendicular of each edge direction).
export function polySignedArea(pts: Pt[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

// Returns pts in CW order (positive signed area) so physics normals are correct.
export function ensureCW(pts: Pt[]): Pt[] {
  return polySignedArea(pts) >= 0 ? pts : [...pts].reverse()
}

// Point-in-polygon test (ray casting).
export function pointInPoly(x: number, y: number, pts: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// A hazard is positioned in world coordinates and lives on the Course so it's
// editable and saved/loaded with the map.
//
// Water is a flood-fill: the player shapes a valley in the terrain, drops an
// anchor at `cx` somewhere inside it, and `level` is the water-surface Y the
// valley fills up to. The body spreads left/right from the anchor until the
// ground rises above `level`, and fills between the terrain and the surface — so
// it always conforms to the land instead of being a floating box. `w`/`h` are
// unused for water; sand uses `w` (footprint) and `h` (mound height); trees use
// `h` (height).
export interface Hazard {
  kind: HazardKind
  cx: number
  w: number
  h: number
  level?: number
}

// Walks outward from `cx` to find where the terrain rises above `level` on
// each side — the pool's banks. Returns null if `cx` isn't actually underwater
// at `level` (ground there sits above the surface), which means the trap is
// misplaced and should render/collide as nothing rather than a phantom pool.
export function waterPoolBounds(
  cx: number,
  level: number,
  ptY: (x: number) => number,
  worldW: number,
  step = 4,
): { left: number; right: number } | null {
  if (ptY(cx) < level) return null

  let left = cx
  while (left - step >= 0 && ptY(left - step) >= level) left -= step
  if (left - step >= 0) {
    const yA = ptY(left), yB = ptY(left - step)
    left -= ((level - yA) / (yB - yA)) * step
  } else {
    left = 0
  }

  let right = cx
  while (right + step <= worldW && ptY(right + step) >= level) right += step
  if (right + step <= worldW) {
    const yA = ptY(right), yB = ptY(right + step)
    right += ((level - yA) / (yB - yA)) * step
  } else {
    right = worldW
  }

  return { left, right }
}

// A Hole is a single self-contained playable hole (formerly named Course — a
// "course" in the old single-hole code was really one hole). A Course is now an
// ordered list of Holes; rendering and physics are per-hole.
export interface Hole {
  name?: string
  par?: number
  worldW: number
  worldH: number
  baseGround: number
  teeBackX: number
  teeForwardX: number
  holeX: number
  useSpline: boolean
  controlPoints: ControlPoint[]
  useWaves: boolean
  segments: TerrainSegment[]
  hazards: Hazard[]
  bunkers: Bunker[]
  platforms: Platform[]
  theme: CourseTheme
}

// The format version this client authors. Migration of older files happens
// server-side at load time, so the client only ever receives current-format
// courses; this constant is what it stamps on new/edited courses it saves.
export const CURRENT_FORMAT_VERSION = 1

// A Course is the multi-hole unit stored as one file on the server.
export interface Course {
  formatVersion: number
  id: string
  name: string
  holes: Hole[]
}

// Precomputed segment — startX and offset are derived for height continuity at joints.
export interface BuiltSegment {
  startX: number
  length: number
  waves: TerrainWave[]
  offset: number  // vertical shift so terrainY(startX) == previous segment's end Y
}

// Build segments from a Course, computing startX and offset for each so adjacent
// segments always connect at exactly the same height (C0 continuity, slope may kink).
export function buildSegments(course: Hole): BuiltSegment[] {
  let curX = 0
  let curY = course.baseGround
  return course.segments.map(seg => {
    // At localX=0: waveSum = Σ(amp·sin(phase))
    const atStart = seg.waves.reduce((s, w) => s + w.amplitude * Math.sin(w.phase), 0)
    const offset = curY - atStart
    // End Y for the next segment's base
    const atEnd = seg.waves.reduce((s, w) =>
      s + w.amplitude * Math.sin(seg.length / w.period + w.phase), 0)
    curY = offset + atEnd
    const built: BuiltSegment = { startX: curX, length: seg.length, waves: seg.waves, offset }
    curX += seg.length
    return built
  })
}

export function terrainY(x: number, segs: BuiltSegment[]): number {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (x < s.startX + s.length || i === segs.length - 1) {
      const lx = x - s.startX
      return s.offset + s.waves.reduce((acc, w) =>
        acc + w.amplitude * Math.sin(lx / w.period + w.phase), 0)
    }
  }
  return segs[0]?.offset ?? 650
}

export function terrainSlope(x: number, segs: BuiltSegment[]): number {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (x < s.startX + s.length || i === segs.length - 1) {
      const lx = x - s.startX
      return s.waves.reduce((acc, w) =>
        acc + (w.amplitude / w.period) * Math.cos(lx / w.period + w.phase), 0)
    }
  }
  return 0
}

// Default hole: single segment replicating the original 3-sinusoid formula exactly.
export const DEFAULT_HOLE: Hole = {
  worldW: 4000,
  worldH: 1000,
  baseGround: 650,
  teeBackX: 200,
  teeForwardX: 400,
  holeX: 3700,
  useSpline: false,
  controlPoints: [
    { x: 0,    y: 650 },
    { x: 700,  y: 570 },
    { x: 1400, y: 710 },
    { x: 2100, y: 625 },
    { x: 2800, y: 695 },
    { x: 3500, y: 610 },
    { x: 4000, y: 650 },
  ],
  useWaves: true,
  segments: [{
    length: 4000,
    waves: [
      { amplitude: 80, period: 800, phase: 0 },
      { amplitude: 40, period: 300, phase: 0 },
      { amplitude: 20, period: 150, phase: 0 },
    ]
  }],
  hazards: [
    { kind: 'water', cx: 2080, w: 0, h: 0, level: 715 },
  ],
  bunkers: [],
  platforms: [],
  // Own copy, not the shared DEFAULT_THEME reference — otherwise a hole that ends
  // up aliasing this object could mutate the global default in place.
  theme: { ...DEFAULT_THEME },
}
