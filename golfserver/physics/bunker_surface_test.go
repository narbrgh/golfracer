package physics

import (
	"math"
	"testing"
)

// TestMergedBunkerSurfaceSettles reproduces the logged soft-lock scene as a
// single merged surface: terrain descending to the right with a raised sand
// dome over part of it. The collision surface is min(terrain, sand) — one
// continuous line the ball rolls on top of, with no floating rim edges. The
// ball must settle rather than bounce forever.
func TestMergedBunkerSurfaceSettles(t *testing.T) {
	// Terrain: descends to the right (matches the logged slope ~26°), then
	// flattens into a run-out past x=1800 so a ball that legitimately rolls out
	// of the bunker downhill has real ground to settle on instead of exiting
	// the modeled strip and free-falling forever (which this test previously
	// misreported as a soft-lock).
	terrainY := func(x float64) float64 {
		xc := math.Max(1400, math.Min(x, 1800))
		return 560 + 0.5*(xc-1480)
	}
	// Sand dome centred ~1560, rising above the terrain in the middle.
	sandY := func(x float64) float64 {
		if x < 1500 || x > 1640 {
			return 1e9
		}
		return terrainY(1570) - 70*math.Sin(math.Pi*(x-1500)/140)
	}
	surface := func(x float64) (float64, bool) {
		y := terrainY(x)
		if s := sandY(x); s < y {
			return s, true
		}
		return y, false
	}

	// Build merged-surface edges the same way rebuildEdges now does.
	var edges []Edge
	const step = 4.0
	px := 1400.0
	py, psand := surface(px)
	for x := 1400.0 + step; x <= 2600; x += step {
		y, sand := surface(x)
		if psand || sand {
			edges = append(edges, NewEdgeMat(px, py, x, y, 0.05, 0.35))
		} else {
			edges = append(edges, NewEdge(px, py, x, y))
		}
		px, py, psand = x, y, sand
	}

	subDt := dt / 4
	for _, dropX := range []float64{1505, 1520, 1540, 1570, 1610, 1635} {
		ball := NewBall(dropX, 300, 10)
		ball.Resting = false
		restedAt := -1
		for i := 0; i < 1500 && restedAt < 0; i++ {
			for ss := 0; ss < 4; ss++ {
				ball.Tick(subDt, edges, 1400, 2600, -1e9)
			}
			if ball.Resting {
				restedAt = i
			}
		}
		if restedAt < 0 {
			t.Errorf("dropX=%.0f: never settled (bounce/soft-lock) final=(%.1f,%.1f) v=(%.1f,%.1f)",
				dropX, ball.X, ball.Y, ball.VX, ball.VY)
		} else {
			t.Logf("dropX=%4.0f settled@%d at (%.1f,%.1f)", dropX, restedAt, ball.X, ball.Y)
		}
	}
}
