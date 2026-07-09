// Package holegeom builds the physics collision geometry for a single hole:
// terrain (with bunker rims merged in), tee platforms, static platforms, plus the
// resolved water traps. It's a clean extraction of the geometry logic that the
// single-player loop in main.go builds inline, so the multiplayer match engine can
// reuse the exact same surfaces. (The single-player loop still has its own inline
// copy; unifying the two is a future cleanup.)
package holegeom

import (
	"golf01/server/physics"
	"golf01/server/terrain"
)

// Fixed hole/tee geometry + bunker material, matching main.go.
const (
	HoleW    = 30.0
	HoleD    = 40.0
	TeeHalfW = 3.0
	TeeH     = 10.0

	// Bunker rim material: rarely bounces, kills tangential speed (sticky sand).
	BunkerRestitution = 0.05
	BunkerBounceFric  = 0.35
)

// WaterTrap is a resolved water hazard: world-space banks and pooled surface Y.
type WaterTrap struct {
	CX, L, R, Surface float64
}

// Bunker is precomputed sand geometry (spline + X extents) plus its config, used
// for the in-bunker shot multiplier.
type Bunker struct {
	Coeffs        []terrain.SplineCoeff
	LeftX, RightX float64
	Cfg           terrain.Bunker
}

// Geometry is everything the physics loop needs for one hole.
type Geometry struct {
	Edges   []physics.Edge
	Water   []WaterTrap
	Bunkers []Bunker
	// CTY returns the natural terrain surface Y at x (no bunker rim lift).
	CTY func(float64) float64
}

// Build assembles the collision geometry for a hole.
func Build(hole terrain.Hole) Geometry {
	builtSegs := terrain.BuildSegments(hole)
	splineCoeffs := terrain.BuildSpline(hole.ControlPoints)
	cty := func(x float64) float64 {
		return terrain.ComputeTerrainY(x, hole, builtSegs, splineCoeffs)
	}

	// Precompute bunker splines.
	bunkers := make([]Bunker, 0, len(hole.Bunkers))
	for _, b := range hole.Bunkers {
		if len(b.TopEdge) < 2 {
			continue
		}
		coeffs := terrain.BunkerRimCoeffs(hole, b.TopEdge)
		leftX, rightX := b.TopEdge[0].X, b.TopEdge[0].X
		for _, p := range b.TopEdge {
			if p.X < leftX {
				leftX = p.X
			}
			if p.X > rightX {
				rightX = p.X
			}
		}
		bunkers = append(bunkers, Bunker{Coeffs: coeffs, LeftX: leftX, RightX: rightX, Cfg: b})
	}

	// surfaceAt: terrain lifted up to any bunker rim above it (one continuous
	// surface, so a ball never falls between a floating rim and the terrain floor).
	surfaceAt := func(x float64) (y float64, sand bool) {
		y = cty(x)
		for _, bs := range bunkers {
			if x < bs.LeftX || x > bs.RightX {
				continue
			}
			if ry := terrain.SplineY(x, bs.Coeffs); ry < y {
				y, sand = ry, true
			}
		}
		return
	}

	const step = 4.0
	holeL := hole.HoleX - HoleW/2
	holeR := hole.HoleX + HoleW/2
	inGap := func(x float64) bool { return x >= holeL && x <= holeR }

	edges := make([]physics.Edge, 0, int(hole.WorldW/step)+8)
	prevX := 0.0
	prevY, prevSand := surfaceAt(0)
	for x := step; x <= hole.WorldW; x += step {
		y, sand := surfaceAt(x)
		if !inGap(prevX) && !inGap(x) {
			if prevSand || sand {
				// NewSandEdge marks the edge Sand so Tick uses Current.BunkerFriction
				// for rolling deceleration (NewEdgeMat does NOT set that flag, which
				// left multiplayer sand rolling with the normal grass friction —
				// the Bunker Friction tunable had no effect in matches).
				edges = append(edges, physics.NewSandEdge(prevX, prevY, x, y, BunkerRestitution, BunkerBounceFric))
			} else {
				edges = append(edges, physics.NewEdge(prevX, prevY, x, y))
			}
		}
		prevX, prevY, prevSand = x, y, sand
	}

	addTee := func(teeX float64) {
		y := cty(teeX) - TeeH
		edges = append(edges, physics.NewEdge(teeX-TeeHalfW, y, teeX+TeeHalfW, y))
	}
	for _, teeX := range hole.Tees {
		addTee(teeX)
	}

	for _, plat := range hole.Platforms {
		if len(plat.Points) < 3 {
			continue
		}
		fric := plat.PlatformFriction()
		pts := terrain.EnsureCW(plat.Points)
		for i := 0; i < len(pts); i++ {
			a, b := pts[i], pts[(i+1)%len(pts)]
			edges = append(edges, physics.NewFrictionEdge(a.X, a.Y, b.X, b.Y, fric))
		}
	}

	// Resolve water traps (surface shifted by the Base-Y offset like the terrain).
	waterOff := terrain.BaseOffset(hole)
	var water []WaterTrap
	for _, hz := range hole.Hazards {
		if hz.Kind != "water" {
			continue
		}
		wl := hz.Level + waterOff
		l, r, ok := terrain.WaterPoolBounds(hz.CX, wl, cty, hole.WorldW)
		if !ok {
			continue
		}
		water = append(water, WaterTrap{CX: hz.CX, L: l, R: r, Surface: wl})
	}

	return Geometry{Edges: edges, Water: water, Bunkers: bunkers, CTY: cty}
}
