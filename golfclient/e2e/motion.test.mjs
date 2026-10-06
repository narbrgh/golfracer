// Golden vectors for platform motion: the TypeScript half of the contract with
// golfserver/terrain/motion_test.go. The cases and expected numbers are identical
// there — if one side's math drifts, its test fails. Pure math, no browser/server:
// run with `npm run test:motion`. (Node type-strips terrain.ts directly.)
import assert from 'node:assert/strict'
import { PlatformMotionSet, applyXform, hasAnimatedPlatforms } from '../src/terrain.ts'

const pt = (x, y) => ({ x, y })
const near = (a, b) => Math.abs(a - b) < 1e-6
const pivot = pt(100, 100)
const pingpong = (extra = {}) => ({
  kind: 'path', waypoints: [pt(100, 0)], speed: 100, mode: 'pingpong', ease: 'linear', ...extra,
})

const cases = [
  ['rotate 60rpm quarter turn is 90deg clockwise on screen',
    [{ motion: { kind: 'rotate', pivot, rpm: 60 } }], 0, 0.25, pt(110, 100), pt(100, 110)],
  ['rotate phase 180deg at t=0',
    [{ motion: { kind: 'rotate', pivot, rpm: 10, phase: 180 } }], 0, 0, pt(110, 100), pt(90, 100)],
  ['pingpong linear midway out', [{ motion: pingpong() }], 0, 0.5, pt(0, 0), pt(50, 0)],
  ['pingpong linear at the far end', [{ motion: pingpong() }], 0, 1, pt(0, 0), pt(100, 0)],
  ['pingpong linear on the way back', [{ motion: pingpong() }], 0, 1.5, pt(0, 0), pt(50, 0)],
  ['pingpong sine ease is slow at the start',
    [{ motion: pingpong({ ease: 'sine' }) }], 0, 0.25, pt(0, 0), pt(14.644660940672624, 0)],
  ['loop through two waypoints',
    [{ motion: { kind: 'path', waypoints: [pt(100, 0), pt(100, 100)], speed: 100, mode: 'loop', ease: 'linear' } }],
    0, 1.5, pt(0, 0), pt(100, 50)],
  ['path phase starts mid-cycle', [{ motion: pingpong({ phase: 0.5 }) }], 0, 0, pt(0, 0), pt(100, 0)],
  ['negative time wraps', [{ motion: pingpong() }], 0, -0.5, pt(0, 0), pt(50, 0)],
  ['child rides its rotating parent',
    [
      { id: 'hub', motion: { kind: 'rotate', pivot: pt(0, 0), rpm: 60 } },
      { id: 'arm', parent: 'hub', motion: { kind: 'path', waypoints: [pt(10, 0)], speed: 10, mode: 'pingpong', ease: 'linear' } },
    ], 1, 0.25, pt(5, 0), pt(0, 7.5)],
  ['static platform is untouched', [{}], 0, 123.4, pt(7, 8), pt(7, 8)],
]

let failed = 0
for (const [name, plats, idx, t, input, want] of cases) {
  const platforms = plats.map((p) => ({ points: [], ...p }))
  const got = applyXform(new PlatformMotionSet(platforms).xform(idx, t), input)
  if (near(got.x, want.x) && near(got.y, want.y)) console.log(`  ok   ${name}`)
  else { failed++; console.log(`  FAIL ${name}: got (${got.x}, ${got.y}), want (${want.x}, ${want.y})`) }
}

// Bad links must not hang or throw, and `moves` must be accurate.
const bad = new PlatformMotionSet([
  { points: [], id: 'a', parent: 'b', motion: { kind: 'rotate', pivot: pt(0, 0), rpm: 6 } },
  { points: [], id: 'b', parent: 'a', motion: { kind: 'rotate', pivot: pt(0, 0), rpm: 6 } },
  { points: [], id: 'c', parent: 'missing' },
])
bad.xform(0, 1); bad.xform(2, 1)
try {
  assert.equal(bad.moves(2), false, 'dangling parent with no motion must not move')
  assert.equal(bad.moves(0), true, 'own rotation must move')
  assert.equal(hasAnimatedPlatforms({ platforms: [{ points: [] }] }), false)
  console.log('  ok   parent cycles / dangling parents are safe')
} catch (e) { failed++; console.log(`  FAIL ${e.message}`) }

console.log(failed === 0 ? `\nall passed` : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
