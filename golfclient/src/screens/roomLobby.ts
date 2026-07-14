import './roomLobby.css'
import type { Screen } from './screenManager'
import type { RoomState, LobbyPlayer } from '../lobbyNet'
import type { CourseInfo } from '../courseapi'

// Ball color palette — must match rooms.BallColors order on the server.
export const BALL_COLORS: { id: string; hex: string }[] = [
  { id: 'white', hex: '#f4f1e0' },
  { id: 'green', hex: '#4bbf73' },
  { id: 'teal', hex: '#33a89c' },
  { id: 'blue', hex: '#2f79c2' },
  { id: 'orange', hex: '#ec8f34' },
  { id: 'red', hex: '#d23f2e' },
  { id: 'yellow', hex: '#f4bd3d' },
  { id: 'pink', hex: '#e05aa0' },
]
export const colorHex = (id: string) => BALL_COLORS.find((c) => c.id === id)?.hex ?? '#ccc'

// One-line explainer per game mode, shown under the 2x2 grid. Keys must match the
// server's validVictory values (rooms.go).
const MODE_DESC: Record<string, string> = {
  'speed-match': 'Race each hole — fastest to sink wins it. Most rank points across the round takes the match.',
  'speed-total': 'Lowest total time across every hole wins.',
  'strokes-match': 'Win each hole with the fewest shots. Most rank points across the round takes the match.',
  'strokes-total': 'Fewest total shots across every hole wins.',
}

export interface RoomLobbyHandlers {
  onSetName: (name: string) => void
  onSetColor: (color: string) => void
  onSetReady: (ready: boolean) => void
  onSetSpectator: (spectator: boolean) => void
  onChat: (text: string) => void
  onSetCourse: (courseId: string) => void
  onSetVictory: (victory: string) => void
  onStart: () => void
  onLeave: () => void
}

export interface RoomLobbyScreen extends Screen {
  setMyId(id: number): void
  setState(state: RoomState): void
  setCourses(courses: CourseInfo[]): void
  appendChat(name: string, text: string): void
}

export function createRoomLobby(handlers: RoomLobbyHandlers): RoomLobbyScreen {
  let myId: number | null = null
  let state: RoomState | null = null
  let courses: CourseInfo[] = []

  // Element refs (assigned in mount).
  let els!: {
    roomName: HTMLElement
    colors: HTMLElement
    courses: HTMLElement
    victory: HTMLElement
    victoryDesc: HTMLElement
    playersLabel: HTMLElement
    players: HTMLElement
    ready: HTMLButtonElement
    start: HTMLButtonElement
    myName: HTMLElement
    nameInput: HTMLInputElement
    chatLog: HTMLElement
    chatInput: HTMLInputElement
  }

  const me = (): LobbyPlayer | undefined =>
    myId == null ? undefined : state?.players.find((p) => p.id === myId)
  const iAmHost = (): boolean => !!state && myId != null && state.hostId === myId

  function render(): void {
    if (!state) return
    els.roomName.textContent = state.name

    // --- ball colors + spectator toggle ---
    // Picking a color makes you a player (claims a slot); picking Spectator frees
    // your slot. When you're already a spectator and all player slots are full,
    // the color swatches are disabled (no slot to claim).
    const iSpectate = !!me()?.spectator
    const noPlayerSlot = state.playerCount >= state.maxPlayers && iSpectate
    const mine = me()?.color
    const takenByOthers = new Set(
      state.players.filter((p) => p.id !== myId && !p.spectator).map((p) => p.color),
    )
    els.colors.innerHTML = ''
    for (const c of BALL_COLORS) {
      const btn = document.createElement('button')
      btn.className = 'swatch'
      btn.style.background = c.hex
      const selected = !iSpectate && c.id === mine
      const taken = takenByOthers.has(c.id)
      btn.classList.toggle('selected', selected)
      btn.classList.toggle('taken', taken && !selected)
      btn.disabled = (taken && !selected) || noPlayerSlot
      btn.title = noPlayerSlot ? 'All player slots are taken' : c.id
      if (!btn.disabled) btn.addEventListener('click', () => handlers.onSetColor(c.id))
      els.colors.appendChild(btn)
    }
    // Spectator swatch — selecting it drops your player slot.
    const spec = document.createElement('button')
    spec.className = 'swatch spectate-swatch'
    spec.textContent = '👁'
    spec.classList.toggle('selected', iSpectate)
    spec.title = 'Spectate'
    spec.addEventListener('click', () => handlers.onSetSpectator(!iSpectate))
    els.colors.appendChild(spec)

    // --- course list (host selects; others read-only) ---
    const host = iAmHost()
    els.courses.innerHTML = ''
    if (courses.length === 0) {
      els.courses.innerHTML = `<div class="lobby-empty">No courses available.</div>`
    } else {
      for (const co of courses) {
        const row = document.createElement('button')
        row.className = 'course-item'
        row.classList.toggle('selected', co.id === state.courseId)
        row.disabled = !host
        row.innerHTML = `<span class="course-name"></span><span class="course-holes">${co.holeCount} holes</span>`
        row.querySelector('.course-name')!.textContent = co.name
        if (host) row.addEventListener('click', () => handlers.onSetCourse(co.id))
        els.courses.appendChild(row)
      }
    }

    // --- game mode (2x2: metric x scope) ---
    for (const btn of Array.from(els.victory.querySelectorAll<HTMLButtonElement>('[data-vic]'))) {
      btn.classList.toggle('selected', btn.dataset.vic === state.victory)
      btn.disabled = !host
    }
    els.victoryDesc.textContent = MODE_DESC[state.victory] ?? ''

    // --- players list ---
    // Spectators show an eye badge and no ready state (and no ball dot); players
    // show their color dot and ready status.
    els.playersLabel.textContent = `Players (${state.playerCount}/${state.maxPlayers})`
    els.players.innerHTML = ''
    for (const p of state.players) {
      const row = document.createElement('div')
      row.className = 'player-row'
      const label = p.name && p.name.trim() ? p.name : `Player ${p.id}`
      const status = p.spectator
        ? '<span class="player-spectating">👁 Spectating</span>'
        : `<span class="player-ready ${p.ready ? 'is-ready' : ''}">${p.ready ? '✔ Ready' : '…'}</span>`
      row.innerHTML = `
        <span class="player-dot" style="background:${p.spectator ? 'transparent' : colorHex(p.color)}"></span>
        <span class="player-name"></span>
        ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
        ${status}`
      row.querySelector('.player-name')!.textContent = label + (p.id === myId ? ' (you)' : '')
      els.players.appendChild(row)
    }

    // --- ready button (players only; spectators have nothing to ready up) ---
    els.ready.style.display = iSpectate ? 'none' : ''
    const myReady = !!me()?.ready
    els.ready.classList.toggle('selected', myReady)
    els.ready.textContent = myReady ? 'Ready ✔' : 'Ready'

    // --- start button (host only) ---
    els.start.style.display = host ? '' : 'none'
    els.start.disabled = !state.canStart

    // --- my name ---
    els.myName.textContent = me()?.name ?? ''
  }

  return {
    id: 'roomLobby',
    mount() {
      const root = document.createElement('div')
      root.className = 'screen room-lobby'
      root.innerHTML = `
        <div class="lobby-shell">
          <div class="lobby-stripes"></div>
          <div class="lobby-head">
            <h1 class="lobby-title" data-room-name>Room</h1>
            <button class="lobby-leave" type="button" data-leave>← Leave Room</button>
          </div>
          <div class="lobby-grid">
            <div class="lobby-col">
              <section class="lobby-section">
                <div class="lobby-label">Ball Color</div>
                <div class="color-grid" data-colors></div>
              </section>
              <section class="lobby-section">
                <div class="lobby-label">Course</div>
                <div class="course-list" data-courses></div>
              </section>
              <section class="lobby-section">
                <div class="lobby-label">Game Mode</div>
                <div class="mode-grid" data-victory>
                  <button class="mode-btn" type="button" data-vic="speed-match">Speed · Match</button>
                  <button class="mode-btn" type="button" data-vic="speed-total">Speed · Total</button>
                  <button class="mode-btn" type="button" data-vic="strokes-match">Strokes · Match</button>
                  <button class="mode-btn" type="button" data-vic="strokes-total">Strokes · Total</button>
                </div>
                <div class="mode-desc" data-victory-desc></div>
              </section>
            </div>
            <div class="lobby-col">
              <section class="lobby-section">
                <div class="lobby-label" data-players-label>Players</div>
                <div class="players-list" data-players></div>
              </section>
              <div class="name-row">
                <span class="name-display" data-my-name>Player</span>
                <input class="lobby-input" type="text" maxlength="16" placeholder="Your name" data-name-input />
                <button class="chip" type="button" data-name-set>Set</button>
              </div>
              <section class="chat-section">
                <div class="lobby-label">Chat</div>
                <div class="chat-log" data-chat-log></div>
                <div class="chat-row">
                  <input class="lobby-input" type="text" placeholder="Type message…" data-chat-input />
                  <button class="chip" type="button" data-chat-send>Send</button>
                </div>
              </section>
            </div>
          </div>
          <div class="lobby-actions">
            <button class="ready-btn" type="button" data-ready>Ready</button>
            <button class="start-btn" type="button" data-start>Start Game</button>
          </div>
        </div>`

      const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
      els = {
        roomName: q('[data-room-name]'),
        colors: q('[data-colors]'),
        courses: q('[data-courses]'),
        victory: q('[data-victory]'),
        victoryDesc: q('[data-victory-desc]'),
        playersLabel: q('[data-players-label]'),
        players: q('[data-players]'),
        ready: q<HTMLButtonElement>('[data-ready]'),
        start: q<HTMLButtonElement>('[data-start]'),
        myName: q('[data-my-name]'),
        nameInput: q<HTMLInputElement>('[data-name-input]'),
        chatLog: q('[data-chat-log]'),
        chatInput: q<HTMLInputElement>('[data-chat-input]'),
      }

      q('[data-leave]').addEventListener('click', handlers.onLeave)
      els.ready.addEventListener('click', () => handlers.onSetReady(!me()?.ready))
      els.start.addEventListener('click', () => handlers.onStart())
      for (const btn of Array.from(els.victory.querySelectorAll<HTMLButtonElement>('[data-vic]'))) {
        btn.addEventListener('click', () => handlers.onSetVictory(btn.dataset.vic!))
      }
      const submitName = () => {
        const name = els.nameInput.value.trim()
        if (name) handlers.onSetName(name)
        els.nameInput.value = ''
      }
      q('[data-name-set]').addEventListener('click', submitName)
      els.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName() })
      const submitChat = () => {
        const text = els.chatInput.value.trim()
        if (text) handlers.onChat(text)
        els.chatInput.value = ''
      }
      q('[data-chat-send]').addEventListener('click', submitChat)
      els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitChat() })

      return root
    },
    onExit() {
      if (els) els.chatLog.innerHTML = '' // fresh chat on next room
    },
    setMyId(id) {
      myId = id
      render()
    },
    setState(s) {
      state = s
      render()
    },
    setCourses(list) {
      courses = list
      render()
    },
    appendChat(name, text) {
      const row = document.createElement('div')
      row.className = 'chat-line'
      const who = document.createElement('span')
      who.className = 'chat-who'
      who.textContent = name + ': '
      row.appendChild(who)
      row.appendChild(document.createTextNode(text))
      els.chatLog.appendChild(row)
      els.chatLog.scrollTop = els.chatLog.scrollHeight
    },
  }
}
