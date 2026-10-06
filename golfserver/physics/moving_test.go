package physics

import (
	"math"
	"testing"
)

// subDt matches the server's 60 Hz tick split into 4 physics sub-steps.
const subDt = dt / 4

// slab is a wide horizontal platform top at height y0 that translates with
// velocity (vx, vy) starting from rest at t=0. It is rebuilt every sub-step the
// way holegeom does for animated platforms: the position at time t plus the
// surface velocity.
func slab(y0, vx, vy, t float64) []Edge {
	ox, oy := vx*t, vy*t
	return []Edge{NewEdge(-1e5+ox, y0+oy, 1e5+ox, y0+oy).WithVelocity(vx, vy, vx, vy)}
}

// settleOn drops a ball onto the static ground until it rests, so the test starts
// from a realistic resting ball rather than a hand-placed one.
func restedBallOn(edges []Edge, x, y float64) *Ball {
	b := NewBall(x, y, 10)
	b.Resting = false
	for i := 0; i < 4*120 && !b.Resting; i++ {
		b.Tick(subDt, edges, -1e6, 1e6, -1e9)
	}
	return b
}

func TestBallRidesHorizontallySlidingPlatform(t *testing.T) {
	const vx = 100.0
	b := NewBall(0, 470, 10)
	b.Resting = false
	var tm float64
	for i := 0; i < 4*60*3; i++ { // 3 seconds
		b.Tick(subDt, slab(500, vx, 0, tm), -1e6, 1e6, -1e9)
		tm += subDt
	}
	if !b.Resting || !b.Riding {
		t.Fatalf("ball should be resting-and-riding on the moving platform (resting=%v riding=%v)", b.Resting, b.Riding)
	}
	// Carried along: after ~3s at 100 px/s the platform moved ~300px; the ball must
	// have come with it (allowing for the landing's initial settle).
	if b.X < 250 {
		t.Fatalf("ball was left behind: x=%.1f after 3s of a 100px/s platform", b.X)
	}
	// And is still sitting on the surface, not sunk or floating.
	if math.Abs(b.Y-490) > 1.5 {
		t.Fatalf("ball y=%.2f should sit on the platform top (ball centre ≈ 490)", b.Y)
	}
}

func TestBallRidesRisingAndFallingPlatforms(t *testing.T) {
	for _, vy := range []float64{-80, 80} {
		b := NewBall(0, 470, 10)
		b.Resting = false
		var tm float64
		for i := 0; i < 4*60*2; i++ {
			b.Tick(subDt, slab(500, 0, vy, tm), -1e6, 1e6, -1e9)
			tm += subDt
		}
		wantY := 500 + vy*tm - 10
		if !b.Resting || !b.Riding {
			t.Fatalf("vy=%v: should be resting+riding (resting=%v riding=%v)", vy, b.Resting, b.Riding)
		}
		if math.Abs(b.Y-wantY) > 2 {
			t.Fatalf("vy=%v: ball y=%.2f, platform surface implies %.2f", vy, b.Y, wantY)
		}
	}
}

func TestRidingBallCanBeShot(t *testing.T) {
	b := NewBall(0, 470, 10)
	b.Resting = false
	var tm float64
	for i := 0; i < 4*60*2; i++ {
		b.Tick(subDt, slab(500, 100, 0, tm), -1e6, 1e6, -1e9)
		tm += subDt
	}
	if !b.Resting {
		t.Fatal("setup: ball should be resting")
	}
	b.Shoot(0, -300, 0, 0, false)
	if b.Resting || b.Riding {
		t.Fatalf("a shot must clear resting and riding (resting=%v riding=%v)", b.Resting, b.Riding)
	}
	b.Tick(subDt, slab(500, 100, 0, tm), -1e6, 1e6, -1e9)
	if b.VY > -250 {
		t.Fatalf("shot velocity should survive the first tick, got vy=%.1f", b.VY)
	}
}

func TestRidingBallFallsWhenPlatformLeaves(t *testing.T) {
	b := NewBall(0, 470, 10)
	b.Resting = false
	var tm float64
	for i := 0; i < 4*60*2; i++ {
		b.Tick(subDt, slab(500, 100, 0, tm), -1e6, 1e6, -1e9)
		tm += subDt
	}
	if !b.Resting || !b.Riding {
		t.Fatal("setup: ball should be resting and riding")
	}
	y0 := b.Y
	for i := 0; i < 4*30; i++ { // half a second with nothing underneath
		b.Tick(subDt, nil, -1e6, 1e6, -1e9)
	}
	if b.Resting || b.Riding {
		t.Fatalf("ball should no longer rest once its support is gone (resting=%v riding=%v)", b.Resting, b.Riding)
	}
	if b.Y <= y0+20 {
		t.Fatalf("ball should be falling, y went %.1f → %.1f", y0, b.Y)
	}
}

// A vertical wall sweeping into a resting ball shoves it.
func TestMovingWallShovesBall(t *testing.T) {
	const wallV = 200.0
	ground := flatGround(500)
	b := restedBallOn(ground, 300, 480)
	if !b.Resting {
		t.Fatal("setup: ball should be resting")
	}
	var tm float64
	for i := 0; i < 4*60*2; i++ {
		wx := 100 + wallV*tm
		// Right-facing wall: tangent points down so the outward normal (TY,-TX) is +x.
		wall := NewEdge(wx, 400, wx, 500).WithVelocity(wallV, 0, wallV, 0)
		b.Tick(subDt, append([]Edge{wall}, ground...), -1e6, 1e6, -1e9)
		tm += subDt
	}
	if b.X < 330 {
		t.Fatalf("ball should have been pushed right by the wall, x=%.1f (started at 300)", b.X)
	}
}

func TestSurfaceVelBlendsEndpoints(t *testing.T) {
	// A blade rotating about its left end at ω = 2 rad/s: velocity grows linearly
	// with distance from the pivot, so at the midpoint it is half the tip's.
	e := NewEdge(0, 0, 100, 0).WithVelocity(0, 0, 0, 200)
	if _, vy := e.SurfaceVel(50, 0); math.Abs(vy-100) > 1e-9 {
		t.Fatalf("midpoint velocity = %v, want 100", vy)
	}
	if _, vy := e.SurfaceVel(500, 0); math.Abs(vy-200) > 1e-9 {
		t.Fatalf("beyond the tip should clamp to tip velocity, got %v", vy)
	}
	static := NewEdge(0, 0, 100, 0)
	if vx, vy := static.SurfaceVel(50, 0); vx != 0 || vy != 0 {
		t.Fatalf("static edge must report zero velocity, got (%v,%v)", vx, vy)
	}
}

// Guard for the whole feature: a ball settling on a static edge behaves exactly
// as before — never riding, ends with zero velocity.
func TestStaticGroundNeverRides(t *testing.T) {
	b := restedBallOn(flatGround(500), 100, 300)
	if !b.Resting || b.Riding || b.VX != 0 || b.VY != 0 {
		t.Fatalf("static rest changed: resting=%v riding=%v v=(%v,%v)", b.Resting, b.Riding, b.VX, b.VY)
	}
}
