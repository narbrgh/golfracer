import './app.css'
import { ScreenManager, type Screen } from './screens/screenManager'
import { createMainMenu } from './screens/mainMenu'
import { mountGame } from './main'

const host = document.getElementById('app')
if (!host) throw new Error('#app root not found')

const screens = new ScreenManager(host)

screens.register(
  createMainMenu({
    onSinglePlayer: () => screens.show('game', { openEditor: false }),
    onOnline: () => screens.show('online'),
    onEditor: () => screens.show('game', { openEditor: true }),
  }),
)

// The game screen mounts the existing single-player game once; later entries just
// toggle it back into view (its WebSocket + render loop keep running). The
// `openEditor` param opens the map-editor overlay — that's the Map Editor menu item.
let game: { openEditor: () => void } | null = null
screens.register({
  id: 'game',
  mount() {
    const root = document.createElement('div')
    root.className = 'screen game-screen'
    const back = document.createElement('button')
    back.className = 'back-to-menu'
    back.textContent = '← Menu'
    back.addEventListener('click', () => screens.show('mainMenu'))
    root.appendChild(back)
    game = mountGame(root)
    return root
  },
  onEnter(params) {
    if ((params as { openEditor?: boolean } | undefined)?.openEditor) game?.openEditor()
  },
})

// Online isn't built yet — a placeholder until the rooms browser / lobby land.
screens.register(
  createComingSoon(
    'online',
    'Online',
    'Rooms, lobbies, and 1v1 races are coming soon.',
    () => screens.show('mainMenu'),
  ),
)

screens.show('mainMenu')

function createComingSoon(id: string, title: string, body: string, onBack: () => void): Screen {
  return {
    id,
    mount() {
      const root = document.createElement('div')
      root.className = 'screen coming-soon'
      root.innerHTML = `
        <div class="cs-card">
          <h2>${title}</h2>
          <p>${body}</p>
          <button class="cs-back" type="button">← Back to menu</button>
        </div>`
      root.querySelector<HTMLButtonElement>('.cs-back')!.addEventListener('click', onBack)
      return root
    },
  }
}
