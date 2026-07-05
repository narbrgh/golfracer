// Client-side access to the server's course files (dev-local disk storage).
// The server is the single source of truth; there is no localStorage fallback.
// Migration of old files happens server-side, so everything returned here is
// already current-format.
import type { Course, Hole } from './terrain'
import { DEFAULT_HOLE, CURRENT_FORMAT_VERSION } from './terrain'

// HTTP base for the Go server. The WebSocket uses the same origin.
function getApiBase(): string {
  const envUrl = (import.meta as any).env?.VITE_API_URL as string | undefined
  if (envUrl && envUrl.trim().length > 0) return envUrl
  return `${window.location.protocol}//api.golfracer.com`
}
const BASE = getApiBase()

export interface CourseInfo {
  id: string
  name: string
  holeCount: number
}

export async function listCourses(): Promise<CourseInfo[]> {
  const r = await fetch(`${BASE}/courses`)
  if (!r.ok) throw new Error(`list courses: ${r.status}`)
  return r.json()
}

export async function getCourse(id: string): Promise<Course> {
  const r = await fetch(`${BASE}/courses/${encodeURIComponent(id)}`)
  if (!r.ok) throw new Error(`get course ${id}: ${r.status}`)
  return r.json()
}

export async function saveCourse(c: Course): Promise<Course> {
  const r = await fetch(`${BASE}/courses/${encodeURIComponent(c.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(c),
  })
  if (!r.ok) throw new Error(`save course ${c.id}: ${r.status} ${await r.text()}`)
  return r.json()
}

// newHole returns a fresh deep copy of the default hole (never share the
// DEFAULT_HOLE reference — holes are mutated in place by the editor).
export function newHole(): Hole {
  return structuredClone(DEFAULT_HOLE)
}

// newCourse builds a one-hole course with the given identity.
export function newCourse(id: string, name: string): Course {
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    id,
    name,
    holes: [newHole()],
  }
}
