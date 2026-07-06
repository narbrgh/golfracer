// Version info for the main-menu footer: the client build id (baked in at
// build time by vite.config.ts) and a live fetch of the server's build id
// (which doubles as an online/offline heartbeat).

// Injected by Vite's `define`. Declared here so TypeScript knows about it.
declare const __CLIENT_VERSION__: string

export const CLIENT_VERSION: string =
  typeof __CLIENT_VERSION__ === 'string' ? __CLIENT_VERSION__ : 'dev'

function getApiBase(): string {
  const envUrl = (import.meta as any).env?.VITE_API_URL as string | undefined
  if (envUrl && envUrl.trim().length > 0) return envUrl
  return `${window.location.protocol}//api.golfracer.com`
}

export interface ServerStatus {
  online: boolean
  version: string | null
}

// Fetches the server's /version. A failure (server down, network, CORS) resolves
// to { online: false } rather than throwing, so callers can render an offline
// state. A short timeout keeps the menu from hanging on a dead server.
export async function fetchServerStatus(timeoutMs = 4000): Promise<ServerStatus> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${getApiBase()}/version`, { signal: ctrl.signal })
    if (!r.ok) return { online: false, version: null }
    const body = await r.json()
    return { online: true, version: String(body.version ?? 'unknown') }
  } catch {
    return { online: false, version: null }
  } finally {
    clearTimeout(t)
  }
}
