package coursestore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"golf01/server/terrain"
)

// A bare-hole file (the pre-versioning shape: a Hole's fields at top level, no
// "holes" key, no formatVersion) must load as a current-format one-hole course.
func TestLoadWrapsBareHole(t *testing.T) {
	raw := []byte(`{"worldW":4000,"baseGround":650,"holeX":3700,"useWaves":true,
		"segments":[{"length":4000,"waves":[{"amplitude":80,"period":800,"phase":0}]}]}`)
	c, err := LoadCourse(raw)
	if err != nil {
		t.Fatalf("LoadCourse: %v", err)
	}
	if c.FormatVersion != CurrentFormatVersion {
		t.Errorf("formatVersion = %d, want %d", c.FormatVersion, CurrentFormatVersion)
	}
	if len(c.Holes) != 1 {
		t.Fatalf("holes = %d, want 1", len(c.Holes))
	}
	if c.Holes[0].WorldW != 4000 || c.Holes[0].HoleX != 3700 {
		t.Errorf("bare hole fields not preserved: %+v", c.Holes[0])
	}
	// Missing per-hole fields hydrated to defaults (not left zero); tees default
	// to the multi-tee list (legacy TeeBackX/TeeForwardX fold into Tees).
	if c.Holes[0].WorldH == 0 || len(c.Holes[0].Tees) == 0 {
		t.Errorf("defaults not hydrated: worldH=%v tees=%v", c.Holes[0].WorldH, c.Holes[0].Tees)
	}
}

// A current-format course must round-trip through LoadCourse unchanged (aside
// from idempotent default hydration), and LoadCourse must be idempotent.
func TestLoadIdempotentOnCurrent(t *testing.T) {
	src := DefaultCourse()
	src.ID = "links"
	src.Name = "Sunny Links"
	buf, _ := json.Marshal(src)

	c1, err := LoadCourse(buf)
	if err != nil {
		t.Fatalf("LoadCourse: %v", err)
	}
	buf2, _ := json.Marshal(c1)
	c2, err := LoadCourse(buf2)
	if err != nil {
		t.Fatalf("LoadCourse (2nd): %v", err)
	}
	b1, _ := json.Marshal(c1)
	b2, _ := json.Marshal(c2)
	if string(b1) != string(b2) {
		t.Errorf("LoadCourse not idempotent:\n first=%s\nsecond=%s", b1, b2)
	}
	if c1.Name != "Sunny Links" || c1.ID != "links" {
		t.Errorf("identity lost: id=%q name=%q", c1.ID, c1.Name)
	}
}

// hydrate must fill a partial/empty hole so physics never sees zero geometry,
// while leaving explicitly-set fields intact.
func TestHydrateFillsDefaults(t *testing.T) {
	c := Course{Holes: []terrain.Hole{{HoleX: 1234}}}
	hydrate(&c)
	h := c.Holes[0]
	if h.HoleX != 1234 {
		t.Errorf("explicit HoleX overwritten: %v", h.HoleX)
	}
	if h.WorldW == 0 || h.ControlPoints == nil || h.Bunkers == nil || h.Platforms == nil {
		t.Errorf("hydrate left gaps: %+v", h)
	}
	if h.Theme == (terrain.CourseTheme{}) {
		t.Error("theme not hydrated")
	}
}

// Store round-trips a course to disk and lists it by the filename-derived id.
func TestStoreSaveLoadList(t *testing.T) {
	dir := t.TempDir()
	s, errs := Open(dir)
	if len(errs) != 0 {
		t.Fatalf("Open errs: %v", errs)
	}
	c := DefaultCourse()
	c.Name = "Test Course"
	if _, err := s.Save("test", c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "test.json")); err != nil {
		t.Fatalf("file not written: %v", err)
	}
	// A fresh Store over the same dir must find it.
	s2, _ := Open(dir)
	got, ok := s2.Get("test")
	if !ok {
		t.Fatal("course not loaded by fresh store")
	}
	if got.Name != "Test Course" {
		t.Errorf("name = %q, want Test Course", got.Name)
	}
	infos := s2.List()
	if len(infos) != 1 || infos[0].ID != "test" || infos[0].HoleCount != 1 {
		t.Errorf("List = %+v", infos)
	}
}

// Path-traversal ids must be rejected by Save.
func TestSaveRejectsBadID(t *testing.T) {
	s, _ := Open(t.TempDir())
	for _, bad := range []string{"../evil", "a/b", "", "sp ace"} {
		if _, err := s.Save(bad, DefaultCourse()); err == nil {
			t.Errorf("Save(%q) accepted a bad id", bad)
		}
	}
}
