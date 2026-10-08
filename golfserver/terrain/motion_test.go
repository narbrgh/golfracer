package terrain

import (
	"encoding/json"
	"math"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func pt(x, y float64) ControlPoint { return ControlPoint{X: x, Y: y} }

// These vectors are the contract with golfclient/src/terrain.ts (poseAt): the same
// cases, with the same expected numbers, are asserted in e2e/motion.test.mjs. They
// are hand-derivable so a failure points at the math rather than at a stale golden.
func TestMotionGoldenVectors(t *testing.T) {
	pivot := pt(100, 100)
	cases := []struct {
		name  string
		plats []Platform
		idx   int
		t     float64
		in    ControlPoint
		want  ControlPoint
	}{
		{"rotate 60rpm quarter turn is 90deg clockwise on screen",
			[]Platform{{Motion: &Motion{Kind: "rotate", Pivot: &pivot, RPM: 60}}}, 0, 0.25, pt(110, 100), pt(100, 110)},
		{"rotate phase 180deg at t=0",
			[]Platform{{Motion: &Motion{Kind: "rotate", Pivot: &pivot, RPM: 10, Phase: 180}}}, 0, 0, pt(110, 100), pt(90, 100)},
		{"pingpong linear midway out",
			[]Platform{{Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(100, 0)}, Speed: 100, Mode: "pingpong", Ease: "linear"}}}, 0, 0.5, pt(0, 0), pt(50, 0)},
		{"pingpong linear at the far end",
			[]Platform{{Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(100, 0)}, Speed: 100, Mode: "pingpong", Ease: "linear"}}}, 0, 1, pt(0, 0), pt(100, 0)},
		{"pingpong linear on the way back",
			[]Platform{{Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(100, 0)}, Speed: 100, Mode: "pingpong", Ease: "linear"}}}, 0, 1.5, pt(0, 0), pt(50, 0)},
		{"pingpong sine ease is slow at the start",
			[]Platform{{Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(100, 0)}, Speed: 100, Mode: "pingpong", Ease: "sine"}}}, 0, 0.25, pt(0, 0), pt(14.644660940672624, 0)},
		{"loop through two waypoints",
			[]Platform{{Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(100, 0), pt(100, 100)}, Speed: 100, Mode: "loop", Ease: "linear"}}}, 0, 1.5, pt(0, 0), pt(100, 50)},
		{"path phase starts mid-cycle",
			[]Platform{{Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(100, 0)}, Speed: 100, Mode: "pingpong", Ease: "linear", Phase: 0.5}}}, 0, 0, pt(0, 0), pt(100, 0)},
		{"negative time wraps",
			[]Platform{{Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(100, 0)}, Speed: 100, Mode: "pingpong", Ease: "linear"}}}, 0, -0.5, pt(0, 0), pt(50, 0)},
		{"child rides its rotating parent",
			[]Platform{
				{ID: "hub", Motion: &Motion{Kind: "rotate", Pivot: &ControlPoint{}, RPM: 60}},
				{ID: "arm", Parent: "hub", Motion: &Motion{Kind: "path", Waypoints: []ControlPoint{pt(10, 0)}, Speed: 10, Mode: "pingpong", Ease: "linear"}},
			}, 1, 0.25, pt(5, 0), pt(0, 7.5)},
		{"static platform is untouched",
			[]Platform{{}}, 0, 123.4, pt(7, 8), pt(7, 8)},
	}
	for _, c := range cases {
		got := NewMotionSet(c.plats).Xform(c.idx, c.t).Apply(c.in)
		if !near(got.X, c.want.X) || !near(got.Y, c.want.Y) {
			t.Errorf("%s: got (%.9f, %.9f), want (%.9f, %.9f)", c.name, got.X, got.Y, c.want.X, c.want.Y)
		}
	}
}

func TestMotionSetGuardsBadParents(t *testing.T) {
	// A parent cycle and a dangling parent must not hang or panic.
	plats := []Platform{
		{ID: "a", Parent: "b", Motion: &Motion{Kind: "rotate", Pivot: &ControlPoint{}, RPM: 6}},
		{ID: "b", Parent: "a", Motion: &Motion{Kind: "rotate", Pivot: &ControlPoint{}, RPM: 6}},
		{ID: "c", Parent: "missing"},
	}
	ms := NewMotionSet(plats)
	_ = ms.Xform(0, 1)
	_ = ms.Xform(2, 1)
	if ms.Moves(2) {
		t.Error("platform with a dangling parent and no motion should not move")
	}
	if !ms.Moves(0) {
		t.Error("platform with its own rotation should move")
	}
}

// Old course files (no id/parent/motion) must keep loading and re-saving without
// gaining motion fields.
func TestPlatformJSONRoundTripStaysStatic(t *testing.T) {
	in := `{"points":[{"x":0,"y":0},{"x":10,"y":0},{"x":10,"y":10}],"layer":150,"fillColor":"#fff","edgeColor":"#000"}`
	var p Platform
	if err := json.Unmarshal([]byte(in), &p); err != nil {
		t.Fatal(err)
	}
	if p.Motion != nil || p.ID != "" || p.Parent != "" {
		t.Fatalf("legacy platform gained animation fields: %+v", p)
	}
	out, _ := json.Marshal(p)
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	for _, k := range []string{"id", "parent", "motion", "name"} {
		if _, ok := m[k]; ok {
			t.Errorf("static platform serialized %q", k)
		}
	}
}
