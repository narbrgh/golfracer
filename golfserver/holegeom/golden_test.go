package holegeom

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"golf01/server/coursestore"
)

// TestStaticGeometryGolden fingerprints the collision geometry of every course
// in ../courses so that refactors of how geometry is built (and the addition of
// animated platforms) provably leave static courses byte-for-byte unchanged.
// Only the static fields are hashed — velocity fields added later for moving
// surfaces are deliberately excluded, since static edges must keep them at zero.
//
// Regenerate after an INTENTIONAL geometry change with:
//
//	UPDATE_GOLDEN=1 go test ./holegeom/
func TestStaticGeometryGolden(t *testing.T) {
	files, err := filepath.Glob("../courses/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no course files found (err=%v)", err)
	}
	sort.Strings(files)

	var lines []string
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		course, err := coursestore.LoadCourse(data)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		for i, hole := range course.Holes {
			g := Build(hole)
			h := sha256.New()
			for _, e := range g.Edges {
				fmt.Fprintf(h, "E %.6f %.6f %.6f %.6f %.6f %.6f %v %.6f\n",
					e.X0, e.Y0, e.X1, e.Y1, e.Restitution, e.BounceFric, e.Sand, e.Friction)
			}
			for _, w := range g.Water {
				fmt.Fprintf(h, "W %.6f %.6f %.6f %.6f\n", w.CX, w.L, w.R, w.Surface)
			}
			lines = append(lines, fmt.Sprintf("%s#%d %d edges %x",
				filepath.Base(f), i, len(g.Edges), h.Sum(nil)[:8]))
		}
	}
	got := strings.Join(lines, "\n") + "\n"

	const golden = "testdata/edges.golden"
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s (%d holes)", golden, len(lines))
		return
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("missing golden file (run with UPDATE_GOLDEN=1 to create): %v", err)
	}
	if got != string(want) {
		t.Errorf("static geometry changed.\n--- want\n%s--- got\n%s", want, got)
	}
}
