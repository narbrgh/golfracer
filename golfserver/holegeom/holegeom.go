// Package holegeom builds the physics collision geometry for a single hole:
// terrain (with bunker rims merged in), tee platforms, static platforms, plus the
// resolved water traps. It's a clean extraction of the geometry logic that the
// single-player loop in main.go used to build inline; both the single-player loop
// and the multiplayer match engine now build their surfaces here, so they always
// collide against exactly the same geometry.
//
// Animated platforms (terrain.Platform.Motion) are NOT baked into Edges: only
// static platforms are. Animated ones are re-posed from the shared motion math
// each physics sub-step via Nearby, which also attaches each edge's surface
// velocity so the physics can carry and shove balls.
package holegeom

import (
	"math"

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
	// Edges is the STATIC collision geometry: terrain, tees, and platforms that
	// never move. Animated platforms are added per sub-step by Nearby.
	Edges   []physics.Edge
	Water   []WaterTrap
	Bunkers []Bunker
	// CTY returns the natural terrain surface Y at x (no bunker rim lift).
	CTY func(float64) float64

	motion *terrain.MotionSet // platforms with winding normalised; nil when nothing moves
	anim   []animPlat
}

// animPlat is one animated platform: its index in motion and its rolling friction.
type animPlat struct {
	idx      int
	friction float64
}

// HasMotion reports whether the hole has any animated platform.
func (g Geometry) HasMotion() bool { return len(g.anim) > 0 }

// velSampleDt is the finite-difference window for surface velocity. Small enough
// to be a good derivative of the (smooth) motion, large enough to avoid float noise.
const velSampleDt = 0.002

// Nearby returns the collision edges relevant to a ball of the given radius at
// ballX: the static edges whose X-span overlaps it, plus every animated platform
// edge at platform time t (seconds on the hole's shared motion clock) carrying its
// surface velocity.
func (g Geometry) Nearby(ballX, radius, t float64) []physics.Edge {
	lo := ballX - radius - 4
	hi := ballX + radius + 4
	var nearby []physics.Edge
	for _, e := range g.Edges {
		xMin, xMax := e.X0, e.X1
		if xMin > xMax {
			xMin, xMax = xMax, xMin
		}
		if xMax < lo || xMin > hi {
			continue
		}
		nearby = append(nearby, e)
	}
	return g.appendAnimated(nearby, lo, hi, t)
}

// AnimatedEdges returns every animated platform edge at time t, unfiltered. Used by
// tests and diagnostics.
func (g Geometry) AnimatedEdges(t float64) []physics.Edge {
	return g.appendAnimated(nil, math.Inf(-1), math.Inf(1), t)
}

func (g Geometry) appendAnimated(dst []physics.Edge, lo, hi, t float64) []physics.Edge {
	for _, a := range g.anim {
		now := g.motion.WorldPoints(a.idx, t)
		prev := g.motion.WorldPoints(a.idx, t-velSampleDt)
		n := len(now)
		for i := 0; i < n; i++ {
			j := (i + 1) % n
			p0, p1 := now[i], now[j]
			xMin, xMax := p0.X, p1.X
			if xMin > xMax {
				xMin, xMax = xMax, xMin
			}
			if xMax < lo || xMin > hi {
				continue
			}
			v0x, v0y := capSpeed((p0.X-prev[i].X)/velSampleDt, (p0.Y-prev[i].Y)/velSampleDt)
			v1x, v1y := capSpeed((p1.X-prev[j].X)/velSampleDt, (p1.Y-prev[j].Y)/velSampleDt)
			dst = append(dst, physics.NewFrictionEdge(p0.X, p0.Y, p1.X, p1.Y, a.friction).
				WithVelocity(v0x, v0y, v1x, v1y))
		}
	}
	return dst
}

// capSpeed clamps a surface velocity to terrain.MaxPlatformSpeed so a badly
// authored platform can't move fast enough to tunnel through a ball.
func capSpeed(vx, vy float64) (float64, float64) {
	if sp := math.Hypot(vx, vy); sp > terrain.MaxPlatformSpeed {
		k := terrain.MaxPlatformSpeed / sp
		return vx * k, vy * k
	}
	return vx, vy
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

	// Platforms. Winding is normalised on the authored (rest-pose) polygon: rigid
	// motion preserves it, so animated platforms keep correct outward normals at
	// every instant. Static ones become edges now; animated ones are re-posed per
	// sub-step in Nearby.
	cwPlats := make([]terrain.Platform, len(hole.Platforms))
	for i, plat := range hole.Platforms {
		cwPlats[i] = plat
		if len(plat.Points) >= 3 {
			cwPlats[i].Points = terrain.EnsureCW(plat.Points)
		}
	}
	ms := terrain.NewMotionSet(cwPlats)
	var anim []animPlat
	for i, plat := range cwPlats {
		if len(plat.Points) < 3 {
			continue
		}
		fric := plat.PlatformFriction()
		if ms.Moves(i) {
			anim = append(anim, animPlat{idx: i, friction: fric})
			continue
		}
		// Nothing in its parent chain moves, so its rest pose is its pose forever.
		pts := plat.Points
		for k := 0; k < len(pts); k++ {
			a, b := pts[k], pts[(k+1)%len(pts)]
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

	g := Geometry{Edges: edges, Water: water, Bunkers: bunkers, CTY: cty}
	if len(anim) > 0 {
		g.motion = ms
		g.anim = anim
	}
	return g
}
