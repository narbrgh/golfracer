import './mainMenu.css'
import type { Screen } from './screenManager'

export interface MainMenuHandlers {
  onSinglePlayer: () => void
  onOnline: () => void
  onEditor: () => void
}

// Retro-sunset hero, styled after the beer-can artwork: clean flat horizontal
// stripes, a warm banded sun melting into cool "sea" stripes, and the game name
// knocked out of the stripes in the cream background color. Built as one SVG so it
// scales crisply; the sun's warm bands are clipped to a circle, while the cool sea
// bands run full width across the top of the sun's lower half.
function heroSvg(): string {
  const warm: Array<[number, number, string]> = [
    [50, 95, 'var(--sun-1)'],
    [152, 44, 'var(--sun-1)'],
    [203, 42, 'var(--sun-2)'],
    [252, 38, 'var(--sun-3)'],
    [297, 32, 'var(--sun-4)'],
    [336, 26, 'var(--sun-5)'],
    [369, 20, 'var(--sun-6)'],
  ]
  const sea: Array<[number, number, string]> = [
    [396, 52, 'var(--sea-1)'],
    [455, 52, 'var(--sea-2)'],
    [514, 52, 'var(--sea-3)'],
    [573, 52, 'var(--sea-4)'],
  ]

  const warmBands = warm
    .map(([y, h, c]) => `<rect x="0" y="${y}" width="1000" height="${h}" fill="${c}" clip-path="url(#sun)"/>`)
    .join('')
  const seaBands = sea
    .map(([y, h, c]) => `<rect x="0" y="${y}" width="1000" height="${h}" fill="${c}"/>`)
    .join('')

  // Title words sit centered on the first two sea bands, filled cream so they read
  // as knocked out of the stripe (same trick as the can's lettering).
  return `
    <svg class="mm-hero" viewBox="0 0 1000 632" role="img" aria-label="Golf Racer">
      <defs>
        <clipPath id="sun"><circle cx="500" cy="300" r="250"/></clipPath>
      </defs>
      <rect x="0" y="0" width="1000" height="632" fill="var(--cream)"/>
      ${warmBands}
      ${seaBands}
      <g class="mm-title" fill="var(--cream)">
        <text x="96" y="424" dominant-baseline="middle">GOLF</text>
        <text x="96" y="483" dominant-baseline="middle">RACER</text>
      </g>
    </svg>`
}

export function createMainMenu(handlers: MainMenuHandlers): Screen {
  return {
    id: 'mainMenu',
    mount() {
      const root = document.createElement('div')
      root.className = 'screen main-menu'
      root.innerHTML = `
        <div class="mm-frame">
          ${heroSvg()}
          <div class="mm-buttons">
            <button class="mm-btn mm-single" type="button" data-action="single">Single Player</button>
            <button class="mm-btn mm-online" type="button" data-action="online">Online</button>
            <button class="mm-btn mm-editor" type="button" data-action="editor">Map Editor</button>
          </div>
        </div>`
      const on = (action: string, fn: () => void) =>
        root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.addEventListener('click', fn)
      on('single', handlers.onSinglePlayer)
      on('online', handlers.onOnline)
      on('editor', handlers.onEditor)
      return root
    },
  }
}
