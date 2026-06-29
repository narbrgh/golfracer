export interface CourseTheme {
  skyTop: string       // hex — sky gradient top
  skyBottom: string    // hex — sky gradient bottom
  mountain1: string    // hex — far/back mountains
  mountain2: string    // hex — near/front mountains
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
  mountain2:  '#252540',
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

export interface TerrainWave {
  amplitude: number
  period: number
  phase: number
}

export interface TerrainSegment {
  length: number
  waves: TerrainWave[]
}

export interface Course {
  worldW: number
  worldH: number
  baseGround: number
  teeBackX: number
  teeForwardX: number
  holeX: number
  segments: TerrainSegment[]
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
export function buildSegments(course: Course): BuiltSegment[] {
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

// Default course: single segment replicating the original 3-sinusoid formula exactly.
export const DEFAULT_COURSE: Course = {
  worldW: 4000,
  worldH: 1000,
  baseGround: 650,
  teeBackX: 200,
  teeForwardX: 400,
  holeX: 3700,
  segments: [{
    length: 4000,
    waves: [
      { amplitude: 80, period: 800, phase: 0 },
      { amplitude: 40, period: 300, phase: 0 },
      { amplitude: 20, period: 150, phase: 0 },
    ]
  }]
}
