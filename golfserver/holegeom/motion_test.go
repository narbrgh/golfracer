package holegeom

import (
	"math"
	"testing"

	"golf01/server/terrain"
)

func squarePlat(x, y float64) []terrain.ControlPoint {
	return []terrain.ControlPoint{{X: x, Y: y}, {X: x + 40, Y: y}, {X: x + 40, Y: y + 20}, {X: x, Y: y + 20}}
}

func TestAnimatedPlatformsAreNotBakedIntoStaticEdges(t *testing.T) {
	base := terrain.DefaultHole()
	base.Platforms = []terrain.Platform{{Points: squarePlat(100, 100)}}
	staticOnly := len(Build(base).Edges)

	moving := base
	moving.Platforms = []terrain.Platform{
		{Points: squarePlat(100, 100)}, // static
		{ID: "mover", Points: squarePlat(300, 100), Motion: &terrain.Motion{
			Kind: "path", Waypoints: []terrain.ControlPoint{{X: 100, Y: 0}}, Speed: 100, Mode: "pingpong", Ease: "linear"}},
	}
	g := Build(moving)
	if len(g.Edges) != staticOnly {
		t.Fatalf("static edge count changed: %d vs %d (animated platform leaked into static edges)", len(g.Edges), staticOnly)
	}
	if !g.HasMotion() {
		t.Fatal("HasMotion should be true")
	}
	if n := len(g.AnimatedEdges(0)); n != 4 {
		t.Fatalf("animated square should contribute 4 edges, got %d", n)
	}
}

func TestAnimatedEdgesCarryPositionAndVelocity(t *testing.T) {
	h := terrain.DefaultHole()
	h.Platforms = []terrain.Platform{{ID: "m", Points: squarePlat(300, 100), Motion: &terrain.Motion{
		Kind: "path", Waypoints: []terrain.ControlPoint{{X: 100, Y: 0}}, Speed: 100, Mode: "pingpong", Ease: "linear"}}}
	g := Build(h)

	// At t=0.5 the platform has slid 50px right and is moving right at 100 px/s.
	edges := g.AnimatedEdges(0.5)
	minX := math.Inf(1)
	for _, e := range edges {
		minX = math.Min(minX, math.Min(e.X0, e.X1))
		if !e.Moving {
			t.Fatal("animated edge must be marked Moving")
		}
		if math.Abs(e.VX0-100) > 0.5 || math.Abs(e.VY0) > 0.5 || math.Abs(e.VX1-100) > 0.5 {
			t.Fatalf("surface velocity = (%.2f,%.2f)→(%.2f,%.2f), want (100,0)", e.VX0, e.VY0, e.VX1, e.VY1)
		}
	}
	if math.Abs(minX-350) > 1e-6 {
		t.Fatalf("platform left edge at %.3f, want 350 (300 + 50px of travel)", minX)
	}
}

func TestRotatingPlatformVelocityMatchesOmegaTimesRadius(t *testing.T) {
	h := terrain.DefaultHole()
	pivot := terrain.ControlPoint{X: 200, Y: 200}
	// 30 rpm = π rad/s. A vertex 100px from the pivot moves at π·100 ≈ 314 px/s.
	h.Platforms = []terrain.Platform{{ID: "r", Points: []terrain.ControlPoint{{X: 200, Y: 195}, {X: 300, Y: 195}, {X: 300, Y: 205}, {X: 200, Y: 205}},
		Motion: &terrain.Motion{Kind: "rotate", Pivot: &pivot, RPM: 30}}}
	g := Build(h)
	max := 0.0
	for _, e := range g.AnimatedEdges(0) {
		max = math.Max(max, math.Max(math.Hypot(e.VX0, e.VY0), math.Hypot(e.VX1, e.VY1)))
	}
	if want := math.Pi * 100; math.Abs(max-want) > 8 { // tip is ~100.1px out
		t.Fatalf("tip speed = %.1f px/s, want ≈ %.1f", max, want)
	}
}

func TestSpeedIsCapped(t *testing.T) {
	h := terrain.DefaultHole()
	h.Platforms = []terrain.Platform{{ID: "fast", Points: squarePlat(300, 100), Motion: &terrain.Motion{
		Kind: "path", Waypoints: []terrain.ControlPoint{{X: 5000, Y: 0}}, Speed: 5000, Mode: "pingpong", Ease: "linear"}}}
	for _, e := range Build(h).AnimatedEdges(0.1) {
		if sp := math.Hypot(e.VX0, e.VY0); sp > terrain.MaxPlatformSpeed+1e-6 {
			t.Fatalf("surface speed %.1f exceeds cap %.1f", sp, terrain.MaxPlatformSpeed)
		}
	}
}

func TestNearbyFiltersAnimatedEdgesByX(t *testing.T) {
	h := terrain.DefaultHole()
	h.Platforms = []terrain.Platform{{ID: "m", Points: squarePlat(1000, 100), Motion: &terrain.Motion{
		Kind: "path", Waypoints: []terrain.ControlPoint{{X: 10, Y: 0}}, Speed: 10, Mode: "pingpong", Ease: "linear"}}}
	g := Build(h)
	far := g.Nearby(100, 10, 0)
	for _, e := range far {
		if e.Moving {
			t.Fatal("a ball at x=100 should not see a platform at x≈1000")
		}
	}
	near := g.Nearby(1010, 10, 0)
	moving := 0
	for _, e := range near {
		if e.Moving {
			moving++
		}
	}
	if moving == 0 {
		t.Fatal("a ball beside the platform should see its edges")
	}
}
