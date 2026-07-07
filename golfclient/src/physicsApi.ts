// Client-side access to the server's live, session-only physics tunables (the
// "Ken" debug menu). Nothing here is persisted to disk — the server just holds
// these in memory, so a restart resets to PhysicsTunables defaults.
function getApiBase(): string {
  const envUrl = (import.meta as any).env?.VITE_API_URL as string | undefined
  if (envUrl && envUrl.trim().length > 0) return envUrl
  return `${window.location.protocol}//api.golfracer.com`
}
const BASE = getApiBase()

export interface PhysicsTunables {
  gravity: number
  groundRestitution: number
  bounceFriction: number
  wallRestitution: number
  rollingFriction: number
  staticFriction: number
  restSpeedThreshold: number
  bunkerFriction: number
  driverPenalty: number
  wedgePenalty: number
  putterPenalty: number
  airDrag: number
  windMphScale: number
  spinMagnus: number
  spinLandingBite: number
  windOverrideOn: number
  windOverrideMph: number
}

export interface PhysicsConfig {
  current: PhysicsTunables
  defaults: PhysicsTunables
}

export async function getPhysicsConfig(): Promise<PhysicsConfig> {
  const r = await fetch(`${BASE}/physics/config`)
  if (!r.ok) throw new Error(`get physics config: ${r.status}`)
  return r.json()
}

export async function setPhysicsConfig(t: PhysicsTunables): Promise<PhysicsTunables> {
  const r = await fetch(`${BASE}/physics/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  })
  if (!r.ok) throw new Error(`set physics config: ${r.status} ${await r.text()}`)
  return r.json()
}
