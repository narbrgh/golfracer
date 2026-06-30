package physics

import "math"

// Tunable constants.
const (
	Gravity           = 1500.0 // px/s², downward
	GroundRestitution = 0.55   // fraction of normal speed kept after a real bounce
	BounceFriction    = 0.85   // fraction of tangential speed kept at bounce instant
	WallRestitution   = 0.65   // fraction of normal speed kept on side/ceiling bounce
	RollingFriction   = 200.0  // px/s² kinetic deceleration while rolling
	StaticFriction    = 400.0  // px/s² — max slope-gravity before ball starts sliding
	RestSpeedThreshold = 8.0  // px/s — below this while touching ground = "at rest"

	// RestAccelThreshold: max tick-over-tick velocity change (px/s²) while touching
	// for the ball to count as "at rest". Using actual measured acceleration rather
	// than inferring stillness from a single contact edge's slope means a ball
	// wedged in a concave corner (e.g. the bottom of a sharp V valley) can still be
	// recognized as resting: each side of the V may individually have a slope steep
	// enough to "fail" a single-edge static-friction check, even though the two
	// contacts cancel out and the ball is physically motionless.
	RestAccelThreshold = 60.0

	// MinBounceSpeed: incoming normal speed must exceed this to bounce rather than settle.
	// Without it, the tiny gravity injection each tick (~25 px/s at 60 Hz) bounces forever.
	MinBounceSpeed = 50.0

	// floorNYCutoff classifies edges by orientation. An edge whose outward normal has
	// NY < this value is "floor-type" (normal points sufficiently upward — surface is
	// within ~78° of horizontal). Steeper edges are "wall-type" and are resolved as
	// obstacles the ball bounces off rather than rolls along.
	// NY = -TX for a left-to-right edge, so floorNYCutoff = -cos(78°) ≈ -0.2.
	floorNYCutoff = -0.2

	// rollContinuityDot: minimum tangent dot product between the edge the ball was
	// just rolling on and a newly-touched floor-type edge for the transition to count
	// as "smooth" (energy-preserving redirect). Sampled terrain near a steep curve can
	// briefly produce one floor-classified edge (NY just under floorNYCutoff) sandwiched
	// between otherwise wall-classified ones; without this check that stray edge would
	// smooth-redirect the ball's speed up a near-vertical face, producing the
	// bounce/climb/bounce oscillation seen on steep terrain. cos(50°) ≈ 0.64.
	rollContinuityDot = 0.64
)

// Edge is a line segment used for ball collision. It is the single geometric
// primitive physics understands — terrain, tee platforms, and hand-drawn polygons
// are all just lists of Edges, and they all go through the same collision code.
//
// NX, NY is the unit outward normal — the direction the ball is pushed out along.
type Edge struct {
	X0, Y0, X1, Y1 float64
	TX, TY         float64 // unit tangent, P0 → P1
	NX, NY         float64 // unit outward normal
	Len            float64
}

// NewEdge builds an Edge from two endpoints. The outward normal is (TY, -TX):
// for a left-to-right segment this points "up" in screen coordinates (Y grows
// downward), which is what every terrain/platform edge wants.
func NewEdge(x0, y0, x1, y1 float64) Edge {
	dx, dy := x1-x0, y1-y0
	length := math.Hypot(dx, dy)
	if length < 1e-9 {
		return Edge{X0: x0, Y0: y0, X1: x1, Y1: y1}
	}
	tx, ty := dx/length, dy/length
	return Edge{
		X0: x0, Y0: y0, X1: x1, Y1: y1,
		TX: tx, TY: ty,
		NX: ty, NY: -tx,
		Len: length,
	}
}

// circleEdgePen returns how deep a circle (cx,cy,r) penetrates an edge, or 0.
// Testing ball center + radius against an edge is mathematically equivalent to
// checking every point on the circumference, so this is full-circumference
// detection — the ball's leading side is caught before the bottom reaches a
// slope transition.
//
// One-sided: a ball on the "ground" side (sd < -r) is not pushed through from below,
// so tee platforms and future polygon obstacles don't grab balls rolling beneath them.
func circleEdgePen(cx, cy, r float64, e Edge) float64 {
	dx, dy := cx-e.X0, cy-e.Y0
	t := dx*e.TX + dy*e.TY
	if t < 0 || t > e.Len {
		return 0
	}
	sd := dx*e.NX + dy*e.NY // positive = open-air side
	if sd < -r {
		return 0
	}
	pen := r - sd
	if pen <= 0 {
		return 0
	}
	return pen
}

// Ball is a single golf ball. Y increases downward (screen convention).
type Ball struct {
	X, Y    float64
	VX, VY  float64
	Radius  float64
	Resting bool // true when speed < RestSpeedThreshold while touching ground
	airTicks int // consecutive ticks spent off all floor-type surfaces
	prevTX, prevTY float64 // tangent of the last floor-type edge the ball touched
}

func NewBall(x, y, radius float64) *Ball {
	return &Ball{X: x, Y: y, Radius: radius, Resting: true, prevTX: 1}
}

// Shoot launches the ball. No-op if ball is not resting.
func (b *Ball) Shoot(vx, vy float64) {
	if !b.Resting {
		return
	}
	b.Resting = false
	b.VX, b.VY = vx, vy
	b.airTicks = 1
}

// Tick advances physics by dt seconds.
//
// All penetrating edges are tested every tick via circleEdgePen (full circumference
// detection). Contacts are classified by the edge's outward normal:
//
//   - Floor-type  (NY < floorNYCutoff ≈ −0.2, normal mostly upward): the deepest
//     floor contact drives rolling physics — smooth energy-preserving redirect when
//     rolling, hard bounce when airborne or newly landing.
//
//   - Wall/obstacle-type (NY ≥ floorNYCutoff, normal lateral or downward): resolved
//     immediately in the scan, before floor physics. This means the ball's leading
//     circumference hits a steep obstacle and bounces back even while the ball's
//     bottom is still touching the floor — correctly stopping a ball that rolls into
//     a near-vertical slope rather than letting it climb the face.
func (b *Ball) Tick(dt float64, edges []Edge, leftX, rightX, topY float64) {
	prevVX, prevVY := b.VX, b.VY

	b.VY += Gravity * dt
	b.X += b.VX * dt
	b.Y += b.VY * dt

	floorPen := 0.0
	floorIdx := -1

	for i, e := range edges {
		// Broad-phase X check (handles edges in either direction).
		lo, hi := e.X0, e.X1
		if lo > hi {
			lo, hi = hi, lo
		}
		if b.X+b.Radius < lo || b.X-b.Radius > hi {
			continue
		}

		pen := circleEdgePen(b.X, b.Y, b.Radius, e)
		if pen <= 0 {
			continue
		}

		if e.NY < floorNYCutoff {
			// Floor-type: accumulate deepest for rolling physics.
			if pen > floorPen {
				floorPen = pen
				floorIdx = i
			}
		} else {
			// Wall/obstacle-type: resolve immediately so the leading edge of the
			// ball stops against steep surfaces rather than riding up them.
			b.X += e.NX * pen
			b.Y += e.NY * pen
			vn := b.VX*e.NX + b.VY*e.NY
			if vn < 0 { // only correct if moving into this surface
				if -vn > MinBounceSpeed {
					vt := b.VX*e.TX + b.VY*e.TY
					vn = -vn * GroundRestitution
					vt *= BounceFriction
					b.VX = vn*e.NX + vt*e.TX
					b.VY = vn*e.NY + vt*e.TY
				} else {
					// Gentle contact — just kill the into-surface component.
					b.VX -= vn * e.NX
					b.VY -= vn * e.NY
				}
			}
		}
	}

	// Floor rolling physics.
	slopeGravAccel := 0.0
	touching := floorIdx >= 0
	if touching {
		e := edges[floorIdx]

		b.X += e.NX * floorPen
		b.Y += e.NY * floorPen

		vn := b.VX*e.NX + b.VY*e.NY
		vt := b.VX*e.TX + b.VY*e.TY

		slopeGravAccel = Gravity * e.TY
		slopeGravDt := slopeGravAccel * dt

		// A transition only counts as "smooth rolling" if the ball was already
		// touching a floor-type surface AND the new edge's tangent direction is
		// close to the one it was just rolling on. A sharp jump (even between two
		// edges that both individually classify as floor-type) is a real impact,
		// not a continuation — see rollContinuityDot.
		continuous := e.TX*b.prevTX+e.TY*b.prevTY >= rollContinuityDot
		if b.airTicks == 0 && continuous {
			// Smooth rolling transition: energy-preserving redirect.
			// Pre-gravity speed prevents rightward drift at rest (IEEE 754 Copysign-of-zero
			// is positive, and b.VY always includes this tick's gravity injection).
			speedPre := math.Hypot(b.VX, b.VY-Gravity*dt)
			vtPriorGrav := vt - slopeGravDt
			vt = math.Copysign(speedPre, vtPriorGrav) + slopeGravDt
			vn = 0
		} else if -vn > MinBounceSpeed {
			// Hard bounce: either genuinely airborne, or a sharp angle change
			// (e.g. the leading edge of the ball catching a steep face) hit with
			// enough speed to bounce rather than settle.
			vn = -vn * GroundRestitution
			vt *= BounceFriction
		} else {
			// Soft landing / gentle contact.
			vn = 0
		}

		vtPrior := vt - slopeGravDt
		decel := RollingFriction * dt
		if math.Abs(vtPrior) <= decel {
			vtPrior = 0
		} else {
			vtPrior -= math.Copysign(decel, vtPrior)
		}

		if vtPrior == 0 && math.Abs(slopeGravAccel) <= StaticFriction {
			vt = 0
		} else {
			vt = vtPrior + slopeGravDt
		}

		b.VX = vn*e.NX + vt*e.TX
		b.VY = vn*e.NY + vt*e.TY
		b.airTicks = 0
		b.prevTX, b.prevTY = e.TX, e.TY
	} else {
		b.airTicks++
	}

	// Depenetration: a circle wedged into a concave corner (e.g. the bottom of a
	// sharp V valley) can touch two edges at once whose single-pass corrections
	// above fight each other, leaving residual overlap into one of them. Iterate
	// a few pure position-only passes over every edge so the ball converges to a
	// non-overlapping position regardless of how many surfaces it's pressed against.
	for range 8 {
		moved := false
		for _, e := range edges {
			lo, hi := e.X0, e.X1
			if lo > hi {
				lo, hi = hi, lo
			}
			if b.X+b.Radius < lo || b.X-b.Radius > hi {
				continue
			}
			pen := circleEdgePen(b.X, b.Y, b.Radius, e)
			if pen > 1e-6 {
				// Push slightly past zero penetration (not just to it) so float
				// rounding doesn't leave a hairline overlap that the next edge's
				// correction (or the next tick) re-discovers, which is what was
				// producing a small but persistent visible sink into sharp corners.
				b.X += e.NX * (pen + 1e-4)
				b.Y += e.NY * (pen + 1e-4)
				moved = true
			}
		}
		if !moved {
			break
		}
	}

	// World boundaries.
	if b.Y-b.Radius <= topY {
		b.Y = topY + b.Radius
		if b.VY < 0 {
			b.VY = -b.VY * WallRestitution
		}
	}
	if b.X-b.Radius <= leftX {
		b.X = leftX + b.Radius
		if b.VX < 0 {
			b.VX = -b.VX * WallRestitution
		}
	}
	if b.X+b.Radius >= rightX {
		b.X = rightX - b.Radius
		if b.VX > 0 {
			b.VX = -b.VX * WallRestitution
		}
	}

	speed := math.Hypot(b.VX, b.VY)
	accel := math.Hypot(b.VX-prevVX, b.VY-prevVY) / dt
	// Ball is Resting only when touching, barely moving, and not still being
	// accelerated by net contact + gravity forces. Measuring actual velocity
	// change (rather than inferring stillness from a single contact edge's slope)
	// correctly handles concave corners — e.g. a V-shaped valley where each side
	// individually looks "too steep" for static friction, but the two contacts
	// cancel out and the ball is genuinely motionless. It also still keeps the
	// "ready to hit" indicator from flashing at the apex of an uphill roll, since
	// the ball is still accelerating (backward) there.
	b.Resting = touching && speed < RestSpeedThreshold && accel < RestAccelThreshold
}
