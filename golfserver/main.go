package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golf01/server/coursestore"
	"golf01/server/physics"
	"golf01/server/rooms"
	"golf01/server/terrain"
)

// version identifies the running build. Set at build time via
//   -ldflags "-X main.version=<git-hash>-<timestamp>"
// (see golfserver/deploy.sh). Defaults to "dev" for local `go run`.
var version = "dev"

const (
	tickRate   = time.Second / 60
	listenAddr = ":8081"

	// Hole geometry — width and depth are fixed; X comes from the course.
	holeW = 30.0
	holeD = 40.0

	// Tee geometry — X positions come from the course; physical size is fixed.
	teeHalfW = 3.0
	teeH     = 10.0

	// Water trap penalty tuning. Trap positions and sizes now come from the
	// course (terrain.Hazard with Kind=="water"), not hardcoded constants, so a
	// map can define any number of traps anywhere.
	waterPenaltyOffset = 20.0
	waterPenaltyTicks  = 5 * 60

	// Ball entering water sinks under real physics (gravity + terrain collision,
	// but no bounce and heavy drag — see the submerged branch) for this long
	// before it respawns on the near shore. This is the "5 seconds underwater"
	// time cost of a water hazard.
	waterSinkTicks = 5 * 60 // 5s submerged before respawn
	// Per-tick velocity retention while submerged (heavy water drag) and the
	// factor applied to any upward velocity so the ball sinks rather than bounces.
	waterDrag        = 0.90
	waterBounceKill  = 0.0

	holeHoldTicks = 180

	// Bunker rim material: very low restitution (rarely bounces) and low
	// tangential retention (the ball's sideways speed is killed on contact),
	// giving a sticky-sand landing.
	bunkerRestitution = 0.05
	bunkerBounceFric  = 0.35
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type ballState struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Resting bool    `json:"resting"`
	InHole  bool    `json:"inHole,omitempty"`
	InWater bool    `json:"inWater,omitempty"`
}

// Server -> client wire messages. `state` carries ball kinematics and is sent
// only while the ball is moving (plus the single frame where it settles) — at
// rest the server stays silent. `event` marks discrete transitions the client
// turns into animations/sounds instead of inferring them from position deltas.
type stateMsg struct {
	Type    string  `json:"type"` // "state"
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Resting bool    `json:"resting"`
	Wind    float64 `json:"wind"` // current hole's wind, mph (+right / -left)
}

type eventMsg struct {
	Type  string  `json:"type"`  // "event"
	Event string  `json:"event"` // shotFired | sank | enteredWater | penaltyStart | reset
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	VX    float64 `json:"vx,omitempty"`
	VY    float64 `json:"vy,omitempty"`
	Wind  float64 `json:"wind,omitempty"` // hole wind, mph — set on reset (new hole = new wind)
}

// clientMsg covers shoot, course (live preview), selectHole, reset, and
// skipTimer messages.
type clientMsg struct {
	Type string          `json:"type"`
	VX   float64         `json:"vx"`
	VY   float64         `json:"vy"`
	Tee  string          `json:"tee"`
	Hole int             `json:"hole"` // active hole index for "course"/"selectHole"
	Club string          `json:"club"` // driver | wedge | putter — which club fired this "shoot"
	Spin string          `json:"spin"` // back | none | top — spin on this "shoot"
	Data json.RawMessage `json:"data"`
}

// waterTrap is a resolved water hazard: world-space left/right banks and the
// pooled surface Y, derived by flooding outward from the hazard's anchor
// (terrain.WaterPoolBounds) whenever the course changes.
type waterTrap struct {
	cx, l, r, surface float64
}

type hub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]struct{}
}

func (h *hub) add(c *websocket.Conn) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}
func (h *hub) remove(c *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
	c.Close()
}
func (h *hub) broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		c.WriteMessage(websocket.TextMessage, msg)
	}
}
func (h *hub) broadcastJSON(v any) {
	if msg, err := json.Marshal(v); err == nil {
		h.broadcast(msg)
	}
}

func main() {
	// Course store: JSON files on disk under courseDir, loaded + migrated on
	// startup. The store is the source of truth for saved courses; the game loop
	// plays one hole of the active course at a time.
	const courseDir = "courses"
	store, storeErrs := coursestore.Open(courseDir)
	for _, e := range storeErrs {
		log.Println("course load error:", e)
	}

	// Active course + which hole is being played/previewed. `hole` is the single
	// terrain.Hole all the per-hole geometry below is built from; it is swapped by
	// setActive whenever the active course or hole index changes. If any courses
	// exist on disk, start on the first; otherwise fall back to a default course.
	activeCourse := coursestore.DefaultCourse()
	if infos := store.List(); len(infos) > 0 {
		if c, ok := store.Get(infos[0].ID); ok {
			activeCourse = c
		}
	}
	currentHole := 0
	hole := activeCourse.Holes[currentHole]

	// Terrain derived from the active hole (protected by ballMu, shared between
	// game loop and WS handler). Rebuilt by setActive on every hole switch.
	builtSegs := terrain.BuildSegments(hole)
	splineCoeffs := terrain.BuildSpline(hole.ControlPoints)
	cty := func(x float64) float64 {
		return terrain.ComputeTerrainY(x, hole, builtSegs, splineCoeffs)
	}
	// Single-player uses just two tees: the first (back) and the last (forward) of
	// the hole's tee list. teeBackX/teeForwardX read the current hole (reassigned
	// on hole switch), so they always reflect the active hole's tees.
	teeBackX := func() float64 {
		if len(hole.Tees) == 0 {
			return 0
		}
		return hole.Tees[0]
	}
	teeForwardX := func() float64 {
		if len(hole.Tees) == 0 {
			return 0
		}
		return hole.Tees[len(hole.Tees)-1]
	}
	// computeWaterTraps resolves the course's water hazards into pit geometry.
	// Each trap floods outward from its anchor (hz.CX) until the terrain rises
	// above hz.Level, so the pool always conforms to whatever valley it sits in
	// instead of being a fixed-width box. A trap whose anchor isn't actually
	// underwater at its level (terrain.WaterPoolBounds returns ok=false) is
	// dropped — a misplaced trap has no pool rather than a phantom one.
	// waterTraps is recomputed whenever the course changes.
	computeWaterTraps := func() []waterTrap {
		var traps []waterTrap
		waterOff := terrain.BaseOffset(hole)
		for _, hz := range hole.Hazards {
			if hz.Kind != "water" {
				continue
			}
			wl := hz.Level + waterOff
			l, r, ok := terrain.WaterPoolBounds(hz.CX, wl, cty, hole.WorldW)
			if !ok {
				continue
			}
			traps = append(traps, waterTrap{cx: hz.CX, l: l, r: r, surface: wl})
		}
		return traps
	}
	waterTraps := computeWaterTraps()
	inAnyWater := func(x float64) bool {
		for _, t := range waterTraps {
			if x >= t.l && x <= t.r {
				return true
			}
		}
		return false
	}

	// terrainEdges is the single source of collision geometry for the ball:
	// terrain tessellated into line segments, plus standalone tee-platform
	// edges. The same circle-vs-edge response in physics.Ball.Tick handles
	// every edge identically regardless of origin, which is also what lets
	// future hand-drawn polygons drop in as more Edges with no special-casing.
	var terrainEdges []physics.Edge
	rebuildEdges := func() {
		waterTraps = computeWaterTraps()
		const step = 4.0
		holeL := hole.HoleX - holeW/2
		holeR := hole.HoleX + holeW/2
		// Only the hole gaps the terrain. Water traps keep solid natural terrain
		// underneath them — the ball simply gets a water penalty once it crosses
		// below the pooled surface within a trap's span (see the game loop), which
		// means a trap can sit on any slope without a pit that lets balls tunnel
		// out the side or fall forever.
		inGap := func(x float64) bool {
			return x >= holeL && x <= holeR
		}

		// Bunker spline data, precomputed for the merged-surface pass below.
		type bunkerSurf struct {
			coeffs        []terrain.SplineCoeff
			leftX, rightX float64
		}
		var bunkerSurfs []bunkerSurf
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
			bunkerSurfs = append(bunkerSurfs, bunkerSurf{coeffs, leftX, rightX})
		}

		// surfaceAt returns the collision-surface Y at x and whether that surface
		// is sand. The ball always rolls on ONE continuous surface: the terrain,
		// lifted up to the sand top (rim spline) wherever a bunker's rim sits
		// above the ground. This replaces the terrain edges inside a bunker with
		// the sand-top line, so there is never a floating rim edge above a
		// separate terrain floor — which is what let a ball get caught between
		// the two and be ejected (endless bounce) or slip through (fall-through).
		surfaceAt := func(x float64) (y float64, sand bool) {
			y = cty(x)
			for _, bs := range bunkerSurfs {
				if x < bs.leftX || x > bs.rightX {
					continue
				}
				if ry := terrain.SplineY(x, bs.coeffs); ry < y {
					y, sand = ry, true
				}
			}
			return
		}

		edges := make([]physics.Edge, 0, int(hole.WorldW/step)+8)
		prevX, prevY, prevSand := 0.0, 0.0, false
		prevY, prevSand = surfaceAt(0)
		for x := step; x <= hole.WorldW; x += step {
			y, sand := surfaceAt(x)
			if !inGap(prevX) && !inGap(x) {
				if prevSand || sand {
					edges = append(edges, physics.NewSandEdge(prevX, prevY, x, y, bunkerRestitution, bunkerBounceFric))
				} else {
					edges = append(edges, physics.NewEdge(prevX, prevY, x, y))
				}
			}
			prevX, prevY, prevSand = x, y, sand
		}
		addTee := func(teeX float64) {
			y := cty(teeX) - teeH
			edges = append(edges, physics.NewEdge(teeX-teeHalfW, y, teeX+teeHalfW, y))
		}
		for _, teeX := range hole.Tees {
			addTee(teeX)
		}

		// No water wall/floor edges: terrain stays solid under every trap, so the
		// ball can never tunnel through a pit side or fall forever. It rolls down the
		// real ground and the water penalty fires the moment it sinks below a trap's
		// pooled surface (see the game loop).

		// Static platform edges. EnsureCW normalises winding so NewEdge outward
		// normals always point away from the platform interior.
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

		terrainEdges = edges
	}
	rebuildEdges()

	// Precomputed bunker geometry: spline coefficients and X extents.
	// Rebuilt whenever the course changes, not every tick.
	type builtBunker struct {
		coeffs        []terrain.SplineCoeff
		leftX, rightX float64
	}
	var builtBunkers []builtBunker
	rebuildBunkers := func() {
		builtBunkers = nil
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
			builtBunkers = append(builtBunkers, builtBunker{coeffs, leftX, rightX})
		}
	}
	rebuildBunkers()

	startY := func() float64 { return cty(teeBackX()) - teeH - 10 }
	ball := physics.NewBall(teeBackX(), startY(), 10)

	var ballMu sync.Mutex
	inHoleTicks := 0
	sinkTicks := 0
	inWaterTicks := 0
	penaltyFrozen := false // ball locked at penalty spot until next shot
	penaltyX := 0.0
	penaltyY := 0.0
	lastNonWaterX := teeBackX()

	// Bunker state: whether the ball is currently sitting in a bunker, checked
	// each substep — governs the club penalty applied on the next "shoot".
	inBunker := false

	// Current hole's wind in mph (+right / -left). Re-rolled whenever the hole
	// (re)loads in setActive; applied to each shot's flight and reported to the
	// client for the wind indicator. Rolled once here for the initial tee hole,
	// which is set up directly (not via setActive).
	windMph := physics.RollHoleWindMph()

	// Soft-lock diagnostics: if the ball stays not-resting but confined to a
	// small region (frozen OR bouncing in place) for a sustained window, dump
	// the exact ball state + nearby edges so the geometry can be reproduced.
	slMinX, slMaxX := 0.0, 0.0
	slMinY, slMaxY := 0.0, 0.0
	slWinTicks := 0
	slDumped := false

	ballInBunker := func() bool {
		for _, bb := range builtBunkers {
			if ball.X < bb.leftX || ball.X > bb.rightX {
				continue
			}
			topY := terrain.SplineY(ball.X, bb.coeffs)
			groundY := cty(ball.X)
			// In screen coords Y increases downward, so "rim above terrain"
			// means topY < groundY (smaller Y = higher on screen).
			if topY < groundY {
				return true
			}
		}
		return false
	}

	// nearbyEdges returns the terrain edges whose X-span overlaps the ball, for
	// collision. Shared by the normal play loop and the submerged-sink loop so
	// both collide against exactly the same surface.
	nearbyEdges := func() []physics.Edge {
		lo := ball.X - ball.Radius - 4
		hi := ball.X + ball.Radius + 4
		var nearby []physics.Edge
		for _, e := range terrainEdges {
			xMin, xMax := e.X0, e.X1
			if xMin > xMax {
				xMin, xMax = xMax, xMin
			}
			if xMax < lo || xMin > hi {
				continue
			}
			nearby = append(nearby, e)
		}
		return nearby
	}

	// setActive switches the played/previewed hole. It swaps in the new course +
	// hole index, rebuilds all per-hole terrain/bunker/water geometry, and re-tees
	// the ball, clearing transient hole state (sink/water/hole animations). Callers
	// must hold ballMu. Out-of-range indices clamp to hole 0.
	setActive := func(c coursestore.Course, idx int) {
		if len(c.Holes) == 0 {
			return
		}
		if idx < 0 || idx >= len(c.Holes) {
			idx = 0
		}
		activeCourse = c
		currentHole = idx
		hole = c.Holes[idx]
		builtSegs = terrain.BuildSegments(hole)
		splineCoeffs = terrain.BuildSpline(hole.ControlPoints)
		rebuildBunkers() // must run before rebuildEdges so rim edges use current data
		rebuildEdges()
		inHoleTicks, sinkTicks, inWaterTicks, penaltyFrozen = 0, 0, 0, false
		inBunker = false
		ball = physics.NewBall(teeBackX(), startY(), 10)
		lastNonWaterX = teeBackX()
		windMph = physics.RollHoleWindMph()
	}

	h := &hub{clients: make(map[*websocket.Conn]struct{})}

	// Change-based broadcasting: remember the last `state` frame we sent so we can
	// skip re-sending an unchanged one while the ball rests (the loop stays silent
	// at rest instead of spamming 60 identical frames/sec).
	var lastSentX, lastSentY float64
	var lastSentResting bool
	haveSent := false

	go func() {
		ticker := time.NewTicker(tickRate)
		defer ticker.Stop()
		for range ticker.C {
			ballMu.Lock()
			var toSend [][]byte
			emit := func(v any) {
				if b, err := json.Marshal(v); err == nil {
					toSend = append(toSend, b)
				}
			}
			var state ballState
			switch {
			case inHoleTicks > 0:
				state = ballState{X: ball.X, Y: ball.Y, Resting: true, InHole: true}
				inHoleTicks--
				if inHoleTicks == 0 {
					ball = physics.NewBall(teeBackX(), startY(), 10)
					emit(eventMsg{Type: "event", Event: "reset", X: ball.X, Y: ball.Y, Wind: windMph})
				}

			case sinkTicks > 0:
				// Submerged: keep real physics so the ball collides with the
				// terrain under the water (it won't sink through the ground), but
				// apply heavy water drag and kill any upward velocity so it sinks
				// and settles on the underwater floor instead of bouncing. The ball
				// is force-unrested each substep so gravity keeps pulling it down
				// even after it momentarily settles (until the 5s wait elapses).
				subDt := tickRate.Seconds() / 4
				for ss := 0; ss < 4; ss++ {
					ball.Resting = false
					ball.VX *= waterDrag
					ball.VY *= waterDrag
					if ball.VY < 0 {
						ball.VY *= waterBounceKill // remove upward (bounce) velocity
					}
					ball.Tick(subDt, nearbyEdges(), 0, hole.WorldW, 0)
					if ball.VY < 0 {
						ball.VY *= waterBounceKill // suppress bounce imparted by Tick
					}
				}
				state = ballState{X: ball.X, Y: ball.Y, Resting: false, InWater: true}
				sinkTicks--
				if sinkTicks == 0 {
					ball.X, ball.Y = penaltyX, penaltyY
					ball.VX, ball.VY = 0, 0
					ball.Resting = true
					inWaterTicks = waterPenaltyTicks
					emit(eventMsg{Type: "event", Event: "penaltyStart", X: penaltyX, Y: penaltyY})
				}

			case inWaterTicks > 0:
				ball.X, ball.Y = penaltyX, penaltyY
				ball.VX, ball.VY = 0, 0
				ball.Resting = true
				state = ballState{X: penaltyX, Y: penaltyY, Resting: true, InWater: true}
				inWaterTicks--
				if inWaterTicks == 0 {
					penaltyFrozen = true
				}

			default:
				if penaltyFrozen {
					state = ballState{X: ball.X, Y: ball.Y, Resting: true}
					break
				}

				// 4 sub-steps per tick: each step re-gathers nearby edges at the
				// ball's current X and resolves collision against them. Position
				// correction happens along each edge's own normal (not Y-only),
				// which is what keeps steep slopes from snapping/flickering.
				subDt := tickRate.Seconds() / 4
				for ss := 0; ss < 4; ss++ {
					ball.Tick(subDt, nearbyEdges(), 0, hole.WorldW, 0)

					// Bunker: the rim is now a real physics surface (edges added in
					// rebuildEdges), so the ball naturally bounces/rests on it via
					// ball.Tick. We only need to track whether the ball currently
					// sits in a bunker, which the "shoot" handler reads to decide
					// whether to apply the current club's bunker penalty.
					inBunker = ballInBunker()

					if !inAnyWater(ball.X) {
						lastNonWaterX = ball.X
					}
				}

				// Did the ball touch the water in any trap? It's "in the water" when its
				// lowest point (center + radius) reaches the pooled surface anywhere
				// within the trap's span. Because terrain stays solid under the trap,
				// this fires both for a deep depression (ball sinks past the surface)
				// and for flat/shallow ground at water level (ball rolling across the
				// top still touches the waterline) — but NOT on an emerged shore the
				// trap straddles, where the ground sits above the surface.
				var hit *waterTrap
				for i := range waterTraps {
					t := &waterTraps[i]
					if ball.X >= t.l && ball.X <= t.r && ball.Y+ball.Radius >= t.surface {
						hit = t
						break
					}
				}
				overHole := math.Abs(ball.X-hole.HoleX) <= holeW/2

				if hit != nil {
					// Drop the penalty ball back on whichever bank the ball came from.
					if lastNonWaterX <= hit.cx {
						penaltyX = hit.l - waterPenaltyOffset
					} else {
						penaltyX = hit.r + waterPenaltyOffset
					}
					penaltyY = cty(penaltyX) - ball.Radius
					// Let the ball keep its momentum into the water; the submerged
					// branch damps it. sinkTicks runs the 5s underwater phase.
					sinkTicks = waterSinkTicks
					emit(eventMsg{Type: "event", Event: "enteredWater", X: ball.X, Y: ball.Y})
					state = ballState{X: ball.X, Y: ball.Y, Resting: false, InWater: true}
				} else if overHole && ball.Y > cty(hole.HoleX) {
					ball.X = hole.HoleX
					ball.Y = cty(hole.HoleX) + holeD/2
					ball.VX, ball.VY = 0, 0
					ball.Resting = true
					inHoleTicks = holeHoldTicks
					emit(eventMsg{Type: "event", Event: "sank", X: ball.X, Y: ball.Y})
					state = ballState{X: ball.X, Y: ball.Y, Resting: true, InHole: true}
				} else {
					// Soft-lock diagnostic: track the ball's bounding box while it's
					// not resting. If it stays confined to a small region (frozen OR
					// bouncing in place) across a 2s window, dump the geometry once.
					if ball.Resting {
						slWinTicks = 0
						slDumped = false
					} else {
						if slWinTicks == 0 {
							slMinX, slMaxX, slMinY, slMaxY = ball.X, ball.X, ball.Y, ball.Y
						} else {
							slMinX = math.Min(slMinX, ball.X)
							slMaxX = math.Max(slMaxX, ball.X)
							slMinY = math.Min(slMinY, ball.Y)
							slMaxY = math.Max(slMaxY, ball.Y)
						}
						slWinTicks++
						if slWinTicks >= 120 {
							if slMaxX-slMinX < 60 && slMaxY-slMinY < 60 && !slDumped {
								slDumped = true
								log.Printf("SOFTLOCK ball=(%.2f,%.2f) v=(%.2f,%.2f) bbox=(%.1fx%.1f) inBunker=%v", ball.X, ball.Y, ball.VX, ball.VY, slMaxX-slMinX, slMaxY-slMinY, inBunker)
								lo := slMinX - ball.Radius - 8
								hi := slMaxX + ball.Radius + 8
								for _, e := range terrainEdges {
									xMin, xMax := e.X0, e.X1
									if xMin > xMax {
										xMin, xMax = xMax, xMin
									}
									if xMax < lo || xMin > hi {
										continue
									}
									log.Printf("  EDGE (%.2f,%.2f)->(%.2f,%.2f) N=(%.3f,%.3f) rest=%.2f bfric=%.2f", e.X0, e.Y0, e.X1, e.Y1, e.NX, e.NY, e.Restitution, e.BounceFric)
								}
							}
							slWinTicks = 0 // start a fresh window
						}
					}
					state = ballState{X: ball.X, Y: ball.Y, Resting: ball.Resting}
				}
			}
			// Send a position frame only while the ball moves or when it actually
			// changed since the last frame; a resting ball whose state is identical
			// produces nothing (rest = silence).
			moving := !state.Resting
			if !haveSent || moving || state.X != lastSentX || state.Y != lastSentY || state.Resting != lastSentResting {
				emit(stateMsg{Type: "state", X: state.X, Y: state.Y, Resting: state.Resting, Wind: windMph})
				lastSentX, lastSentY, lastSentResting = state.X, state.Y, state.Resting
				haveSent = true
			}
			ballMu.Unlock()
			for _, b := range toSend {
				h.broadcast(b)
			}
		}
	}()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("upgrade:", err)
			return
		}
		h.add(conn)
		log.Println("client connected:", conn.RemoteAddr())
		// The loop is silent while the ball rests, so a fresh client wouldn't learn
		// where the ball is. Send it the current position immediately.
		ballMu.Lock()
		snap := stateMsg{Type: "state", X: ball.X, Y: ball.Y, Resting: ball.Resting, Wind: windMph}
		ballMu.Unlock()
		if b, err := json.Marshal(snap); err == nil {
			conn.WriteMessage(websocket.TextMessage, b)
		}
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				h.remove(conn)
				log.Println("client disconnected:", conn.RemoteAddr())
				return
			}
			var msg clientMsg
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			switch msg.Type {
			case "shoot":
				ballMu.Lock()
				fired := false
				var fvx, fvy, fx, fy float64
				if inHoleTicks == 0 && inWaterTicks == 0 {
					penaltyFrozen = false
					vx, vy := msg.VX, msg.VY
					if inBunker {
						var mult float64
						switch msg.Club {
						case "driver":
							mult = physics.Current.DriverPenalty
						case "wedge":
							mult = physics.Current.WedgePenalty
						case "putter":
							mult = physics.Current.PutterPenalty
						default:
							mult = 1
						}
						vx *= mult
						vy *= mult
					}
					ball.Shoot(vx, vy, physics.SpinValue(msg.Spin), physics.WindVelFromMph(windMph), msg.Club == "putter")
					fired = true
					fvx, fvy, fx, fy = vx, vy, ball.X, ball.Y
				}
				ballMu.Unlock()
				if fired {
					h.broadcastJSON(eventMsg{Type: "event", Event: "shotFired", X: fx, Y: fy, VX: fvx, VY: fvy})
				}
			case "course":
				// Live preview push from the editor: the full (possibly unsaved)
				// course plus which hole to show. Normalized (defaults filled) but
				// not persisted — Save goes through the HTTP API separately.
				var c coursestore.Course
				if json.Unmarshal(msg.Data, &c) == nil && len(c.Holes) > 0 {
					c = coursestore.Normalize(c)
					ballMu.Lock()
					setActive(c, msg.Hole)
					rx, ry, rw := ball.X, ball.Y, windMph
					ballMu.Unlock()
					h.broadcastJSON(eventMsg{Type: "event", Event: "reset", X: rx, Y: ry, Wind: rw})
					log.Printf("course preview: id=%q holes=%d activeHole=%d", c.ID, len(c.Holes), msg.Hole)
				}
			case "selectHole":
				// Switch the active hole of the current course without resending
				// geometry (used for hole navigation).
				ballMu.Lock()
				setActive(activeCourse, msg.Hole)
				rx, ry, rw := ball.X, ball.Y, windMph
				ballMu.Unlock()
				h.broadcastJSON(eventMsg{Type: "event", Event: "reset", X: rx, Y: ry, Wind: rw})
			case "reset":
				ballMu.Lock()
				inHoleTicks = 0
				sinkTicks = 0
				inWaterTicks = 0
				penaltyFrozen = false
				inBunker = false
				teeX := teeBackX()
				if msg.Tee == "forward" {
					teeX = teeForwardX()
				}
				ball = physics.NewBall(teeX, cty(teeX)-teeH-10, 10)
				lastNonWaterX = teeX
				rx, ry := ball.X, ball.Y
				log.Printf("reset to tee=%s (x=%.0f)", msg.Tee, teeX)
				ballMu.Unlock()
				h.broadcastJSON(eventMsg{Type: "event", Event: "reset", X: rx, Y: ry})
			case "skipTimer":
				ballMu.Lock()
				var skipReset *eventMsg
				if sinkTicks > 0 {
					ball.X, ball.Y = penaltyX, penaltyY
					ball.VX, ball.VY = 0, 0
					ball.Resting = true
					sinkTicks = 0
					inWaterTicks = 0
					penaltyFrozen = true
				} else if inWaterTicks > 0 {
					ball.X, ball.Y = penaltyX, penaltyY
					ball.VX, ball.VY = 0, 0
					ball.Resting = true
					inWaterTicks = 0
					penaltyFrozen = true
				} else if inHoleTicks > 0 {
					// Re-tee instead of just zeroing the timer: the ball is still sitting
					// below the green, so dropping straight back to physics would re-sink
					// it (and re-fire the sank event) every tick.
					inHoleTicks = 0
					ball = physics.NewBall(teeBackX(), startY(), 10)
					skipReset = &eventMsg{Type: "event", Event: "reset", X: ball.X, Y: ball.Y}
				} else {
					penaltyFrozen = false
				}
				ballMu.Unlock()
				if skipReset != nil {
					h.broadcastJSON(*skipReset)
				}
			}
		}
	})

	// ---- Course HTTP API (dev-local persistence) ----
	// The browser editor can't write to disk directly, so it saves/loads courses
	// through these endpoints. Permissive CORS because the client dev server runs
	// on a different origin than :8080.
	writeJSON := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
	cors := func(w http.ResponseWriter) {
		hdr := w.Header()
		hdr.Set("Access-Control-Allow-Origin", "*")
		hdr.Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		hdr.Set("Access-Control-Allow-Headers", "Content-Type")
	}

	// GET /version — reports the running build id. The client hits this on the
	// main menu both to display the server version and as a liveness check (a
	// failed fetch = server shown offline).
	http.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		writeJSON(w, map[string]string{"version": version})
	})

	// GET /courses — list saved courses (metadata only).
	http.HandleFunc("/courses", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, store.List())
	})

	// GET /courses/{id}  — fetch one course (current-format).
	// PUT /courses/{id}  — create/replace a course file.
	http.HandleFunc("/courses/", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/courses/")
		if !coursestore.ValidID(id) {
			http.Error(w, "invalid course id", http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodGet:
			c, ok := store.Get(id)
			if !ok {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			writeJSON(w, c)
		case http.MethodPut, http.MethodPost:
			var c coursestore.Course
			if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
				http.Error(w, "bad course json: "+err.Error(), http.StatusBadRequest)
				return
			}
			saved, err := store.Save(id, c)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			log.Printf("course saved: id=%q holes=%d", id, len(saved.Holes))
			writeJSON(w, saved)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// ---- Physics config API (the "Ken" debug menu) ----
	// GET returns the live tunables plus the hardcoded defaults, so the client
	// can show "default: X" next to each editable field. POST applies a full
	// replacement set immediately — session-only, nothing is written to disk.
	http.HandleFunc("/physics/config", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		switch r.Method {
		case http.MethodGet:
			ballMu.Lock()
			cur := physics.Current
			ballMu.Unlock()
			writeJSON(w, map[string]any{
				"current":  cur,
				"defaults": physics.DefaultTunables(),
			})
		case http.MethodPost:
			var t physics.Tunables
			if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
				http.Error(w, "bad tunables json: "+err.Error(), http.StatusBadRequest)
				return
			}
			ballMu.Lock()
			physics.Current = t
			// Wind is normally rolled once per hole, so a wind-override change from
			// the Ken menu wouldn't be felt until the next hole. Apply it to the
			// CURRENT hole immediately: when the override is on, force the current
			// wind to the override value (so the HUD + next shot reflect it at once).
			if t.WindOverrideOn != 0 {
				windMph = t.WindOverrideMph
			}
			snap := stateMsg{Type: "state", X: ball.X, Y: ball.Y, Resting: ball.Resting, Wind: windMph}
			ballMu.Unlock()
			// Push a state frame so the wind HUD updates at once, even while the ball
			// rests (the tick loop is silent at rest, so it wouldn't otherwise).
			h.broadcastJSON(snap)
			log.Printf("physics config updated: %+v", t)
			writeJSON(w, t)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// ---- Rooms API (in-memory, ephemeral) ----
	// Online lobby rooms. Unlike courses these aren't persisted — the manager holds
	// them in memory so every client sees the same live list. The room browser
	// reads the list over HTTP; create/join and all lobby actions go over the
	// /lobby WebSocket (below), which is where per-client identity + membership live.
	roomMgr := rooms.NewManager()

	// GET /rooms — list open rooms (newest first) for the room browser.
	http.HandleFunc("/rooms", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, roomMgr.List())
	})

	// ---- Lobby WebSocket ----
	// A separate socket from the game /ws: each connection is an identified lobby
	// player. Handles create/join/leave and all in-room actions (name, color,
	// ready, chat, host course/victory selection, start), broadcasting the room
	// snapshot to members after each change.
	var nextPlayerID int64
	http.HandleFunc("/lobby", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("lobby upgrade:", err)
			return
		}
		defer conn.Close()

		pid := int(atomic.AddInt64(&nextPlayerID, 1))
		player := &rooms.Player{ID: pid, Name: fmt.Sprintf("Player %d", pid), Send: make(chan []byte, 64)}

		// Writer goroutine drains the player's outbound queue to the socket.
		go func() {
			for msg := range player.Send {
				if conn.WriteMessage(websocket.TextMessage, msg) != nil {
					return
				}
			}
		}()

		// On disconnect: drop from the room (broadcast to whoever remains), then
		// close the send channel so the writer goroutine exits.
		defer func() {
			if roomID, ok := roomMgr.Leave(pid); ok {
				roomMgr.BroadcastState(roomID)
			}
			close(player.Send)
		}()

		send := func(v any) {
			if b, err := json.Marshal(v); err == nil {
				player.Send <- b
			}
		}
		sendErr := func(e error) { send(map[string]any{"type": "room:error", "msg": e.Error()}) }

		send(map[string]any{"type": "hello", "playerId": pid})
		log.Println("lobby client connected:", pid)

		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				log.Println("lobby client disconnected:", pid)
				return
			}
			var msg struct {
				Type     string  `json:"type"`
				Name     string  `json:"name"`
				RoomID   string  `json:"roomId"`
				Color     string `json:"color"`
				Ready     bool   `json:"ready"`
				Spectator bool   `json:"spectator"`
				Text     string  `json:"text"`
				CourseID string  `json:"courseId"`
				Victory  string  `json:"victory"`
				VX       float64 `json:"vx"`
				VY       float64 `json:"vy"`
				Club     string  `json:"club"`
				Spin     string  `json:"spin"`
			}
			if json.Unmarshal(data, &msg) != nil {
				continue
			}

			switch msg.Type {
			case "roomCreate":
				roomID := roomMgr.CreateAndJoin(player, msg.Name)
				log.Printf("room created: id=%q by player=%d", roomID, pid)
				send(map[string]any{"type": "room:joined", "roomId": roomID})
				roomMgr.BroadcastState(roomID)
			case "roomJoin":
				if err := roomMgr.Join(player, msg.RoomID); err != nil {
					sendErr(err)
					break
				}
				send(map[string]any{"type": "room:joined", "roomId": msg.RoomID})
				roomMgr.BroadcastState(msg.RoomID)
			case "roomLeave":
				if roomID, ok := roomMgr.Leave(pid); ok {
					roomMgr.BroadcastState(roomID)
				}
				send(map[string]any{"type": "room:left"})
			case "setName":
				if roomID, ok := roomMgr.SetName(pid, msg.Name); ok {
					roomMgr.BroadcastState(roomID)
				}
			case "setColor":
				if roomID, err := roomMgr.SetColor(pid, msg.Color); err != nil {
					sendErr(err)
				} else {
					roomMgr.BroadcastState(roomID)
				}
			case "setReady":
				if roomID, ok := roomMgr.SetReady(pid, msg.Ready); ok {
					roomMgr.BroadcastState(roomID)
				}
			case "setSpectator":
				if roomID, err := roomMgr.SetSpectator(pid, msg.Spectator); err != nil {
					sendErr(err)
				} else {
					roomMgr.BroadcastState(roomID)
				}
			case "setCourse":
				if roomID, err := roomMgr.SetCourse(pid, msg.CourseID); err != nil {
					sendErr(err)
				} else {
					roomMgr.BroadcastState(roomID)
				}
			case "setVictory":
				if roomID, err := roomMgr.SetVictory(pid, msg.Victory); err != nil {
					sendErr(err)
				} else {
					roomMgr.BroadcastState(roomID)
				}
			case "chat":
				text := strings.TrimSpace(msg.Text)
				if text == "" {
					break
				}
				if len(text) > 240 {
					text = text[:240]
				}
				if roomID, ok := roomMgr.RoomOf(pid); ok {
					if b, err := json.Marshal(map[string]any{"type": "chat", "name": roomMgr.PlayerName(pid), "text": text}); err == nil {
						roomMgr.Broadcast(roomID, b)
					}
				}
			case "start":
				if roomID, err := roomMgr.Start(pid); err != nil {
					sendErr(err)
				} else {
					// Load the host-selected course (fall back to the default), then
					// spin up the per-room match — it broadcasts match:hole/match:state,
					// which is what moves clients onto the match screen.
					holes := coursestore.DefaultCourse().Holes
					if c, ok := store.Get(roomMgr.RoomCourse(roomID)); ok && len(c.Holes) > 0 {
						holes = c.Holes
					}
					roomMgr.BeginMatch(roomID, holes)
				}
			case "shoot":
				roomMgr.MatchShoot(pid, msg.VX, msg.VY, msg.Club, msg.Spin)
			case "matchReturn":
				roomMgr.MatchReturn(pid)
			case "matchReady":
				roomMgr.MatchReady(pid)
			}
		}
	})

	log.Println("listening on", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}
