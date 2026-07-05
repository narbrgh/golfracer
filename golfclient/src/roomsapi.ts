// Client-side access to the server's in-memory online rooms. The room browser
// reads the list over HTTP; creating/joining a room and all in-room actions go
// over the /lobby WebSocket (see lobbyNet.ts). Rooms are ephemeral.
const BASE = 'http://localhost:8080'

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
