package physics

import "testing"

// TestBackspinTradesCarryForStop pins the rebalanced spin behavior on a flat-ground
// drive: backspin now flies higher but lands SHORTER than no-spin (carry is a penalty,
// not a bonus) and still checks up on landing, while topspin dives and runs out
// farthest. Guards against a regression back to "backspin = more distance AND a stop".
func TestBackspinTradesCarryForStop(t *testing.T) {
	saved := Current
	Current = DefaultTunables()
	defer func() { Current = saved }()

	const groundY = 400.0
	const radius = 10.0
	edges := []Edge{NewEdge(0, groundY, 4000, groundY)}

	// shoot returns total roll-out distance (final rest X) and carry (X at the first
	// ground contact after going airborne) for a given spin. Launch is a rising
	// rightward drive from a ball resting on the flat.
	shoot := func(spin int) (dist, carry float64) {
		b := NewBall(50, groundY-radius, radius)
		b.Resting = true
		b.Shoot(1200, -700, spin, 0, false)
		sawAir := false
		carry = -1
		for i := 0; i < 3000; i++ {
			b.Tick(dt, edges, -1e6, 1e6, -1e9)
			if b.airTicks > 0 {
				sawAir = true
			}
			// First return to the ground after being airborne = the carry landing point.
			if carry < 0 && sawAir && b.airTicks == 0 {
				carry = b.X
			}
			if b.Resting {
				break
			}
		}
		if !b.Resting {
			t.Fatalf("spin=%d never came to rest", spin)
		}
		if carry < 0 {
			carry = b.X // never left the ground (shouldn't happen for this launch)
		}
		return b.X, carry
	}

	distBack, carryBack := shoot(-1)
	distNone, carryNone := shoot(0)
	distTop, carryTop := shoot(1)
	_ = carryTop

	t.Logf("carry:  back=%.0f none=%.0f top=%.0f", carryBack, carryNone, carryTop)
	t.Logf("dist:   back=%.0f none=%.0f top=%.0f", distBack, distNone, distTop)
	t.Logf("roll:   back=%.0f none=%.0f top=%.0f", distBack-carryBack, distNone-carryNone, distTop-carryTop)

	// Core fix: backspin now travels LESS total distance than no-spin. (It may hang
	// slightly longer in the air — a high floaty shot — but the killed roll-out makes
	// its total the shortest of the three, which is what the player experiences.)
	if distBack >= distNone {
		t.Errorf("backspin total distance should be LESS than no-spin: back=%.0f none=%.0f", distBack, distNone)
	}
	// Identity preserved: topspin dives lower but runs out farthest overall.
	if distTop <= distNone {
		t.Errorf("topspin total distance should exceed no-spin: top=%.0f none=%.0f", distTop, distNone)
	}
	// Landing bite intact: backspin checks up — its roll-out is short (shorter than topspin's run).
	rollBack := distBack - carryBack
	rollTop := distTop - carryTop
	if rollBack >= rollTop {
		t.Errorf("backspin should roll out less than topspin (check-up): rollBack=%.0f rollTop=%.0f", rollBack, rollTop)
	}
}
