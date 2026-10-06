package terrain

import "math"

// Platform motion. A platform's polygon (Platform.Points) is always stored in its
// authored "rest pose" — exactly what the editor shows when paused. Motion is a
// pure function of time that turns that rest pose into the pose at time t, so the
// server's physics, the client's renderer and the editor preview can all agree by
// calling the same math. This file is mirrored by poseAt/pathOffset in
// golfclient/src/terrain.ts: keep them in lockstep (golden vectors in
// motion_test.go and e2e/motion.test.mjs assert they match).
//
// Motion composes through Platform.Parent: a platform's world transform is
//
//	world(p, t) = world(parent, t) ∘ local(p, t)
//
// where local(p, t) acts on rest-pose coordinates. That is what lets a windmill be
// a hub that rotates and blades that spin about the hub and ride along with it.

// Motion describes how one platform moves relative to its parent (or the world).
type Motion struct {
	Kind string `json:"kind"` // "none" | "path" | "rotate"

	// Path: the platform visits [(0,0), Waypoints...] (offsets from its authored
	// position) and returns, so it travels a closed cycle at Speed px/s on average.
	Waypoints []ControlPoint `json:"waypoints,omitempty"`
	Speed     float64        `json:"speed,omitempty"`
	Mode      string         `json:"mode,omitempty"`  // "loop" (…→last→first) | "pingpong" (…→last→…→first)
	Ease      string         `json:"ease,omitempty"`  // "linear" | "sine" (slows to a stop at each waypoint)
	Phase     float64        `json:"phase,omitempty"` // path: fraction of a cycle (0..1); rotate: degrees

	// Rotate: spin about Pivot (rest-pose coordinates) at RPM revolutions/min.
	// Positive RPM is clockwise on screen (Y points down).
	Pivot *ControlPoint `json:"pivot,omitempty"`
	RPM   float64       `json:"rpm,omitempty"`
}

// MaxPlatformSpeed caps any point's surface speed (px/s). At 60 Hz × 4 sub-steps
// a 10px-radius ball can only be reliably stopped by an edge that moves well under
// a ball radius per sub-step; 600 px/s is 2.5px/sub-step.
const MaxPlatformSpeed = 600.0

// Xform is a 2D rigid transform: p' = [C -S; S C]·p + (TX, TY).
type Xform struct{ C, S, TX, TY float64 }

// Identity is the do-nothing transform.
func Identity() Xform { return Xform{C: 1} }

// Apply maps a point through the transform.
func (x Xform) Apply(p ControlPoint) ControlPoint {
	return ControlPoint{X: x.C*p.X - x.S*p.Y + x.TX, Y: x.S*p.X + x.C*p.Y + x.TY}
}

// Then returns the transform that applies b first and then x (x ∘ b).
func (x Xform) Then(b Xform) Xform {
	t := x.Apply(ControlPoint{X: b.TX, Y: b.TY})
	return Xform{
		C:  x.C*b.C - x.S*b.S,
		S:  x.S*b.C + x.C*b.S,
		TX: t.X,
		TY: t.Y,
	}
}

// IsMoving reports whether the platform has any motion of its own.
func (m *Motion) IsMoving() bool {
	if m == nil {
		return false
	}
	switch m.Kind {
	case "path":
		return len(m.Waypoints) > 0 && m.Speed > 0
	case "rotate":
		return m.RPM != 0 && m.Pivot != nil
	}
	return false
}

// pathNodes returns the closed cycle of points a path visits (starting and
// ending at the origin offset).
func pathNodes(m *Motion) []ControlPoint {
	pts := make([]ControlPoint, 0, len(m.Waypoints)+1)
	pts = append(pts, ControlPoint{})
	pts = append(pts, m.Waypoints...)
	if m.Mode == "pingpong" || len(pts) == 2 {
		// there and back along the same points
		for i := len(pts) - 2; i >= 0; i-- {
			pts = append(pts, pts[i])
		}
		return pts
	}
	// loop: return straight from the last waypoint to the start
	return append(pts, ControlPoint{})
}

// PathOffset is the platform's translation at time t along its path.
func PathOffset(m *Motion, t float64) (float64, float64) {
	if m.Speed <= 0 || len(m.Waypoints) == 0 {
		return 0, 0
	}
	nodes := pathNodes(m)
	segLen := make([]float64, len(nodes)-1)
	total := 0.0 // total cycle duration, seconds
	for i := range segLen {
		segLen[i] = math.Hypot(nodes[i+1].X-nodes[i].X, nodes[i+1].Y-nodes[i].Y) / m.Speed
		total += segLen[i]
	}
	if total <= 0 {
		return 0, 0
	}
	tau := math.Mod(t+m.Phase*total, total)
	if tau < 0 {
		tau += total
	}
	for i, d := range segLen {
		if d <= 0 {
			continue
		}
		if tau < d || i == len(segLen)-1 {
			f := math.Min(tau/d, 1)
			if m.Ease == "sine" {
				f = (1 - math.Cos(math.Pi*f)) / 2
			}
			a, b := nodes[i], nodes[i+1]
			return a.X + (b.X-a.X)*f, a.Y + (b.Y-a.Y)*f
		}
		tau -= d
	}
	return 0, 0
}

// LocalXform is the platform's own motion at time t, acting on rest-pose coordinates.
func (m *Motion) LocalXform(t float64) Xform {
	if m == nil {
		return Identity()
	}
	switch m.Kind {
	case "path":
		dx, dy := PathOffset(m, t)
		return Xform{C: 1, TX: dx, TY: dy}
	case "rotate":
		if m.Pivot == nil {
			return Identity()
		}
		ang := 2*math.Pi*m.RPM/60*t + m.Phase*math.Pi/180
		c, s := math.Cos(ang), math.Sin(ang)
		// rotate about the pivot: p' = R(p - P) + P = R·p + (P - R·P)
		rp := Xform{C: c, S: s}.Apply(*m.Pivot)
		return Xform{C: c, S: s, TX: m.Pivot.X - rp.X, TY: m.Pivot.Y - rp.Y}
	}
	return Identity()
}

// MotionSet resolves the parent links of a hole's platforms once so the per-tick
// pose lookup is just a short chain walk.
type MotionSet struct {
	plats  []Platform
	parent []int // index of each platform's parent, or -1
}

// NewMotionSet indexes platforms by ID. Unknown parents are treated as the world,
// and parent cycles are cut (see Xform) so a bad file can't hang the server.
func NewMotionSet(plats []Platform) *MotionSet {
	byID := make(map[string]int, len(plats))
	for i, p := range plats {
		if p.ID != "" {
			byID[p.ID] = i
		}
	}
	parent := make([]int, len(plats))
	for i, p := range plats {
		parent[i] = -1
		if p.Parent != "" {
			if j, ok := byID[p.Parent]; ok && j != i {
				parent[i] = j
			}
		}
	}
	return &MotionSet{plats: plats, parent: parent}
}

// Moves reports whether platform i has any motion in its parent chain (i.e. its
// world pose changes with time).
func (ms *MotionSet) Moves(i int) bool {
	for depth := 0; i >= 0 && depth < maxParentDepth; depth++ {
		if ms.plats[i].Motion.IsMoving() {
			return true
		}
		i = ms.parent[i]
	}
	return false
}

const maxParentDepth = 8

// Xform is platform i's world transform at time t: the parent chain's motions
// composed outermost-first.
func (ms *MotionSet) Xform(i int, t float64) Xform {
	chain := make([]int, 0, 4)
	for depth := 0; i >= 0 && depth < maxParentDepth; depth++ {
		chain = append(chain, i)
		i = ms.parent[i]
	}
	x := Identity()
	for k := len(chain) - 1; k >= 0; k-- { // root first
		x = x.Then(ms.plats[chain[k]].Motion.LocalXform(t))
	}
	return x
}

// WorldPoints returns platform i's polygon at time t.
func (ms *MotionSet) WorldPoints(i int, t float64) []ControlPoint {
	src := ms.plats[i].Points
	out := make([]ControlPoint, len(src))
	x := ms.Xform(i, t)
	for k, p := range src {
		out[k] = x.Apply(p)
	}
	return out
}
