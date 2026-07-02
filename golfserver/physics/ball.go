package physics

import "math"

// Tunable constants.
const (
	Gravity            = 1500.0 // px/s², downward
	GroundRestitution  = 0.55   // fraction of normal speed kept after a real bounce
	BounceFriction     = 0.85   // fraction of tangential speed kept at bounce instant
	WallRestitution    = 0.65   // fraction of normal speed kept on side/ceiling bounce
	RollingFriction    = 200.0  // px/s² kinetic deceleration while rolling
	StaticFriction     = 400.0  // px/s² — max slope-gravity before ball starts sliding
	RestSpeedThreshold = 8.0    // px/s — below this while touching ground = "at rest"

	// RestAccelThreshold: max tick-over-tick velocity change (px/s²) while touching
	// for the ball to count as "at rest". Using actual measured acceleration rather
	// than inferring stillness from a single contact edge's slope means a ball
	// wedged in a concave corner (e.g. the bottom of a sharp V valley) can still be
	// recognized as resting: each side of the V may individually have a slope steep
	// enough to "fail" a single-edge static-friction check, even though the two
	// contacts cancel out and the ball is physically motionless.
	RestAccelThreshold = 20.0

	// RestStillTime: a ball that has stayed below RestSpeedThreshold while in
	// (or within a couple ticks of) contact for this long is forced to rest even
	// if the accel check never passes. A ball wedged between two V walls can sit
	// in a tiny period-2 limit cycle — velocity flips direction every tick between
	// the two wall tangents, so |Δv|/dt reads as a huge acceleration while the
	// ball is visually frozen at ~5 px/s. That cycle is below RestSpeedThreshold,
	// so the wedge (blocked-displacement) detector never counts it either; this
	// timer is what catches it. It cannot false-fire at the apex of an uphill
	// roll: any slope too steep for StaticFriction (> 400 px/s²) keeps the ball
	// below 8 px/s for under 0.04s, and on gentler slopes static friction stops
	// the ball legitimately anyway.
	RestStillTime = 0.08

	// MinBounceSpeed: incoming normal speed must exceed this to bounce rather than settle.
	// Without it, the tiny gravity injection each tick (~25 px/s at 60 Hz) bounces forever.
	MinBounceSpeed = 50.0

	// wedgeRestTicks: how many consecutive ticks the ball must be "blocked"
	// (touching edges but displacing far less than its speed implies) before we
	// force it to rest. This catches a ball wedged at the bottom of a sharp V
	// between two wall-type edges — e.g. a steep bunker rim meeting a steep hill
	// face — where gravity keeps pumping velocity in and the walls redirect it in
	// a permanent limit cycle (position frozen, speed never settling). A genuine
	// bounce blocks for only one or two ticks, so it never trips this. With the
	// decay accumulator (see Tick) this is a net-blocked-tick budget, not a
	// strict consecutive count, so it's set a little higher.
	wedgeRestTicks = 10

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
//
// Restitution / BounceFric are per-edge material properties (normal- and
// tangential-velocity retention on a bounce). Terrain, tee, and platform edges
// use the global GroundRestitution / BounceFriction defaults; bunker rim edges
// override them with much lower values so the ball rarely bounces off sand.
type Edge struct {
	X0, Y0, X1, Y1 float64
	TX, TY         float64 // unit tangent, P0 → P1
	NX, NY         float64 // unit outward normal
	Len            float64
	Restitution    float64 // normal-speed retention on bounce
	BounceFric     float64 // tangential-speed retention on bounce
}

// NewEdge builds an Edge from two endpoints with the default (terrain) material.
// The outward normal is (TY, -TX): for a left-to-right segment this points "up"
// in screen coordinates (Y grows downward), which is what every terrain/platform
// edge wants.
func NewEdge(x0, y0, x1, y1 float64) Edge {
	return NewEdgeMat(x0, y0, x1, y1, GroundRestitution, BounceFriction)
}

// NewEdgeMat builds an Edge with an explicit restitution / bounce-friction
// material (used by bunker rim edges for a low-bounce, sticky-sand feel).
func NewEdgeMat(x0, y0, x1, y1, restitution, bounceFric float64) Edge {
	dx, dy := x1-x0, y1-y0
	length := math.Hypot(dx, dy)
	if length < 1e-9 {
		return Edge{X0: x0, Y0: y0, X1: x1, Y1: y1, Restitution: restitution, BounceFric: bounceFric}
	}
	tx, ty := dx/length, dy/length
	return Edge{
		X0: x0, Y0: y0, X1: x1, Y1: y1,
		TX: tx, TY: ty,
		NX: ty, NY: -tx,
		Len:         length,
		Restitution: restitution,
		BounceFric:  bounceFric,
	}
}

// circleEdgeContact returns how deep a circle (cx,cy,r) penetrates an edge
// (0 if clear) plus the unit contact normal to push the circle out along.
//
// The segment is treated as having rounded end caps: when the closest point on
// the segment is an endpoint, the contact normal points from that endpoint to
// the circle center. Without caps (perpendicular-band test only, t ∈ [0,Len]),
// adjacent edges of a sampled polyline leave an uncovered notch above every
// convex corner — a ball whose center lands in a notch is claimed by NO edge,
// so it free-falls into the surface and can be frozen there by rest detection
// (the "ball sinks into the sand / down to the terrain" bug). Sharp convex
// corners (e.g. a bunker rim meeting terrain in a near-cliff) have big notches.
//
// One-sided: a ball on the "ground" side (sd < -r) is not pushed through from
// below, so tee platforms and future polygon obstacles don't grab balls rolling
// beneath them. End caps only grab from the open-air side (sd >= 0) so a ball
// passing behind an endpoint isn't yanked around it.
func circleEdgeContact(cx, cy, r float64, e Edge) (pen, nx, ny float64) {
	if e.Len < 1e-9 {
		return 0, 0, 0
	}
	dx, dy := cx-e.X0, cy-e.Y0
	sd := dx*e.NX + dy*e.NY // positive = open-air side
	if sd < -r || sd >= r {
		return 0, 0, 0
	}
	t := dx*e.TX + dy*e.TY
	if t >= 0 && t <= e.Len {
		return r - sd, e.NX, e.NY
	}
	if sd < 0 {
		return 0, 0, 0
	}
	if t < 0 {
		t = 0
	} else {
		t = e.Len
	}
	px, py := e.X0+t*e.TX, e.Y0+t*e.TY
	ddx, ddy := cx-px, cy-py
	dist := math.Hypot(ddx, ddy)
	if dist >= r || dist < 1e-9 {
		return 0, 0, 0
	}
	return r - dist, ddx / dist, ddy / dist
}

// Ball is a single golf ball. Y increases downward (screen convention).
type Ball struct {
	X, Y           float64
	VX, VY         float64
	Radius         float64
	Resting        bool    // true when speed < RestSpeedThreshold while touching ground
	airTicks       int     // consecutive ticks spent off all floor-type surfaces
	prevTX, prevTY float64 // tangent of the last floor-type edge the ball touched
	wedgeTicks     int     // consecutive ticks blocked in place (see wedge detection)
	noTouchTicks   int     // consecutive ticks with no edge contact at all
	stillTime      float64 // seconds spent continuously below RestSpeedThreshold near contact
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
	b.stillTime = 0
	b.noTouchTicks = 0
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
	// A resting ball is fully locked — no gravity injection, no position update —
	// until Shoot() clears b.Resting. This prevents gravity from nudging the ball
	// off a slope between the frame it comes to rest and the frame the player shoots,
	// matching the reliable freeze behaviour of the water-penalty reset.
	if b.Resting {
		b.VX, b.VY = 0, 0
		return
	}

	prevVX, prevVY := b.VX, b.VY
	startX, startY := b.X, b.Y

	b.VY += Gravity * dt
	b.X += b.VX * dt
	b.Y += b.VY * dt

	floorPen := 0.0
	floorIdx := -1
	// Contact normal of the deepest floor contact. For a contact on an edge's
	// interior this equals the edge normal; for an end-cap (corner) contact it
	// points from the corner to the ball center. All floor physics below runs
	// in this contact frame, not the raw edge frame, so a ball perched on a
	// convex corner rolls around it instead of snapping between edge planes.
	fNX, fNY := 0.0, 0.0
	touchedAny := false // any edge contact (floor OR wall), for rest detection

	for i, e := range edges {
		// Broad-phase X check (handles edges in either direction).
		lo, hi := e.X0, e.X1
		if lo > hi {
			lo, hi = hi, lo
		}
		if b.X+b.Radius < lo || b.X-b.Radius > hi {
			continue
		}

		pen, cnx, cny := circleEdgeContact(b.X, b.Y, b.Radius, e)
		if pen <= 0 {
			continue
		}
		touchedAny = true

		if cny < floorNYCutoff {
			// Floor-type: accumulate deepest for rolling physics.
			if pen > floorPen {
				floorPen = pen
				floorIdx = i
				fNX, fNY = cnx, cny
			}
		} else {
			// Wall/obstacle-type: resolve immediately so the leading edge of the
			// ball stops against steep surfaces rather than riding up them.
			b.X += cnx * pen
			b.Y += cny * pen
			vn := b.VX*cnx + b.VY*cny
			if vn < 0 { // only correct if moving into this surface
				ctx, cty := -cny, cnx // contact tangent (matches edge T for interior contacts)
				if -vn > MinBounceSpeed {
					vt := b.VX*ctx + b.VY*cty
					vn = -vn * e.Restitution
					vt *= e.BounceFric
					b.VX = vn*cnx + vt*ctx
					b.VY = vn*cny + vt*cty
				} else {
					// Gentle contact — just kill the into-surface component.
					b.VX -= vn * cnx
					b.VY -= vn * cny
				}
			}
		}
	}

	// Floor rolling physics, in the contact frame of the deepest floor contact.
	slopeGravAccel := 0.0
	touching := floorIdx >= 0
	if touching {
		e := edges[floorIdx] // material properties (restitution / bounce friction)
		fTX, fTY := -fNY, fNX

		b.X += fNX * floorPen
		b.Y += fNY * floorPen

		vn := b.VX*fNX + b.VY*fNY
		vt := b.VX*fTX + b.VY*fTY

		slopeGravAccel = Gravity * fTY
		slopeGravDt := slopeGravAccel * dt

		// A transition only counts as "smooth rolling" if the ball was already
		// touching a floor-type surface AND the new contact's tangent direction is
		// close to the one it was just rolling on. A sharp jump (even between two
		// contacts that both individually classify as floor-type) is a real impact,
		// not a continuation — see rollContinuityDot.
		continuous := fTX*b.prevTX+fTY*b.prevTY >= rollContinuityDot
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
			vn = -vn * e.Restitution
			vt *= e.BounceFric
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

		b.VX = vn*fNX + vt*fTX
		b.VY = vn*fNY + vt*fTY
		b.airTicks = 0
		b.prevTX, b.prevTY = fTX, fTY
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
			pen, cnx, cny := circleEdgeContact(b.X, b.Y, b.Radius, e)
			if pen > 1e-6 {
				// Push slightly past zero penetration (not just to it) so float
				// rounding doesn't leave a hairline overlap that the next edge's
				// correction (or the next tick) re-discovers, which is what was
				// producing a small but persistent visible sink into sharp corners.
				b.X += cnx * (pen + 1e-4)
				b.Y += cny * (pen + 1e-4)
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
	//
	// Uses touchedAny (contact with ANY edge) rather than only floor-type
	// contact: a ball wedged in a sharp V where BOTH walls are too steep to
	// classify as floor (e.g. a steep bunker rim meeting a steep hill face) has
	// floorIdx = -1 yet is genuinely motionless — gating on floor contact alone
	// left it permanently un-restable (soft-lock). Speed + accel thresholds still
	// prevent a moving or airborne ball from being marked resting.
	// Wedge detection: a ball is "blocked" when it's touching an edge yet its
	// actual displacement this tick is far less than its speed implies — i.e.
	// something is holding it in place. Sustained blocking (wedgeRestTicks in a
	// row) means it's stuck in a V and stuck in a velocity limit cycle, so force
	// it to rest. A real bounce blocks for only a tick or two before the ball
	// moves away again, resetting the counter.
	moved := math.Hypot(b.X-startX, b.Y-startY)
	blocked := touchedAny && speed >= RestSpeedThreshold && moved < 0.5*speed*dt
	// Decay rather than hard-reset: a shallow limit cycle (e.g. a V with one
	// bouncy terrain wall feeding energy back and one low-bounce bunker wall)
	// is blocked most ticks but occasionally slips, which a hard reset would
	// mistake for progress. Decaying keeps the count net-positive while the ball
	// is genuinely stuck yet drops it to zero for a ball actually rolling away.
	if blocked {
		b.wedgeTicks++
	} else if b.wedgeTicks > 0 {
		b.wedgeTicks--
	}

	// Stillness timer: sustained sub-threshold speed while in (or within a
	// couple ticks of) contact forces rest. This is the net that catches a ball
	// wedged in a V whose velocity flips direction every tick between the two
	// wall tangents: speed stays ~5 px/s (under RestSpeedThreshold, so the
	// blocked/wedge detector ignores it) while |Δv|/dt reads as hundreds of
	// px/s² (so the accel check never passes). The two-tick contact grace keeps
	// hairline touch flicker — depenetration overshoot lifting the ball 1e-4 px
	// clear on alternate ticks — from resetting the timer; a genuinely airborne
	// slow ball (apex of a lob) racks up noTouchTicks fast and is unaffected.
	if touchedAny {
		b.noTouchTicks = 0
	} else {
		b.noTouchTicks++
	}
	if speed < RestSpeedThreshold && b.noTouchTicks <= 2 {
		b.stillTime += dt
	} else {
		b.stillTime = 0
	}

	if b.wedgeTicks >= wedgeRestTicks || b.stillTime >= RestStillTime {
		b.VX, b.VY = 0, 0
		b.Resting = true
		b.wedgeTicks = 0
		b.stillTime = 0
	} else {
		b.Resting = touchedAny && speed < RestSpeedThreshold && accel < RestAccelThreshold
		if b.Resting {
			b.VX, b.VY = 0, 0
		}
	}
}
