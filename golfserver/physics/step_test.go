package physics

import (
	"math"
	"testing"
)

// Sweep a range of V half-widths and drop offsets to find which configurations
// still fail to settle (soft-lock) or flicker resting.
func TestVSweep(t *testing.T) {
	for _, half := range []float64{10, 20, 40, 60, 90, 130} {
		for _, mat := range []string{"terrain", "bunker"} {
			mk := func(x0, y0, x1, y1 float64) Edge {
				if mat == "bunker" {
					return NewEdgeMat(x0, y0, x1, y1, 0.05, 0.35)
				}
				return NewEdge(x0, y0, x1, y1)
			}
			// V bottom at (0,400); walls rise by 150 over 'half' in x.
			edges := []Edge{
				mk(-half, 250, 0, 400),
				mk(0, 400, half, 250),
			}
			ball := NewBall(0, 300, 10)
			ball.Resting = false
			restedAt := -1
			flickered := false
			wasResting := false
			for i := 0; i < 400; i++ {
				ball.Tick(dt, edges, -1e6, 1e6, -1e9)
				if ball.Resting && restedAt < 0 {
					restedAt = i
				}
				if wasResting && !ball.Resting {
					flickered = true
				}
				wasResting = ball.Resting
			}
			ny := edges[0].NY
			t.Logf("half=%3.0f mat=%-7s NY=%.3f wall=%v  rested@%d flicker=%v final_rest=%v",
				half, mat, ny, ny >= floorNYCutoff, restedAt, flickered, ball.Resting)
		}
	}
}

// Mixed-material V: one bouncy terrain wall + one low-bounce bunker wall, at a
// range of steepnesses and asymmetries. The bouncy wall can feed energy back and
// sustain a shallow limit cycle. All must settle.
func TestVMixedMaterial(t *testing.T) {
	for _, lh := range []float64{20, 40, 80, 130} {
		for _, rh := range []float64{20, 40, 80, 130} {
			edges := []Edge{
				NewEdge(-lh, 250, 0, 400),                 // terrain (bouncy 0.55) left wall
				NewEdgeMat(0, 400, rh, 250, 0.05, 0.35),   // bunker rim right wall
			}
			ball := NewBall(-1, 300, 10)
			ball.Resting = false
			restedAt := -1
			for i := 0; i < 600; i++ {
				ball.Tick(dt, edges, -1e6, 1e6, -1e9)
				if ball.Resting {
					restedAt = i
					break
				}
			}
			if restedAt < 0 {
				t.Errorf("lh=%.0f rh=%.0f: NEVER RESTED (soft-lock)", lh, rh)
			} else {
				t.Logf("lh=%3.0f rh=%3.0f rested@%d", lh, rh, restedAt)
			}
		}
	}
}

// Faithful reproduction of the reported case: ball resting on a terrain crest
// exactly where a bunker rim begins at ground level and rises into its dome.
// Terrain is a gentle crest; the rim's left end is coincident with the terrain
// surface at the crest, so the ball touches both terrain (floor) and the
// one-sided rim edge. Tests several drop offsets around the junction.
func TestBunkerLeftEdgeCrest(t *testing.T) {
	// Terrain crest peaking at (0, 400), gentle sides, flattening into run-outs
	// past ±300 so a ball that legitimately rolls off the crest has ground to
	// settle on instead of exiting the modeled strip and free-falling forever
	// (which this test previously misreported as a soft-lock).
	terrainY := func(x float64) float64 {
		xc := math.Max(-300, math.Min(x, 300))
		return 400 + 0.0007*xc*xc
	}
	terrain := []Edge{}
	for x := -900.0; x < 900; x += 4 {
		terrain = append(terrain, NewEdge(x, terrainY(x), x+4, terrainY(x+4)))
	}
	// Bunker rim: starts at the crest at ground level, rises right into a dome,
	// comes back down. Only add the above-terrain portion (as rebuildEdges does).
	rim := []Edge{}
	rimY := func(x float64) float64 {
		// dome from x=0..240, peak ~70px above crest at x=120
		if x < 0 || x > 240 {
			return 1e9
		}
		return 400 - 70*math.Sin(math.Pi*x/240)
	}
	const clearance = 14.0
	cleared := func(x float64) bool { return rimY(x) < terrainY(x)-clearance }
	for x := 0.0; x < 240; x += 5 {
		if cleared(x) && cleared(x+5) {
			rim = append(rim, NewEdgeMat(x, rimY(x), x+5, rimY(x+5), 0.05, 0.35))
		}
	}
	edges := append(append([]Edge{}, terrain...), rim...)

	// Drop from above the dome and sub-step 4× per frame exactly as the game
	// loop does, so short edges aren't tunneled at impact speed.
	subDt := dt / 4
	for _, dropX := range []float64{-30, -10, 0, 10, 40, 80, 120} {
		ball := NewBall(dropX, 200, 10)
		ball.Resting = false
		restedAt := -1
		for i := 0; i < 1200; i++ {
			for ss := 0; ss < 4; ss++ {
				ball.Tick(subDt, edges, -900, 900, -1e9)
			}
			if ball.Resting {
				restedAt = i
				break
			}
		}
		if restedAt < 0 {
			t.Errorf("dropX=%.0f: NEVER RESTED (soft-lock) final=(%.1f,%.1f) v=(%.1f,%.1f)",
				dropX, ball.X, ball.Y, ball.VX, ball.VY)
		} else {
			t.Logf("dropX=%3.0f rested@%d at (%.1f,%.1f)", dropX, restedAt, ball.X, ball.Y)
		}
	}
}

// Same but with the ball entering from the side (rolling in), which is closer
// to the reported "ball rolled up to the bunker edge" case.
func TestVSweepRollIn(t *testing.T) {
	for _, half := range []float64{20, 40, 60, 90, 130} {
		edges := []Edge{
			NewEdge(-300, 400, -half, 400), // flat approach
			NewEdgeMat(-half, 400, 0, 250, 0.05, 0.35), // bunker rim rising (left wall of V is steep)
			NewEdge(0, 250, half, 400),      // far terrain wall
		}
		ball := NewBall(-250, 390, 10)
		ball.Shoot(180, 0) // roll right into the V
		restedAt, flickered, wasResting := -1, false, false
		for i := 0; i < 500; i++ {
			ball.Tick(dt, edges, -1e6, 1e6, -1e9)
			if ball.Resting && restedAt < 0 {
				restedAt = i
			}
			if wasResting && !ball.Resting {
				flickered = true
			}
			wasResting = ball.Resting
		}
		t.Logf("half=%3.0f rested@%d flicker=%v final=(%.1f,%.1f) rest=%v",
			half, restedAt, flickered, ball.X, ball.Y, ball.Resting)
	}
}
