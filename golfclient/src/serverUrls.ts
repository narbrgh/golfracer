// Where the Go server lives. One place for every REST and WebSocket caller.
//
// - Explicit VITE_API_URL / VITE_WS_URL always win (the e2e suite sets both).
// - `npm run dev` (Vite dev server) defaults to a server on the SAME HOST at :8081,
//   i.e. `go run .` in golfserver/ — so local work never silently talks to
//   production. Using the page's hostname (not "localhost") also lets a phone on
//   your LAN load the dev client and still reach your laptop's server.
// - Production builds default to api.golfracer.com.
const env = (import.meta as any).env as Record<string, unknown> | undefined

function override(name: string): string | undefined {
  const v = env?.[name]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

const LOCAL_SERVER_PORT = 8081 // golfserver main.go listenAddr

/** HTTP base URL of the Go server (no trailing slash). */
export function apiBase(): string {
  const o = override('VITE_API_URL')
  if (o) return o
  if (env?.DEV) return `${window.location.protocol}//${window.location.hostname}:${LOCAL_SERVER_PORT}`
  return `${window.location.protocol}//api.golfracer.com`
}

/** WebSocket URL of the single-player `/ws` endpoint (lobby callers swap in `/lobby`). */
export function wsUrl(): string {
  const o = override('VITE_WS_URL')
  if (o) return o
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  if (env?.DEV) return `${wsProtocol}//${window.location.hostname}:${LOCAL_SERVER_PORT}/ws`
  return `${wsProtocol}//api.golfracer.com/ws`
}
