package physics

import (
	"math"
	"testing"
)

// TestBallRestsInSharpVWedge guards against the bunker "V soft-lock": a ball
// dropped into a sharp V between two steep wall-type edges (like a bunker rim
// meeting a steep hill face) used to be held in place by the walls while gravity
// pumped its velocity into a permanent limit cycle — position frozen, speed
// never dropping below RestSpeedThreshold, so Resting never latched and the
// player could never shoot it out. It must now settle to rest.
func TestBallRestsInSharpVWedge(t *testing.T) {
	// ~78.7° walls: NY = -0.196 > floorNYCutoff (-0.2), so both are wall-type.
	edges := []Edge{
		NewEdge(-30, 250, 0, 400), // down-right
		NewEdge(0, 400, 30, 250),  // up-right
	}
	ball := NewBall(0, 300, 10)
	ball.Resting = false

	rested := false
	for i := 0; i < 300; i++ {
		ball.Tick(dt, edges, -1e6, 1e6, -1e9)
		if ball.Resting {
			rested = true
			break
		}
	}
	if !rested {
		t.Fatal("ball wedged in a sharp V never came to rest (soft-lock)")
	}
	if s := math.Hypot(ball.VX, ball.VY); s != 0 {
		t.Fatalf("resting ball should have zero velocity, got speed=%.3f", s)
	}
}
