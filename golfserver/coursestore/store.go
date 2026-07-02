// Package coursestore owns course files on disk: loading, forward-migration to
// the current schema, default hydration, and saving. A Course is an ordered
// list of terrain.Hole plus identity metadata; the server plays one hole of the
// active course at a time.
//
// Migration lives here, at the file-read boundary, so any course read off disk —
// however old — is normalized to the current schema before it is served to the
// client or handed to physics. The client therefore never sees a stale-format
// course and needs no migration logic of its own.
package coursestore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"

	"golf01/server/terrain"
)

// CurrentFormatVersion is the schema version this build writes and migrates up
// to. Bump it by one whenever the on-disk shape changes, and add a migration
// step keyed by the previous version (see migrations).
const CurrentFormatVersion = 1

// Course is a full course: identity metadata plus up to 18 holes. It is the
// on-disk unit (one file per course) and the unit the HTTP API serves.
type Course struct {
	FormatVersion int            `json:"formatVersion"`
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Holes         []terrain.Hole `json:"holes"`
}

// CourseInfo is the lightweight listing entry (no geometry).
type CourseInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	HoleCount int    `json:"holeCount"`
}

// DefaultCourse is the fallback course used when no files exist on disk yet: a
// single default hole under a placeholder identity.
func DefaultCourse() Course {
	return Course{
		FormatVersion: CurrentFormatVersion,
		ID:            "untitled",
		Name:          "Untitled",
		Holes:         []terrain.Hole{terrain.DefaultHole()},
	}
}

// Normalize hydrates a course received over the wire (e.g. the editor's live
// preview push) so missing fields get defaults. It does not migrate — the wire
// contract is current-format — it only fills gaps, keeping the server defensive.
func Normalize(c Course) Course {
	hydrate(&c)
	return c
}

// migrations[v] transforms a raw course map from formatVersion v to v+1. Steps
// run in sequence from a file's stored version up to CurrentFormatVersion.
// Additive schema changes are a one-line default-fill; transformative ones
// (e.g. the historical Hazard "sand"/"tree" -> bunker move) get real logic here.
// Operating on map[string]any (not the typed struct) keeps old field names that
// no longer exist on Course reachable during a migration.
//
// v0 -> v1 is special-cased in migrate(): a pre-versioning file is either a bare
// hole (today's shape, no "holes" key) which gets wrapped into a one-hole
// course, or already course-shaped. There are no real v>=1 migrations yet; new
// entries get added here as the schema evolves.
var migrations = map[int]func(map[string]any) map[string]any{}

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// ValidID reports whether id is safe to use as a filename (no path traversal).
func ValidID(id string) bool { return id != "" && idPattern.MatchString(id) }

// Store is a directory of course files with an in-memory cache, safe for
// concurrent use by the HTTP handlers and the game loop.
type Store struct {
	dir string
	mu  sync.RWMutex
	m   map[string]Course
}

// Open returns a Store backed by dir, creating the directory if needed and
// loading every *.json course already present (each normalized to the current
// schema). A file that fails to load is skipped with a logged-style error in
// the returned error slice, not fatal, so one bad file can't sink startup.
func Open(dir string) (*Store, []error) {
	s := &Store{dir: dir, m: map[string]Course{}}
	var errs []error
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return s, []error{fmt.Errorf("create course dir: %w", err)}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return s, []error{fmt.Errorf("read course dir: %w", err)}
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", e.Name(), err))
			continue
		}
		c, err := LoadCourse(data)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", e.Name(), err))
			continue
		}
		// The filename (sans .json) is authoritative for the id, so a
		// hand-copied file is addressable even if its inner id drifted. Fill an
		// empty name from the id now that it's known (hydrate ran during
		// LoadCourse before the filename id was applied).
		if id := e.Name()[:len(e.Name())-len(".json")]; ValidID(id) {
			c.ID = id
			if c.Name == "" {
				c.Name = id
			}
		}
		s.m[c.ID] = c
	}
	return s, errs
}

// LoadCourse parses, migrates, and hydrates a single course from raw JSON.
// Idempotent: a current-format course passes through unchanged (aside from
// default hydration, which is also idempotent).
func LoadCourse(data []byte) (Course, error) {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return Course{}, fmt.Errorf("parse course json: %w", err)
	}
	raw = migrate(raw)

	// Re-marshal the migrated map into the typed Course. This is the one place
	// the untyped migration output meets the typed schema.
	buf, err := json.Marshal(raw)
	if err != nil {
		return Course{}, err
	}
	var c Course
	if err := json.Unmarshal(buf, &c); err != nil {
		return Course{}, fmt.Errorf("decode migrated course: %w", err)
	}
	hydrate(&c)
	return c, nil
}

// migrate brings a raw course map up to CurrentFormatVersion. It first resolves
// the pre-versioning (v0) shapes into a v1-shaped course, then applies any
// registered vN->vN+1 steps in order.
func migrate(raw map[string]any) map[string]any {
	v := intField(raw, "formatVersion")

	if v == 0 {
		// Pre-versioning file. If it has no "holes" key it's a bare hole
		// (the original single-Course shape) — wrap it as a one-hole course.
		if _, hasHoles := raw["holes"]; !hasHoles {
			hole := raw
			raw = map[string]any{
				"formatVersion": 0,
				"id":            "",
				"name":          "",
				"holes":         []any{hole},
			}
		}
		raw["formatVersion"] = 1
		v = 1
	}

	for v < CurrentFormatVersion {
		step, ok := migrations[v]
		if !ok {
			// No migration registered for this gap — trust structural
			// compatibility and just bump; hydrate() fills any new fields.
			v++
			raw["formatVersion"] = v
			continue
		}
		raw = step(raw)
		v++
		raw["formatVersion"] = v
	}
	return raw
}

// hydrate fills defaults so a course read from an older or partial file always
// has usable values: identity fields, at least one hole, and per-hole geometry
// defaults for anything left zero-valued.
func hydrate(c *Course) {
	c.FormatVersion = CurrentFormatVersion
	if c.Name == "" {
		c.Name = c.ID
	}
	if len(c.Holes) == 0 {
		c.Holes = []terrain.Hole{terrain.DefaultHole()}
	}
	for i := range c.Holes {
		hydrateHole(&c.Holes[i])
	}
}

// hydrateHole fills per-hole geometry defaults. A field that is zero/empty on an
// older file gets the DefaultHole value, so additive schema fields never surface
// as 0 or nil even before a dedicated migration exists for them. Slices that are
// intentionally empty (no bunkers) stay empty — only nil is treated as "absent".
func hydrateHole(h *terrain.Hole) {
	d := terrain.DefaultHole()
	if h.WorldW == 0 {
		h.WorldW = d.WorldW
	}
	if h.WorldH == 0 {
		h.WorldH = d.WorldH
	}
	if h.BaseGround == 0 {
		h.BaseGround = d.BaseGround
	}
	if h.HoleX == 0 {
		h.HoleX = d.HoleX
	}
	if h.TeeBackX == 0 {
		h.TeeBackX = d.TeeBackX
	}
	if h.TeeForwardX == 0 {
		h.TeeForwardX = d.TeeForwardX
	}
	if h.ControlPoints == nil {
		h.ControlPoints = d.ControlPoints
	}
	if h.Segments == nil {
		h.Segments = d.Segments
	}
	if h.Hazards == nil {
		h.Hazards = []terrain.Hazard{}
	}
	if h.Bunkers == nil {
		h.Bunkers = []terrain.Bunker{}
	}
	if h.Platforms == nil {
		h.Platforms = []terrain.Platform{}
	}
	if h.Theme == (terrain.CourseTheme{}) {
		h.Theme = d.Theme
	}
}

func intField(m map[string]any, k string) int {
	if v, ok := m[k]; ok {
		if f, ok := v.(float64); ok { // JSON numbers decode to float64
			return int(f)
		}
	}
	return 0
}

// List returns course metadata sorted by id, cheap enough to call per request.
func (s *Store) List() []CourseInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]CourseInfo, 0, len(s.m))
	for id, c := range s.m {
		out = append(out, CourseInfo{ID: id, Name: c.Name, HoleCount: len(c.Holes)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Get returns a course by id from the cache.
func (s *Store) Get(id string) (Course, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.m[id]
	return c, ok
}

// Save normalizes, writes courses/<id>.json (pretty), and updates the cache.
// The id must be filename-safe (ValidID); the course's ID is forced to match.
func (s *Store) Save(id string, c Course) (Course, error) {
	if !ValidID(id) {
		return Course{}, errors.New("invalid course id")
	}
	c.ID = id
	hydrate(&c)

	buf, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return Course{}, err
	}
	// Atomic-ish write: temp file + rename so a crash mid-write can't corrupt
	// an existing course file.
	path := filepath.Join(s.dir, id+".json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return Course{}, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return Course{}, err
	}

	s.mu.Lock()
	s.m[id] = c
	s.mu.Unlock()
	return c, nil
}
