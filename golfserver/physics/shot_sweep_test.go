package physics

import (
	"math"
	"testing"
)

// Regression guard for "ball sinks into the sand / down to the terrain after a
// hit": circle-vs-segment contact used to test only each edge's perpendicular
// band, leaving an uncovered notch above every convex corner of the sampled
// polyline; a ball whose center entered a notch was claimed by no edge and
// could be frozen embedded in the surface by rest detection.
//
// Realistic merged bunker scene with flat run-outs so the ball can't exit the
// domain: flat, then terrain descending right at 26.6°, sand dome on top,
// flat again. Rest the ball at several spots, then sweep shot angles/speeds
// (game max is MAX_DRAG × POWER_SCALE = 1500 px/s) and check the ball never
// ends up below the surface.

func shotSceneEdges() ([]Edge, func(x float64) float64) {
	terrainY := func(x float64) float64 {
		xc := math.Max(1400, math.Min(x, 1800))
		return 560 + 0.5*(xc-1480)
	}
	sandY := func(x float64) float64 {
		if x < 1500 || x > 1640 {
			return 1e9
		}
		return terrainY(1570) - 70*math.Sin(math.Pi*(x-1500)/140)
	}
	surface := func(x float64) float64 {
		y := terrainY(x)
		if s := sandY(x); s < y {
			return s
		}
		return y
	}
	var edges []Edge
	const step = 4.0
	px := 1200.0
	py := surface(px)
	for x := px + step; x <= 2000; x += step {
		y := surface(x)
		sand := sandY(x) < terrainY(x) || sandY(px) < terrainY(px)
		if sand {
			edges = append(edges, NewEdgeMat(px, py, x, y, 0.05, 0.35))
		} else {
			edges = append(edges, NewEdge(px, py, x, y))
		}
		px, py = x, y
	}
	return edges, surface
}

func TestShotSweepNeverBelowSurface(t *testing.T) {
	edges, surface := shotSceneEdges()
	subDt := dt / 4

	speeds := []float64{200, 500, 1000, 1500}
	angles := []float64{-30, -10, 0, 10, 30, 50, 70, 85} // degrees above horizontal; negative = downward
	starts := []float64{1450, 1480, 1520, 1550, 1570, 1600, 1630, 1660}

	worst := 0.0
	for _, sx := range starts {
		for _, sp := range speeds {
			for _, ang := range angles {
				for _, dir := range []float64{1, -1} { // shoot right and left
					ball := NewBall(sx, surface(sx)-10, 10)
					rad := ang * math.Pi / 180
					ball.Shoot(dir*sp*math.Cos(rad), -sp*math.Sin(rad))
					maxDepth, atTick := 0.0, -1
					var atX, atY float64
					for i := 0; i < 900; i++ { // 15s
						for ss := 0; ss < 4; ss++ {
							ball.Tick(subDt, edges, 1200, 2000, -1e9)
							d := ball.Y - (surface(ball.X) - 10) // >0 = center below rest height
							if d > maxDepth {
								maxDepth, atTick, atX, atY = d, i, ball.X, ball.Y
							}
						}
						if ball.Resting {
							break
						}
					}
					if maxDepth > 3 {
						t.Errorf("SINK start=%.0f v=%.0f ang=%.0f dir=%.0f: depth=%.1f at tick=%d pos=(%.1f,%.1f) rest=%v",
							sx, sp, ang, dir, maxDepth, atTick, atX, atY, ball.Resting)
					}
					if maxDepth > worst {
						worst = maxDepth
					}
				}
			}
		}
	}
	t.Logf("worst below-rest depth over sweep: %.2f px", worst)
}
