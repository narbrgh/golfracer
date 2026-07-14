// The "Ken" menu: a live tuning panel for gameplay-feel constants. Server-side
// physics fields (gravity, friction, restitution, bunker penalties) are pushed
// to the running golfserver immediately over /physics/config — no restart, no
// disk persistence (session-only, matching the server's in-memory Tunables).
// Club-distance fields are purely client-side (swing.ts's CLUB_MAX_SPEED) and
// apply instantly with no network round trip.
//
// The JSON box at the bottom mirrors the current values for copy/paste — the
// intended workflow is "tweak here, copy the blob, send it to someone else
// (e.g. over chat) so they can paste it into their own Ken menu and hit Apply."
import './kenScreen.css'
import type { Screen } from './screenManager'
import { getPhysicsConfig, setPhysicsConfig, type PhysicsTunables } from '../physicsApi'
import { CLUB_MAX_SPEED, DEFAULT_CLUB_MAX_SPEED, BACKSPIN_POWER, DEFAULT_BACKSPIN_POWER } from '../swing'

export interface KenScreenHandlers {
  onBack: () => void
}

type KenValues = PhysicsTunables & {
  driverDistance: number
  wedgeDistance: number
  putterDistance: number
  backspinPower: number
}

interface FieldSpec {
  key: keyof KenValues
  label: string
  description: string
  step: number
  min: number
  max: number
}

const SERVER_FIELDS: FieldSpec[] = [
  { key: 'gravity', label: 'Gravity', description: 'px/s², downward', step: 25, min: 0, max: 5000 },
  { key: 'groundRestitution', label: 'Ground Restitution', description: 'fraction of normal speed kept after a real bounce', step: 0.01, min: 0, max: 1.5 },
  { key: 'bounceFriction', label: 'Bounce Friction', description: 'fraction of tangential speed kept at bounce instant', step: 0.01, min: 0, max: 1.5 },
  { key: 'wallRestitution', label: 'Wall Restitution', description: 'fraction of normal speed kept on side/ceiling bounce', step: 0.01, min: 0, max: 1.5 },
  { key: 'rollingFriction', label: 'Rolling Friction', description: 'px/s² kinetic deceleration while rolling', step: 5, min: 0, max: 2000 },
  { key: 'staticFriction', label: 'Static Friction', description: 'px/s² — max slope-gravity before ball starts sliding', step: 5, min: 0, max: 2000 },
  { key: 'restSpeedThreshold', label: 'Rest Speed Threshold', description: 'px/s — below this while touching ground = "at rest"', step: 0.5, min: 0, max: 100 },
]

const BUNKER_FIELDS: FieldSpec[] = [
  { key: 'bunkerFriction', label: 'Bunker Friction', description: 'px/s² kinetic deceleration while rolling in a bunker. For reference grass (Rolling Friction) is 400 — set this ABOVE that for grabby sand.', step: 10, min: 0, max: 3000 },
]

const PENALTY_FIELDS: FieldSpec[] = [
  { key: 'driverPenalty', label: 'Driver Penalty', description: '0-1 — shot power is multiplied by this when hitting a driver out of a bunker', step: 0.01, min: 0, max: 1 },
  { key: 'wedgePenalty', label: 'Pitching Wedge Penalty', description: '0-1 — shot power is multiplied by this when hitting a pitching wedge out of a bunker', step: 0.01, min: 0, max: 1 },
  { key: 'putterPenalty', label: 'Putter Penalty', description: '0-1 — shot power is multiplied by this when hitting a putter out of a bunker', step: 0.01, min: 0, max: 1 },
]

const SPIN_FIELDS: FieldSpec[] = [
  { key: 'spinMagnus', label: 'Spin Magnus', description: '1/s — spin turn rate. Higher = topspin dives harder / backspin floats higher (and, with its extra drag, lands SHORTER). Accel = this × speed per spin.', step: 0.05, min: 0, max: 3 },
  { key: 'spinLandingBite', label: 'Spin Landing Bite', description: '0-1 — how much backspin kills (checks up) / topspin boosts forward roll on the landing bounce. 1 = backspin fully stops forward roll.', step: 0.05, min: 0, max: 1 },
  { key: 'noSpinBackspinFrac', label: 'No-Spin Backspin', description: '0-1 — fraction of the backspin lift/drag/check-up applied to a "no spin" shot, so neutral shots have a slight backspin (the ideal shot). 0 = no-spin is truly neutral.', step: 0.05, min: 0, max: 1 },
  { key: 'backspinPower', label: 'Backspin Power', description: '0-1 — launch-speed multiplier for backspin shots. Lower = backspin flies shorter (the trade-off for its landing check-up). Client-only, applied at launch.', step: 0.05, min: 0, max: 1 },
]

const WIND_FIELDS: FieldSpec[] = [
  { key: 'airDrag', label: 'Air Drag', description: '1/s — air-drag coefficient. Wind pushes the ball via drag toward the moving air; also the reason backspin (more airtime) drifts more than topspin. 0 = no drag/wind.', step: 0.01, min: 0, max: 1 },
  { key: 'windMphScale', label: 'Wind mph→Speed', description: 'px/s of air velocity per 1 mph of wind. mph is just a display label; this sets how hard a given mph actually pushes.', step: 1, min: 0, max: 100 },
  { key: 'windOverrideOn', label: 'Wind Override On', description: '0 or 1 — when 1, every hole uses the fixed Wind Override value below instead of a random per-hole wind (for testing a known wind).', step: 1, min: 0, max: 1 },
  { key: 'windOverrideMph', label: 'Wind Override mph', description: 'Forced wind in mph (+right / -left) when Wind Override On is 1.', step: 1, min: -20, max: 20 },
]

const DISTANCE_FIELDS: FieldSpec[] = [
  { key: 'driverDistance', label: 'Driver Distance', description: 'px/s launch speed at 100% power — how hard the driver hits', step: 10, min: 0, max: 4000 },
  { key: 'wedgeDistance', label: 'Pitching Wedge Distance', description: 'px/s launch speed at 100% power — how hard the pitching wedge hits', step: 10, min: 0, max: 4000 },
  { key: 'putterDistance', label: 'Putter Distance', description: 'px/s launch speed at 100% power — how hard the putter hits', step: 5, min: 0, max: 2000 },
]

const ALL_FIELDS = [...SERVER_FIELDS, ...BUNKER_FIELDS, ...PENALTY_FIELDS, ...SPIN_FIELDS, ...WIND_FIELDS, ...DISTANCE_FIELDS]
const CLIENT_KEYS = new Set<keyof KenValues>(['driverDistance', 'wedgeDistance', 'putterDistance', 'backspinPower'])

function toServerTunables(v: KenValues): PhysicsTunables {
  return {
    gravity: v.gravity,
    groundRestitution: v.groundRestitution,
    bounceFriction: v.bounceFriction,
    wallRestitution: v.wallRestitution,
    rollingFriction: v.rollingFriction,
    staticFriction: v.staticFriction,
    restSpeedThreshold: v.restSpeedThreshold,
    bunkerFriction: v.bunkerFriction,
    driverPenalty: v.driverPenalty,
    wedgePenalty: v.wedgePenalty,
    putterPenalty: v.putterPenalty,
    airDrag: v.airDrag,
    windMphScale: v.windMphScale,
    spinMagnus: v.spinMagnus,
    spinLandingBite: v.spinLandingBite,
    noSpinBackspinFrac: v.noSpinBackspinFrac,
    windOverrideOn: v.windOverrideOn,
    windOverrideMph: v.windOverrideMph,
  }
}

// Applies the client-only knobs (CLIENT_KEYS) to their live module state. These
// apply instantly with no server round trip, unlike the server tunables.
function applyClientValues(v: KenValues) {
  CLUB_MAX_SPEED.driver = v.driverDistance
  CLUB_MAX_SPEED.wedge = v.wedgeDistance
  CLUB_MAX_SPEED.putter = v.putterDistance
  BACKSPIN_POWER.value = v.backspinPower
}

export function createKenScreen(handlers: KenScreenHandlers): Screen {
  let fieldsHost: HTMLElement
  let jsonBox: HTMLTextAreaElement
  let statusEl: HTMLElement
  let values: KenValues | null = null
  let defaults: KenValues | null = null
  let postTimer: ReturnType<typeof setTimeout> | null = null

  function pushServerValues() {
    if (!values) return
    if (postTimer) clearTimeout(postTimer)
    postTimer = setTimeout(() => {
      setPhysicsConfig(toServerTunables(values!))
        .then(() => { statusEl.textContent = 'Live' })
        .catch((e) => { statusEl.textContent = 'Failed to push: ' + String(e) })
    }, 150)
  }

  function syncJsonBox() {
    if (values) jsonBox.value = JSON.stringify(values, null, 2)
  }

  function fieldRow(spec: FieldSpec): HTMLElement {
    const row = document.createElement('div')
    row.className = 'ken-row'
    const head = document.createElement('div')
    head.className = 'ken-row-head'
    const label = document.createElement('span')
    label.className = 'ken-label'
    label.textContent = spec.label
    const def = document.createElement('span')
    def.className = 'ken-default'
    def.textContent = defaults ? `default: ${defaults[spec.key]}` : ''
    head.append(label, def)
    const desc = document.createElement('div')
    desc.className = 'ken-desc'
    desc.textContent = spec.description
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'ken-input'
    input.step = String(spec.step)
    input.min = String(spec.min)
    input.max = String(spec.max)
    input.value = values ? String(values[spec.key]) : ''
    input.addEventListener('input', () => {
      const n = parseFloat(input.value)
      if (Number.isNaN(n) || !values) return
      ;(values as Record<keyof KenValues, number>)[spec.key] = n
      syncJsonBox()
      if (CLIENT_KEYS.has(spec.key)) applyClientValues(values)
      else pushServerValues()
    })
    row.append(head, desc, input)
    return row
  }

  function section(title: string, specs: FieldSpec[]): HTMLElement {
    const sec = document.createElement('div')
    sec.className = 'ken-section'
    const h = document.createElement('h3')
    h.textContent = title
    sec.appendChild(h)
    specs.forEach((s) => sec.appendChild(fieldRow(s)))
    return sec
  }

  function renderFields() {
    fieldsHost.innerHTML = ''
    fieldsHost.appendChild(section('Ball Physics', SERVER_FIELDS))
    fieldsHost.appendChild(section('Bunker', BUNKER_FIELDS))
    fieldsHost.appendChild(section('Bunker Shot Penalties', PENALTY_FIELDS))
    fieldsHost.appendChild(section('Spin', SPIN_FIELDS))
    fieldsHost.appendChild(section('Wind', WIND_FIELDS))
    fieldsHost.appendChild(section('Club Distance', DISTANCE_FIELDS))
    syncJsonBox()
  }

  function loadFromServer() {
    statusEl.textContent = 'Loading…'
    getPhysicsConfig()
      .then((cfg) => {
        values = {
          ...cfg.current,
          driverDistance: CLUB_MAX_SPEED.driver,
          wedgeDistance: CLUB_MAX_SPEED.wedge,
          putterDistance: CLUB_MAX_SPEED.putter,
          backspinPower: BACKSPIN_POWER.value,
        }
        defaults = {
          ...cfg.defaults,
          driverDistance: DEFAULT_CLUB_MAX_SPEED.driver,
          wedgeDistance: DEFAULT_CLUB_MAX_SPEED.wedge,
          putterDistance: DEFAULT_CLUB_MAX_SPEED.putter,
          backspinPower: DEFAULT_BACKSPIN_POWER,
        }
        statusEl.textContent = 'Live'
        renderFields()
      })
      .catch((e) => { statusEl.textContent = 'Failed to load: ' + String(e) })
  }

  function resetToDefaults() {
    if (!defaults) return
    values = { ...defaults }
    applyClientValues(values)
    pushServerValues()
    renderFields()
  }

  function applyPastedJson() {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(jsonBox.value)
    } catch (e) {
      statusEl.textContent = 'Invalid JSON: ' + String(e)
      return
    }
    if (!values) return
    const next: KenValues = { ...values }
    for (const f of ALL_FIELDS) {
      const raw = parsed[f.key]
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        ;(next as Record<keyof KenValues, number>)[f.key] = raw
      }
    }
    values = next
    applyClientValues(values)
    pushServerValues()
    renderFields()
    statusEl.textContent = 'Applied pasted values'
  }

  return {
    id: 'ken',
    mount() {
      const root = document.createElement('div')
      root.className = 'screen ken-screen'
      root.innerHTML = `
        <div class="ken-frame">
          <div class="ken-head">
            <h1 class="ken-title">Ken</h1>
            <span class="ken-status" data-status>Loading…</span>
          </div>
          <p class="ken-hint">Everything here applies live, immediately, to the running game. Nothing is
            saved to disk — restarting the server or refreshing the page resets to defaults, so copy the
            JSON at the bottom before you close this if you want to keep it.</p>
          <div class="ken-fields" data-fields></div>
          <div class="ken-io">
            <div class="ken-io-head">
              <h3>Copy / Paste Config</h3>
              <div class="ken-io-actions">
                <button class="ken-btn" type="button" data-copy>Copy</button>
                <button class="ken-btn" type="button" data-apply>Apply Pasted JSON</button>
                <button class="ken-btn ken-btn-reset" type="button" data-reset>Reset to Defaults</button>
              </div>
            </div>
            <textarea class="ken-json" data-json spellcheck="false"></textarea>
          </div>
          <button class="ken-back" type="button" data-back>← Back</button>
        </div>`

      fieldsHost = root.querySelector<HTMLElement>('[data-fields]')!
      jsonBox = root.querySelector<HTMLTextAreaElement>('[data-json]')!
      statusEl = root.querySelector<HTMLElement>('[data-status]')!

      root.querySelector('[data-back]')!.addEventListener('click', handlers.onBack)
      root.querySelector('[data-reset]')!.addEventListener('click', resetToDefaults)
      root.querySelector('[data-apply]')!.addEventListener('click', applyPastedJson)
      const copyBtn = root.querySelector<HTMLButtonElement>('[data-copy]')!
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(jsonBox.value).then(() => {
          const original = copyBtn.textContent
          copyBtn.textContent = 'Copied!'
          setTimeout(() => { copyBtn.textContent = original }, 1200)
        })
      })
      return root
    },
    onEnter() {
      loadFromServer()
    },
  }
}
