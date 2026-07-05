package terrain

import (
	"math"
	"sort"
)

// ---- Spline terrain ----

type ControlPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type SplineCoeff struct {
	X0, X1    float64
	A, B, C, D float64
}

func BuildSpline(pts []ControlPoint) []SplineCoeff {
	if len(pts) < 2 {
		return nil
	}
	p := make([]ControlPoint, len(pts))
	copy(p, pts)
	sort.Slice(p, func(i, j int) bool { return p[i].X < p[j].X })
	n := len(p)
	out := make([]SplineCoeff, n-1)
	for i := 0; i < n-1; i++ {
		var p0, p3 float64
		p1, p2 := p[i].Y, p[i+1].Y
		if i > 0 {
			p0 = p[i-1].Y
		} else {
			p0 = 2*p[0].Y - p[1].Y
		}
		if i < n-2 {
			p3 = p[i+2].Y
		} else {
			p3 = 2*p[n-1].Y - p[n-2].Y
		}
		out[i] = SplineCoeff{
			X0: p[i].X, X1: p[i+1].X,
			A: p1,
			B: 0.5 * (-p0 + p2),
			C: 0.5 * (2*p0 - 5*p1 + 4*p2 - p3),
			D: 0.5 * (-p0 + 3*p1 - 3*p2 + p3),
		}
	}
	return out
}

func SplineY(x float64, coeffs []SplineCoeff) float64 {
	if len(coeffs) == 0 {
		return 650
	}
	s := coeffs[0]
	for i := range coeffs {
		s = coeffs[i]
		if x <= s.X1 || i == len(coeffs)-1 {
			break
		}
	}
	if s.X1 == s.X0 {
		return s.A
	}
	t := (x - s.X0) / (s.X1 - s.X0)
	return s.A + t*(s.B+t*(s.C+t*s.D))
}

func SplineSlope(x float64, coeffs []SplineCoeff) float64 {
	if len(coeffs) == 0 {
		return 0
	}
	s := coeffs[0]
	for i := range coeffs {
		s = coeffs[i]
		if x <= s.X1 || i == len(coeffs)-1 {
			break
		}
	}
	h := s.X1 - s.X0
	if h == 0 {
		return 0
	}
	t := (x - s.X0) / h
	return (s.B + t*(2*s.C+t*3*s.D)) / h
}

// ComputeTerrainY and ComputeTerrainSlope handle all four mode combinations.
// SplineBaseRef is the neutral Base-Y reference for spline terrain — see the TS
// SPLINE_BASE_REF in golfclient/src/terrain.ts (must match). BaseGround acts as an
// offset from this so the Base Y slider shifts the whole spline terrain.
const SplineBaseRef = 650.0

// BaseOffset is the vertical shift Base Y applies to authored-absolute geometry
// (spline control points, bunker rims, water level) so they track the terrain.
func BaseOffset(c Hole) float64 { return c.BaseGround - SplineBaseRef }

// BunkerRimCoeffs builds a bunker's rim spline shifted by the hole's Base-Y offset.
func BunkerRimCoeffs(c Hole, topEdge []ControlPoint) []SplineCoeff {
	off := BaseOffset(c)
	shifted := make([]ControlPoint, len(topEdge))
	for i, p := range topEdge {
		shifted[i] = ControlPoint{X: p.X, Y: p.Y + off}
	}
	return BuildSpline(shifted)
}

func ComputeTerrainY(x float64, c Hole, segs []BuiltSegment, coeffs []SplineCoeff) float64 {
	s, w := c.UseSpline, c.UseWaves
	if s && w {
		return SplineY(x, coeffs) + TerrainY(x, segs) - SplineBaseRef
	}
	if s {
		return SplineY(x, coeffs) + c.BaseGround - SplineBaseRef
	}
	if w {
		return TerrainY(x, segs)
	}
	return c.BaseGround
}

func ComputeTerrainSlope(x float64, c Hole, segs []BuiltSegment, coeffs []SplineCoeff) float64 {
	s, w := c.UseSpline, c.UseWaves
	if s && w {
		return SplineSlope(x, coeffs) + TerrainSlope(x, segs)
	}
	if s {
		return SplineSlope(x, coeffs)
	}
	if w {
		return TerrainSlope(x, segs)
	}
	return 0
}

// ---- Theme ----

type CourseTheme struct {
	SkyTop      string  `json:"skyTop"`
	SkyBottom   string  `json:"skyBottom"`
	Mountain1   string  `json:"mountain1"`
	Mountain1Y  float64 `json:"mountain1Y"`
	Mountain2   string  `json:"mountain2"`
	Mountain2Y  float64 `json:"mountain2Y"`
	GroundFill  string  `json:"groundFill"`
	GroundLine  string  `json:"groundLine"`
	GroundLineW float64 `json:"groundLineW"`
	WaterFill   string  `json:"waterFill"`
	WaterLineW  float64 `json:"waterLineW"`
	WaterLine   string  `json:"waterLine"`
	SunColor    string  `json:"sunColor"`
	SunRing1    string  `json:"sunRing1"`
	SunRing2    string  `json:"sunRing2"`
	SunSize     float64 `json:"sunSize"`
}

type TerrainWave struct {
	Amplitude float64 `json:"amplitude"`
	Period    float64 `json:"period"`
	Phase     float64 `json:"phase"`
}

type TerrainSegment struct {
	Length float64       `json:"length"`
	Waves  []TerrainWave `json:"waves"`
}

// Bunker is a sand trap whose visible region sits between a user-drawn
// Catmull-Rom top edge (the rim/lip) and the terrain surface below it. Ball
// physics inside a bunker (extra rolling friction, reduced shot power when hit
// out) is governed by global tunables — physics.Current.BunkerFriction and the
// per-club penalties — rather than per-bunker fields, so every bunker on every
// hole behaves the same.
type Bunker struct {
	TopEdge []ControlPoint `json:"topEdge"`
}

// Platform is a convex or concave polygon that the ball can bounce off.
// ZOrder controls rendering: "front" draws above terrain, "back" draws behind it.
// Points should be stored in the order the editor produced them; EnsureCW
// normalises winding for physics before building edges.
type Platform struct {
	Points    []ControlPoint `json:"points"`
	ZOrder    string         `json:"zOrder"` // "front" | "back"
	FillColor string         `json:"fillColor"`
	EdgeColor string         `json:"edgeColor"`
}

// PolySignedArea returns the signed area of a polygon in screen/Y-down
// coordinates. Positive → clockwise (CW) on screen.
func PolySignedArea(pts []ControlPoint) float64 {
	a := 0.0
	n := len(pts)
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		a += pts[i].X*pts[j].Y - pts[j].X*pts[i].Y
	}
	return a / 2
}

// EnsureCW returns pts in CW winding order (positive signed area in screen
// coords) so physics.NewEdge outward normals point away from the platform.
func EnsureCW(pts []ControlPoint) []ControlPoint {
	if PolySignedArea(pts) >= 0 {
		return pts
	}
	rev := make([]ControlPoint, len(pts))
	for i, p := range pts {
		rev[len(pts)-1-i] = p
	}
	return rev
}

// Hazard is positioned and sized in world coordinates. Water is a flood-fill:
// the body floods outward from the anchor (CX) until the terrain rises above
// Level, conforming to whatever valley it sits in (see WaterPoolBounds); W/H
// are unused for water. Sand uses W (footprint) and H (mound height); trees
// use H (height).
type Hazard struct {
	Kind  string  `json:"kind"`
	CX    float64 `json:"cx"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
	Level float64 `json:"level"`
}

// WaterPoolBounds walks outward from cx to find where the terrain rises above
// level on each side — the pool's banks. ok is false if cx isn't actually
// underwater at level (ground there sits above the surface), meaning the trap
// is misplaced and should be treated as having no pool.
func WaterPoolBounds(cx, level float64, cty func(float64) float64, worldW float64) (left, right float64, ok bool) {
	const step = 4.0
	if cty(cx) < level {
		return 0, 0, false
	}

	left = cx
	for left-step >= 0 && cty(left-step) >= level {
		left -= step
	}
	if left-step >= 0 {
		yA, yB := cty(left), cty(left-step)
		left -= ((level - yA) / (yB - yA)) * step
	} else {
		left = 0
	}

	right = cx
	for right+step <= worldW && cty(right+step) >= level {
		right += step
	}
	if right+step <= worldW {
		yA, yB := cty(right), cty(right+step)
		right += ((level - yA) / (yB - yA)) * step
	} else {
		right = worldW
	}

	return left, right, true
}

// Hole is a single self-contained playable hole: terrain, tees, cup, hazards,
// and theme. It was formerly named Course — a "course" in the old code was
// really one hole. A full Course (see package coursestore) is now an ordered
// list of Holes. Everything downstream — physics edge-building, rendering — is
// per-hole, so this struct is the unit sent to the physics/collision layer.
type Hole struct {
	Name          string           `json:"name,omitempty"`
	Par           int              `json:"par,omitempty"`
	WorldW        float64          `json:"worldW"`
	WorldH        float64          `json:"worldH"`
	BaseGround    float64          `json:"baseGround"`
	TeeBackX      float64          `json:"teeBackX"`
	TeeForwardX   float64          `json:"teeForwardX"`
	HoleX         float64          `json:"holeX"`
	UseSpline     bool             `json:"useSpline"`
	ControlPoints []ControlPoint   `json:"controlPoints"`
	UseWaves      bool             `json:"useWaves"`
	Segments      []TerrainSegment `json:"segments"`
	Hazards       []Hazard         `json:"hazards"`
	Bunkers       []Bunker         `json:"bunkers"`
	Platforms     []Platform       `json:"platforms"`
	Theme         CourseTheme      `json:"theme"`
}

// BuiltSegment is a precomputed segment with continuity offset.
type BuiltSegment struct {
	StartX float64
	Length float64
	Waves  []TerrainWave
	Offset float64 // vertical shift so Y(StartX) == previous segment's end Y
}

// BuildSegments computes startX and offset for each segment so adjacent
// segments always connect at the same height (C0 continuity).
func BuildSegments(c Hole) []BuiltSegment {
	built := make([]BuiltSegment, len(c.Segments))
	curX := 0.0
	curY := c.BaseGround
	for i, seg := range c.Segments {
		atStart := 0.0
		for _, w := range seg.Waves {
			atStart += w.Amplitude * math.Sin(w.Phase)
		}
		offset := curY - atStart
		atEnd := 0.0
		for _, w := range seg.Waves {
			atEnd += w.Amplitude * math.Sin(seg.Length/w.Period+w.Phase)
		}
		curY = offset + atEnd
		built[i] = BuiltSegment{StartX: curX, Length: seg.Length, Waves: seg.Waves, Offset: offset}
		curX += seg.Length
	}
	return built
}

func TerrainY(x float64, segs []BuiltSegment) float64 {
	for i, s := range segs {
		if x < s.StartX+s.Length || i == len(segs)-1 {
			lx := x - s.StartX
			y := s.Offset
			for _, w := range s.Waves {
				y += w.Amplitude * math.Sin(lx/w.Period+w.Phase)
			}
			return y
		}
	}
	if len(segs) > 0 {
		return segs[0].Offset
	}
	return 650
}

func TerrainSlope(x float64, segs []BuiltSegment) float64 {
	for i, s := range segs {
		if x < s.StartX+s.Length || i == len(segs)-1 {
			lx := x - s.StartX
			slope := 0.0
			for _, w := range s.Waves {
				slope += (w.Amplitude / w.Period) * math.Cos(lx/w.Period+w.Phase)
			}
			return slope
		}
	}
	return 0
}

// DefaultHole returns the original 3-sinusoid terrain as a single segment.
func DefaultHole() Hole {
	return Hole{
		WorldW:      4000,
		WorldH:      1000,
		BaseGround:  650,
		TeeBackX:    200,
		TeeForwardX: 400,
		HoleX:       3700,
		UseSpline:   false,
		ControlPoints: []ControlPoint{
			{X: 0, Y: 650}, {X: 700, Y: 570}, {X: 1400, Y: 710},
			{X: 2100, Y: 625}, {X: 2800, Y: 695}, {X: 3500, Y: 610}, {X: 4000, Y: 650},
		},
		UseWaves: true,
		Segments: []TerrainSegment{{
			Length: 4000,
			Waves: []TerrainWave{
				{Amplitude: 80, Period: 800, Phase: 0},
				{Amplitude: 40, Period: 300, Phase: 0},
				{Amplitude: 20, Period: 150, Phase: 0},
			},
		}},
		Hazards:   []Hazard{{Kind: "water", CX: 2080, Level: 715}},
		Bunkers:   []Bunker{},
		Platforms: []Platform{},
		Theme: CourseTheme{
			SkyTop:      "#07071a",
			SkyBottom:   "#111125",
			Mountain1:   "#1c1c30",
			Mountain1Y:  0.45,
			Mountain2:   "#252540",
			Mountain2Y:  0.58,
			GroundFill:  "#252515",
			GroundLine:  "#667755",
			GroundLineW: 2,
			WaterFill:   "#1655e1",
			WaterLineW:  1.5,
			WaterLine:   "#96d2ff",
			SunColor:    "#ffe9b8",
			SunRing1:    "#ffd27a",
			SunRing2:    "#ffd27a",
			SunSize:     32,
		},
	}
}
