// WebSocket client for the /lobby socket: per-client identity plus room create /
// join / leave, all in-room actions, and — once a match starts — the gameplay
// messages (match:hole/state/leaderboard/end) and shoot commands.
import type { Hole } from './terrain'

export interface MatchBall {
  playerId: number
  x: number
  y: number
  color: string
  resting: boolean
  sunk: boolean
  readyInMs: number // ms until this ball can be shot again (shot cooldown)
  penalty: boolean // the cooldown is a water penalty (draw the double ring)
  inWater: boolean // ball is currently sinking underwater (fade it out)
  shots: number // strokes taken on the current hole
  readied: boolean // clicked OK on the current intermission scorecard
  idleMsLeft: number // strokes-mode: ms until this ball idle-DNFs; 0 unless in the last 60s
  dnf: boolean // did-not-finish the current hole (idle timeout / hole cap)
}

export interface MatchState {
  phase: 'countdown' | 'playing' | 'intermission' | 'results'
  victory: string // active game mode (speed-total | speed-match | strokes-total | strokes-match)
  holeIndex: number
  holeCount: number
  phaseMsLeft: number
  interMsLeft: number // intermission auto-advance countdown (ms); 0 until armed
  interArmed: boolean // someone clicked OK, the 10s countdown is running
  holeMs: number
  balls: MatchBall[]
  wind: number // current hole wind, mph (+right / -left)
}

export interface MatchHole {
  holeIndex: number
  holeCount: number
  hole: Hole
  wind: number // current hole wind, mph (+right / -left)
}

export interface LeaderEntry {
  playerId: number
  name: string
  color: string
  totalMs: number
  matchPts: number
  totalShots: number
  holeShots: number
  holeMs: number
  dnf: boolean
  holes: HoleResult[] // per-hole record for the scorecard grid (index = hole idx)
}

export interface HoleResult {
  ms: number
  shots: number
  points: number // rank points earned this hole (Match scope; 0 otherwise)
  dnf: boolean
}

export interface MatchLeaderboard {
  final: boolean
  victory: string
  holeIndex: number
  holeCount: number
  entries: LeaderEntry[]
}

export interface LobbyPlayer {
  id: number
  name: string
  color: string
  ready: boolean
  isHost: boolean
  spectator: boolean
}

export interface RoomState {
  id: string
  name: string
  hostId: number
  status: string
  maxPlayers: number // active-player cap (4)
  maxOccupants: number // total people cap (6)
  playerCount: number // current non-spectator members
  courseId: string
  victory: string
  canStart: boolean
  players: LobbyPlayer[]
}

export interface LobbyHandlers {
  onHello?: (playerId: number) => void
  onJoined?: (roomId: string) => void
  onLeft?: () => void
  onState?: (room: RoomState) => void
  onChat?: (name: string, text: string) => void
  onError?: (msg: string) => void
  onMatchHole?: (m: MatchHole) => void
  onMatchState?: (m: MatchState) => void
  onMatchLeaderboard?: (m: MatchLeaderboard) => void
  onMatchEnd?: () => void
}

export class LobbyNet {
  private ws: WebSocket | null = null
  private readonly handlers: LobbyHandlers
  playerId: number | null = null

  constructor(handlers: LobbyHandlers) {
    this.handlers = handlers
  }

  private defaultWsUrl(): string {
    const { protocol } = window.location
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//api.golfracer.com/ws`
  }

  connect(): void {
    const envUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined
    let url = envUrl && envUrl.trim().length > 0 ? envUrl : this.defaultWsUrl()
    url = url.replace('/ws', '/lobby')
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data))
  }

  private onMessage(m: any): void {
    switch (m.type) {
      case 'hello':
        this.playerId = m.playerId
        this.handlers.onHello?.(m.playerId)
        break
      case 'room:joined':
        this.handlers.onJoined?.(m.roomId)
        break
      case 'room:left':
        this.handlers.onLeft?.()
        break
      case 'room:state':
        this.handlers.onState?.(m.room)
        break
      case 'chat':
        this.handlers.onChat?.(m.name, m.text)
        break
      case 'room:error':
        this.handlers.onError?.(m.msg)
        break
      case 'match:hole':
        this.handlers.onMatchHole?.(m)
        break
      case 'match:state':
        this.handlers.onMatchState?.(m)
        break
      case 'match:leaderboard':
        this.handlers.onMatchLeaderboard?.(m)
        break
      case 'match:end':
        this.handlers.onMatchEnd?.()
        break
    }
  }

  private send(o: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o))
  }

  createRoom(name: string): void { this.send({ type: 'roomCreate', name }) }
  joinRoom(roomId: string): void { this.send({ type: 'roomJoin', roomId }) }
  leaveRoom(): void { this.send({ type: 'roomLeave' }) }
  setName(name: string): void { this.send({ type: 'setName', name }) }
  setColor(color: string): void { this.send({ type: 'setColor', color }) }
  setReady(ready: boolean): void { this.send({ type: 'setReady', ready }) }
  setSpectator(spectator: boolean): void { this.send({ type: 'setSpectator', spectator }) }
  chat(text: string): void { this.send({ type: 'chat', text }) }
  setCourse(courseId: string): void { this.send({ type: 'setCourse', courseId }) }
  setVictory(victory: string): void { this.send({ type: 'setVictory', victory }) }
  start(): void { this.send({ type: 'start' }) }
  shoot(vx: number, vy: number, club: string, spin: string): void { this.send({ type: 'shoot', vx, vy, club, spin }) }
  matchReturn(): void { this.send({ type: 'matchReturn' }) }
  matchReady(): void { this.send({ type: 'matchReady' }) }
}
