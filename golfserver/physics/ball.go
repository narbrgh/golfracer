package physics

import "math"

// Tunable constants. These are placeholder values — expect to retune
// all of them once the ball is actually rendered and you can feel the
// shots. Treat them as "roughly plausible," not "correct."
const (
	Gravity            = 1500.0 // px/s^2, downward
	GroundRestitution  = 0.55   // fraction of vertical speed kept after a real bounce
	BounceFriction     = 0.85   // fraction of horizontal speed kept at the instant of a bounce
	RollingFriction    = 600.0  // px/s^2 deceleration applied while rolling on the ground
	RestSpeedThreshold = 8.0    // px/s — below this (while touching ground) we call it "at rest"

	// MinBounceSpeed is the incoming vertical speed a ground contact
	// needs to exceed to actually bounce. Below it, the ball just
	// settles instead. This matters because gravity injects a fixed
	// ~Gravity*dt of speed every tick (about 25 px/s at 60Hz) — if
	// every contact bounces regardless of how gentle, restitution only
	// removes a percentage of that injected energy, which converges to
	// a permanent tiny oscillation that never decays to zero. Keeping
	// this comfortably above the per-tick gravity injection breaks
	// that loop. Tune for feel once you can see it.
	MinBounceSpeed = 50.0
)

// Ball is a single golf ball in the simulation. Y increases downward
// (standard screen/canvas convention): higher Y = lower on screen.
type Ball struct {
	X, Y    float64
	VX, VY  float64
	Radius  float64
	Resting bool
}

// NewBall creates a ball at rest at the given position.
func NewBall(x, y, radius float64) *Ball {
	return &Ball{X: x, Y: y, Radius: radius, Resting: true}
}

// Shoot launches a resting ball with the given velocity. Mirrors the
// "must be at rest to take your shot" rule — calling Shoot on a ball
// that's still moving is a no-op, since the server should never have
// accepted that input in the first place.
func (b *Ball) Shoot(vx, vy float64) {
	if !b.Resting {
		return
	}
	b.Resting = false
	b.VX, b.VY = vx, vy
}

// Tick advances the simulation by dt seconds against a flat ground at
// y = groundY. This is intentionally the simplest possible terrain —
// real courses will use polygon collision instead, but flat ground is
// enough to validate gravity, bouncing, and the rest/sleep behavior in
// isolation before anything else gets layered on top.
//
// NOTE: at high velocities a single large step can in principle let a
// fast-enough ball skip past the ground entirely between ticks
// ("tunneling"). At a 1/60s tick rate and reasonable golf-shot speeds
// this won't show up, but it's the reason swept collision will matter
// once polygon terrain and fast shots are both in play.
func (b *Ball) Tick(dt float64, groundY float64) {
	if b.Resting {
		return
	}

	// Integrate gravity, then position.
	b.VY += Gravity * dt
	b.X += b.VX * dt
	b.Y += b.VY * dt

	touchingGround := b.Y+b.Radius >= groundY

	if touchingGround {
		b.Y = groundY - b.Radius

		if b.VY > MinBounceSpeed {
			b.VY = -b.VY * GroundRestitution
			b.VX *= BounceFriction
		} else if b.VY > 0 {
			// Too gentle to bounce -- just settle vertically rather
			// than handing restitution a tiny amount of energy to
			// recycle forever.
			b.VY = 0
		}

		// Rolling friction while in contact, applied toward zero.
		if b.VX > 0 {
			b.VX = math.Max(0, b.VX-RollingFriction*dt)
		} else if b.VX < 0 {
			b.VX = math.Min(0, b.VX+RollingFriction*dt)
		}
	}

	speed := math.Hypot(b.VX, b.VY)
	if touchingGround && speed < RestSpeedThreshold {
		b.VX, b.VY = 0, 0
		b.Resting = true
	}
}
