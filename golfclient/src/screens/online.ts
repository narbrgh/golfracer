import './online.css'
import type { Screen } from './screenManager'

export interface OnlineMenuHandlers {
  /** Called with the typed room name when the create modal is confirmed. */
  onCreateRoom: (name: string) => void
  onJoinBrowser: () => void
  onBack: () => void
}

// The Online hub: Create Room (opens a name modal) or Join Room (rooms browser).
export function createOnlineMenu(handlers: OnlineMenuHandlers): Screen {
  let modal!: HTMLElement
  const closeModal = () => { modal.hidden = true }

  return {
    id: 'online',
    mount() {
      const root = document.createElement('div')
      root.className = 'screen online-screen'
      root.innerHTML = `
        <div class="ol-frame">
          <h1 class="ol-title">Online</h1>
          <div class="ol-buttons">
            <button class="mm-btn ol-create" type="button" data-action="create">Create Room</button>
            <button class="mm-btn ol-join" type="button" data-action="join">Join Room</button>
            <button class="ol-back" type="button" data-action="back">← Back</button>
          </div>
        </div>
        <div class="ol-modal" data-modal hidden>
          <div class="ol-modal-card">
            <h2>Create Room</h2>
            <input class="ol-input" type="text" maxlength="24" placeholder="Room name" data-name-input />
            <div class="ol-modal-actions">
              <button class="ol-cancel" type="button" data-modal-cancel>Cancel</button>
              <button class="mm-btn ol-confirm" type="button" data-modal-confirm>Create</button>
            </div>
          </div>
        </div>`

      modal = root.querySelector<HTMLElement>('[data-modal]')!
      const input = root.querySelector<HTMLInputElement>('[data-name-input]')!
      const openModal = () => { modal.hidden = false; input.value = ''; input.focus() }
      const confirm = () => { const name = input.value.trim(); closeModal(); handlers.onCreateRoom(name) }

      root.querySelector('[data-action="create"]')!.addEventListener('click', openModal)
      root.querySelector('[data-action="join"]')!.addEventListener('click', handlers.onJoinBrowser)
      root.querySelector('[data-action="back"]')!.addEventListener('click', handlers.onBack)
      root.querySelector('[data-modal-cancel]')!.addEventListener('click', closeModal)
      root.querySelector('[data-modal-confirm]')!.addEventListener('click', confirm)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirm()
        else if (e.key === 'Escape') closeModal()
      })
      // Click on the dimmed backdrop (not the card) closes.
      modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
      return root
    },
    onEnter() {
      closeModal() // reset modal state whenever we return to this screen
    },
  }
}
