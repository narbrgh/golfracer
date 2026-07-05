// Client-side access to the server's in-memory online rooms. The room browser
// reads the list over HTTP; creating/joining a room and all in-room actions go
// over the /lobby WebSocket (see lobbyNet.ts). Rooms are ephemeral.
function getApiBase(): string {
  const envUrl = (import.meta as any).env?.VITE_API_URL as string | undefined
  if (envUrl && envUrl.trim().length > 0) return envUrl
  return `${window.location.protocol}//api.golfracer.com`
}
const BASE = getApiBase()

export interface RoomSummary {
  id: string
  name: string
  playerCount: number
  maxPlayers: number
  status: string
  createdAtUnix: number
}

export async function listRooms(): Promise<RoomSummary[]> {
  const r = await fetch(`${BASE}/rooms`)
  if (!r.ok) throw new Error(`list rooms: ${r.status}`)
  return r.json()
}
