import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

// Build-time client version: short git hash + build date. Injected as the
// global __CLIENT_VERSION__ (see src/version.ts). Falls back gracefully when
// git isn't available (e.g. a source tarball) so the build never fails.
function clientVersion(): string {
  let hash = 'nogit'
  try {
    hash = execSync('git rev-parse --short HEAD').toString().trim()
    // Mark dirty if there are uncommitted changes, so a local build is
    // distinguishable from the exact committed one.
    const dirty = execSync('git status --porcelain').toString().trim().length > 0
    if (dirty) hash += '-dirty'
  } catch {
    /* not a git checkout — keep fallback */
  }
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${hash} (${date})`
}

export default defineConfig({
  define: {
    __CLIENT_VERSION__: JSON.stringify(clientVersion()),
  },
})
