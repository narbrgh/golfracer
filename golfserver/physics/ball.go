package physics

import "math"

// Tunable constants.
const (
	Gravity           = 1500.0 // px/s², downward
	GroundRestitution = 0.55   // fraction of normal speed kept after a real bounce
	BounceFriction    = 0.85   // fraction of tangential speed kept at bounce instant
	WallRestitution   = 0.65   // fraction of normal speed kept on side/ceiling bounce
	RollingFriction   = 200.0  // px/s² kinetic deceleration while rolling
	StaticFriction    = 400.0  // px/s² — max slope-gravity before ball starts sliding;
	//                             ball stays put when |g·sin θ| ≤ StaticFriction
	RestSpeedThreshold = 8.0 // px/s — below this while touching ground = "at rest"

	// MinBounceSpeed: incoming normal speed must exceed this to bounce rather than settle.
	// Without it, the tiny gravity injection each tick (~25 px/s at 60 Hz) bounces forever.
	MinBounceSpeed = 50.0
)

// Ball is a single golf ball. Y increases downward (screen convention).
type Ball struct {
	X, Y    float64
	VX, VY  float64
	Radius  float64
	Resting bool // gameplay flag: true when speed < RestSpeedThreshold while on ground
}

func NewBall(x, y, radius float64) *Ball {
	return &Ball{X: x, Y: y, Radius: radius, Resting: true}
}

// Shoot launches the ball. No-op if ball is not resting (server enforces shoot order).
func (b *Ball) Shoot(vx, vy float64) {
	if !b.Resting {
		return
	}
	b.Resting = false
	b.VX, b.VY = vx, vy
}

// Tick advances physics by dt seconds.
//
// groundY is the terrain height at the ball's current X (flat-ground approximation;
// good enough for gentle slopes). groundSlope is dy/dx of the terrain at that point —
// used to compute the surface normal so bounces and rolling are slope-aware.
//
// Resting is now a purely derived flag (speed < threshold while touching ground).
// Physics always runs so that balls on slopes roll downhill into valleys.
func (b *Ball) Tick(dt, groundY, groundSlope, leftX, rightX, topY float64) {
	// Gravity and integration always run — no early-return for Resting.
	b.VY += Gravity * dt
	b.X += b.VX * dt
	b.Y += b.VY * dt

	// --- Ground (slope-aware) ---
	touching := b.Y+b.Radius >= groundY
	if touching {
		b.Y = groundY - b.Radius // position correction (Y-axis; fine for gentle slopes)

		// Surface basis vectors.
		// Normal  n = (slope, -1) / L  — points away from ground into the air.
		// Tangent t = (1, slope)  / L  — points rightward along the surface.
		L := math.Sqrt(1 + groundSlope*groundSlope)
		nx, ny := groundSlope/L, -1.0/L
		tx, ty := 1.0/L, groundSlope/L

		// Decompose velocity.
		vn := b.VX*nx + b.VY*ny // negative = moving into surface
		vt := b.VX*tx + b.VY*ty // positive = moving rightward along surface

		if -vn > MinBounceSpeed {
			// Hard bounce: reflect normal component, damp tangential.
			vn = -vn * GroundRestitution
			vt *= BounceFriction
		} else {
			// Soft landing: cancel normal component.
			vn = 0
		}

		// Rolling friction + static friction.
		//
		// slopeGravAccel is the tangential component of gravity (g·sin θ). We strip
		// its per-tick contribution out of vt before applying kinetic friction, then
		// decide whether to add it back based on static friction.
		slopeGravAccel := Gravity * groundSlope / L // px/s² along tangent
		slopeGravDt := slopeGravAccel * dt
		vtPrior := vt - slopeGravDt // tangential velocity before slope gravity this tick

		// Kinetic friction decelerates existing motion.
		decel := RollingFriction * dt
		if math.Abs(vtPrior) <= decel {
			vtPrior = 0
		} else {
			vtPrior -= math.Copysign(decel, vtPrior)
		}

		if vtPrior == 0 && math.Abs(slopeGravAccel) <= StaticFriction {
			// Ball has stopped and the slope is gentle enough for static friction
			// to hold it. Cancel slope gravity entirely — ball stays put.
			vt = 0
		} else {
			// Ball is moving, or slope gravity exceeds static friction and the
			// ball starts (or continues) sliding. Kinetic friction is already
			// applied via vtPrior above.
			vt = vtPrior + slopeGravDt
		}

		b.VX = vn*nx + vt*tx
		b.VY = vn*ny + vt*ty
	}

	// --- Ceiling ---
	if b.Y-b.Radius <= topY {
		b.Y = topY + b.Radius
		if b.VY < 0 {
			b.VY = -b.VY * WallRestitution
		}
	}

	// --- Left wall ---
	if b.X-b.Radius <= leftX {
		b.X = leftX + b.Radius
		if b.VX < 0 {
			b.VX = -b.VX * WallRestitution
		}
	}

	// --- Right wall ---
	if b.X+b.Radius >= rightX {
		b.X = rightX - b.Radius
		if b.VX > 0 {
			b.VX = -b.VX * WallRestitution
		}
	}

	// Resting: purely derived — true when touching and barely moving.
	// Do NOT snap VX/VY to zero here: on a slope, slope gravity will be re-applied
	// next tick and the ball will keep rolling downhill. Snapping to zero causes the
	// ball to get stuck because slope gravity alone stays below RestSpeedThreshold.
	// On flat ground, rolling friction naturally zeros the velocity anyway.
	speed := math.Hypot(b.VX, b.VY)
	b.Resting = touching && speed < RestSpeedThreshold
}
