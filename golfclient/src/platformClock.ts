// The shared platform clock: the `t` that animated platforms' motion is a function
// of (see PlatformMotionSet in terrain.ts). The server owns the clock — it steps
// physics with it — and stamps it on state messages as `pt`. The client keeps a
// local clock running between messages (the server goes quiet while a ball rests)
// and nudges it toward each new stamp.
//
// Single-player and multiplayer run on different server clocks (wall time since
// server start vs. match ticks). Switching between them shows up as a huge jump,
// which simply snaps the offset, so no explicit reset is needed.

let offset = 0      // serverPT − localSeconds
let synced = false

const localSeconds = () => performance.now() / 1000

/** Feed a server platform-clock stamp. First stamp (or a big jump) snaps; later ones ease in. */
export function syncPlatformClock(serverPT: number): void {
  const measured = serverPT - localSeconds()
  if (!synced || Math.abs(measured - offset) > 0.25) {
    offset = measured
    synced = true
  } else {
    // The stamp is one network hop old, so each one reads slightly behind; easing
    // keeps jitter from visibly shaking a moving platform.
    offset += (measured - offset) * 0.2
  }
}

/** Current platform time in seconds. Before any server stamp it just counts from page load. */
export function platformTime(): number {
  return localSeconds() + offset
}
