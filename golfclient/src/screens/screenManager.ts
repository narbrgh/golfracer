// A minimal screen/state manager: registers named screens, shows exactly one at a
// time, and fires enter/exit hooks. Screens build their DOM lazily on first show
// (so heavy screens like the game don't construct until entered) and are then kept
// around and toggled via `display` — the same overlay pattern Botonoids uses, but
// generic and driven by an explicit id instead of a phase enum.

export interface Screen {
  readonly id: string
  /** Build and return the screen's root element. Called once, on first show. */
  mount(): HTMLElement
  /** Called every time the screen becomes visible. `params` come from show(). */
  onEnter?(params?: unknown): void
  /** Called when navigating away from this screen. */
  onExit?(): void
}

export class ScreenManager {
  private readonly screens = new Map<string, Screen>()
  private readonly roots = new Map<string, HTMLElement>()
  private currentId: string | null = null
  private previousId: string | null = null
  private readonly host: HTMLElement

  constructor(host: HTMLElement) {
    this.host = host
  }

  register(screen: Screen): void {
    if (this.screens.has(screen.id)) throw new Error(`duplicate screen id: ${screen.id}`)
    this.screens.set(screen.id, screen)
  }

  get current(): string | null {
    return this.currentId
  }

  show(id: string, params?: unknown): void {
    const screen = this.screens.get(id)
    if (!screen) throw new Error(`unknown screen: ${id}`)

    // Re-entering the current screen just re-fires onEnter (e.g. Map Editor while
    // already on the game screen), without a redundant exit/hide/show cycle.
    if (this.currentId === id) {
      screen.onEnter?.(params)
      return
    }

    if (this.currentId) {
      const cur = this.screens.get(this.currentId)!
      cur.onExit?.()
      this.roots.get(this.currentId)!.style.display = 'none'
      this.previousId = this.currentId
    }

    let root = this.roots.get(id)
    if (!root) {
      root = screen.mount()
      this.host.appendChild(root)
      this.roots.set(id, root)
    }
    root.style.display = ''
    this.currentId = id
    screen.onEnter?.(params)
  }

  back(): void {
    if (this.previousId) {
      this.show(this.previousId)
    }
  }
}
