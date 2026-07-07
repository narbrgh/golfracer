package physics

import (
	"math"
	"testing"
)

const dt = 1.0 / 60.0

// flatGround returns a single horizontal edge representing flat ground at the given Y.
func flatGround(y float64) []Edge {
	return []Edge{NewEdge(-1e6, y, 1e6, y)}
}

// TestBallFallsAndSettles checks the full lifecycle: shoot it, watch it
// go airborne, and confirm it eventually settles to rest sitting on the
// ground with zero velocity.
func TestBallFallsAndSettles(t *testing.T) {
	groundY := 400.0
	radius := 10.0
	ball := NewBall(50, 100, radius)

	ball.Shoot(150, -300, 0, 0, false) // arcing shot: rightward and upward

	edges := flatGround(groundY)
	sawAirborne := false
	for i := 0; i < 600; i++ { // 10s upper bound, generous for this shot
		ball.Tick(dt, edges, -1e6, 1e6, -1e9)
		if !ball.Resting {
			sawAirborne = true
		} else {
			break
		}
	}

	if !sawAirborne {
		t.Fatal("expected the ball to be airborne at some point after Shoot")
	}
	if !ball.Resting {
		t.Fatal("expected the ball to settle to rest within 10 seconds")
	}

	expectedRestY := groundY - radius
	if math.Abs(ball.Y-expectedRestY) > 0.5 {
		t.Fatalf("expected ball resting at y=%.2f, got y=%.2f", expectedRestY, ball.Y)
	}
	speed := math.Hypot(ball.VX, ball.VY)
	if speed >= Current.RestSpeedThreshold {
		t.Fatalf("expected speed < %.1f at rest, got %.2f (vx=%.2f vy=%.2f)", Current.RestSpeedThreshold, speed, ball.VX, ball.VY)
	}
}

// TestBallNeverPassesThroughGround is a basic sanity check that, at a
// normal shot speed and the standard tick rate, the ball never ends up
// below the ground line.
func TestBallNeverPassesThroughGround(t *testing.T) {
	groundY := 400.0
	radius := 10.0
	ball := NewBall(50, 100, radius)
	ball.Shoot(0, 50, 0, 0, false) // straight down, no arc

	edges := flatGround(groundY)
	for i := 0; i < 600; i++ {
		ball.Tick(dt, edges, -1e6, 1e6, -1e9)
		if ball.Y+ball.Radius > groundY+0.01 {
			t.Fatalf("ball ended up below ground at tick %d: y=%.2f", i, ball.Y)
		}
		if ball.Resting {
			break
		}
	}
}

// TestGroundedPuttDoesNotHop verifies the putt-bounce fix: a putt (grounded
// shot) launched horizontally from a ball resting on flat ground rolls without
// ever hopping above its launch height. Before the fix, the tick-one gravity
// injection was read as a fresh landing and could bounce the ball off the tee.
func TestGroundedPuttDoesNotHop(t *testing.T) {
	groundY := 400.0
	radius := 10.0
	startY := groundY - radius
	ball := NewBall(50, startY, radius)

	// A putt with a slight downward component — the case that bounces without the
	// grounded fix (tick-one gravity + downward vy reads as a hard landing and the
	// ball hops ~1.5px off the tee). With grounded=true it stays glued and rolls.
	ball.Shoot(300, 120, 0, 0, true)

	edges := flatGround(groundY)
	minY := ball.Y // smallest Y = highest point reached
	for i := 0; i < 600; i++ {
		ball.Tick(dt, edges, -1e6, 1e6, -1e9)
		if ball.Y < minY {
			minY = ball.Y
		}
		if ball.Resting {
			break
		}
	}
	// Any real hop lifts the center measurably above rest height. Allow a hair
	// of numerical slack for the depenetration overshoot (1e-4 px).
	if startY-minY > 0.05 {
		t.Fatalf("putt hopped: rose %.3f px above launch height (minY=%.3f, startY=%.3f)", startY-minY, minY, startY)
	}
	if !ball.Resting {
		t.Fatal("putt never came to rest")
	}
}

// TestShootIgnoredWhileMoving confirms the "must be at rest to shoot"
// rule is enforced at the physics layer, not just trusted to the caller.
func TestShootIgnoredWhileMoving(t *testing.T) {
	ball := NewBall(50, 100, 10)
	ball.Shoot(100, -200, 0, 0, false)

	if ball.Resting {
		t.Fatal("ball should not be resting immediately after a shot")
	}

	// Try to shoot again mid-flight — should be a no-op.
	ball.Shoot(999, 999, 0, 0, false)

	if ball.VX == 999 || ball.VY == 999 {
		t.Fatal("Shoot should be ignored while the ball is still moving")
	}
}
