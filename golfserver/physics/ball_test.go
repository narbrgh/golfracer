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

	ball.Shoot(150, -300) // arcing shot: rightward and upward

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
	if speed >= RestSpeedThreshold {
		t.Fatalf("expected speed < %.1f at rest, got %.2f (vx=%.2f vy=%.2f)", RestSpeedThreshold, speed, ball.VX, ball.VY)
	}
}

// TestBallNeverPassesThroughGround is a basic sanity check that, at a
// normal shot speed and the standard tick rate, the ball never ends up
// below the ground line.
func TestBallNeverPassesThroughGround(t *testing.T) {
	groundY := 400.0
	radius := 10.0
	ball := NewBall(50, 100, radius)
	ball.Shoot(0, 50) // straight down, no arc

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

// TestShootIgnoredWhileMoving confirms the "must be at rest to shoot"
// rule is enforced at the physics layer, not just trusted to the caller.
func TestShootIgnoredWhileMoving(t *testing.T) {
	ball := NewBall(50, 100, 10)
	ball.Shoot(100, -200)

	if ball.Resting {
		t.Fatal("ball should not be resting immediately after a shot")
	}

	// Try to shoot again mid-flight — should be a no-op.
	ball.Shoot(999, 999)

	if ball.VX == 999 || ball.VY == 999 {
		t.Fatal("Shoot should be ignored while the ball is still moving")
	}
}
