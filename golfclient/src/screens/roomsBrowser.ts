import './online.css'
import type { Screen } from './screenManager'
import type { RoomSummary } from '../roomsapi'

export interface RoomsBrowserHandlers {
  onJoin: (room: RoomSummary) => void
  /** Ask the app to (re)fetch rooms and call setRooms/setError. */
  onRefresh: () => void
  onBack: () => void
}

// A rooms browser screen that also exposes setRooms/setError so the app can push
// fetched data into it (the screen itself stays transport-agnostic).
export interface RoomsBrowserScreen extends Screen {
  setRooms(rooms: RoomSummary[]): void
  setError(msg: string): void
}

export function createRoomsBrowser(handlers: RoomsBrowserHandlers): RoomsBrowserScreen {
  let listEl!: HTMLElement
  let errEl!: HTMLElement

  return {
    id: 'rooms',
    mount() {
      const root = document.createElement('div')
      root.className = 'screen rooms-screen'
      root.innerHTML = `
        <div class="rb-frame">
          <div class="rb-head">
            <h1 class="ol-title">Join Room</h1>
            <button class="rb-refresh" type="button" data-refresh>Refresh</button>
          </div>
          <div class="rb-list" data-list></div>
          <p class="rb-error" data-error></p>
          <button class="ol-back" type="button" data-back>← Back</button>
        </div>`
      listEl = root.querySelector<HTMLElement>('[data-list]')!
      errEl = root.querySelector<HTMLElement>('[data-error]')!
      root.querySelector('[data-refresh]')!.addEventListener('click', () => {
        errEl.textContent = ''
        handlers.onRefresh()
      })
      root.querySelector('[data-back]')!.addEventListener('click', handlers.onBack)
      return root
    },
    onEnter() {
      errEl.textContent = ''
      handlers.onRefresh()
    },
    setRooms(rooms) {
      listEl.innerHTML = ''
      if (rooms.length === 0) {
        listEl.innerHTML = `<div class="rb-empty">No rooms yet. Create one!</div>`
        return
      }
      for (const room of rooms) {
        const canJoin = room.status === 'open'
        const row = document.createElement('div')
        row.className = 'rb-row'
        row.innerHTML = `
          <span class="rb-name">${escapeHtml(room.name)}</span>
          <span class="rb-count">${room.playerCount}/${room.maxPlayers}</span>
          <span class="rb-status">${room.status === 'open' ? 'Open' : escapeHtml(room.status)}</span>
          <button class="rb-join" type="button" ${canJoin ? '' : 'disabled'}>Join</button>`
        row.querySelector('button')!.addEventListener('click', () => handlers.onJoin(room))
        listEl.appendChild(row)
      }
    },
    setError(msg) {
      errEl.textContent = msg
    },
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
