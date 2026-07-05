import './app.css'
import { ScreenManager } from './screens/screenManager'
import { createMainMenu, incrementBuildNumber } from './screens/mainMenu'
import { createOnlineMenu } from './screens/online'
import { createRoomsBrowser } from './screens/roomsBrowser'
import { createRoomLobby } from './screens/roomLobby'
import { createMatchScreen } from './screens/matchScreen'
import { createKenScreen } from './screens/kenScreen'
import { mountGame } from './main'
import { listRooms } from './roomsapi'
import { listCourses } from './courseapi'
import { LobbyNet } from './lobbyNet'

const host = document.getElementById('app')
if (!host) throw new Error('#app root not found')

incrementBuildNumber()
const screens = new ScreenManager(host)

screens.register(
  createMainMenu({
    onSinglePlayer: () => screens.show('game', { openEditor: false }),
    onOnline: () => screens.show('online'),
    onEditor: () => screens.show('game', { openEditor: true }),
  }),
)

screens.register(createKenScreen({ onBack: () => screens.back() }))

// --- Game screen (Single Player / Map Editor) ---
// Mounts the existing single-player game once; later entries just toggle it back
// into view (its WebSocket + render loop keep running). `openEditor` opens the
// map-editor overlay — that's the Map Editor menu item. Navigation back to the
// main menu is now a hamburger-menu item (shared gameCamera.ts chrome), not a
// standalone corner button — that button would overlap the hole/timer HUD.
let game: { openEditor: () => void; onEnter: () => void; onExit: () => void } | null = null
screens.register({
  id: 'game',
  mount() {
    const root = document.createElement('div')
    root.className = 'screen game-screen'
    game = mountGame(root, { onBack: () => screens.show('mainMenu'), onKen: () => screens.show('ken') })
    return root
  },
  onEnter(params) {
    if ((params as { openEditor?: boolean } | undefined)?.openEditor) game?.openEditor()
    game?.onEnter()
  },
  onExit() { game?.onExit() },
})

// --- Online flow: lobby WebSocket drives create/join and all in-room actions ---
const lobby = createRoomLobby({
  onSetName: (name) => lobbyNet.setName(name),
  onSetColor: (color) => lobbyNet.setColor(color),
  onSetReady: (ready) => lobbyNet.setReady(ready),
  onChat: (text) => lobbyNet.chat(text),
  onSetCourse: (courseId) => lobbyNet.setCourse(courseId),
  onSetVictory: (victory) => lobbyNet.setVictory(victory),
  onStart: () => lobbyNet.start(),
  onLeave: () => lobbyNet.leaveRoom(),
})

const roomsBrowser = createRoomsBrowser({
  onJoin: (room) => lobbyNet.joinRoom(room.id),
  onBack: () => screens.show('online'),
  onRefresh: () => {
    listRooms()
      .then((rooms) => roomsBrowser.setRooms(rooms))
      .catch((e) => roomsBrowser.setError(String(e)))
  },
})

const match = createMatchScreen({
  onShoot: (vx, vy) => lobbyNet.shoot(vx, vy),
  onReturn: () => lobbyNet.matchReturn(),
  onLeave: () => lobbyNet.leaveRoom(),
})

screens.register(
  createOnlineMenu({
    onCreateRoom: (name) => lobbyNet.createRoom(name),
    onJoinBrowser: () => screens.show('rooms'),
    onBack: () => screens.show('mainMenu'),
  }),
)
screens.register(roomsBrowser)
screens.register(lobby)
screens.register(match)

const lobbyNet = new LobbyNet({
  onHello: (playerId) => { lobby.setMyId(playerId); match.setMyId(playerId) },
  onJoined: () => {
    screens.show('roomLobby')
    // Load the course list for the host's course picker.
    listCourses()
      .then((courses) => lobby.setCourses(courses))
      .catch((e) => console.error('course list failed:', e))
  },
  onState: (room) => lobby.setState(room),
  onChat: (name, text) => lobby.appendChat(name, text),
  onLeft: () => screens.show('online'),
  onError: (msg) => {
    // If the user is browsing rooms, surface join errors there; otherwise log.
    if (screens.current === 'rooms') roomsBrowser.setError(msg)
    else console.error('lobby error:', msg)
  },
  // Match: the first match:hole moves us onto the match screen; match:end returns.
  onMatchHole: (m) => { match.setHole(m); if (screens.current !== 'match') screens.show('match') },
  onMatchState: (m) => match.setState(m),
  onMatchLeaderboard: (m) => match.setLeaderboard(m),
  onMatchEnd: () => screens.show('roomLobby'),
})
lobbyNet.connect()

screens.show('mainMenu')
