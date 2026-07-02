package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golf01/server/physics"
	"golf01/server/terrain"
)

const (
	tickRate   = time.Second / 60
	listenAddr = ":8080"

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

	sinkFallTicks  = 60
	sinkWaitTicks  = 30
	sinkTotalTicks = sinkFallTicks + sinkWaitTicks
	sinkDepth      = 40.0

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

// clientMsg covers shoot, course-update, reset, and skipTimer messages.
type clientMsg struct {
	Type string          `json:"type"`
	VX   float64         `json:"vx"`
	VY   float64         `json:"vy"`
	Tee  string          `json:"tee"`
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
	h.mu.Lock(); h.clients[c] = struct{}{}; h.mu.Unlock()
}
func (h *hub) remove(c *websocket.Conn) {
	h.mu.Lock(); delete(h.clients, c); h.mu.Unlock(); c.Close()
}
func (h *hub) broadcast(msg []byte) {
	h.mu.Lock(); defer h.mu.Unlock()
	for c := range h.clients { c.WriteMessage(websocket.TextMessage, msg) }
}

func main() {
	// Course and terrain (protected by ballMu, shared between game loop and WS handler)
	currentCourse := terrain.DefaultCourse()
	builtSegs := terrain.BuildSegments(currentCourse)
	splineCoeffs := terrain.BuildSpline(currentCourse.ControlPoints)
	cty := func(x float64) float64 {
		return terrain.ComputeTerrainY(x, currentCourse, builtSegs, splineCoeffs)
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
		for _, hz := range currentCourse.Hazards {
			if hz.Kind != "water" {
				continue
			}
			l, r, ok := terrain.WaterPoolBounds(hz.CX, hz.Level, cty, currentCourse.WorldW)
			if !ok {
				continue
			}
			traps = append(traps, waterTrap{cx: hz.CX, l: l, r: r, surface: hz.Level})
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
		holeL := currentCourse.HoleX - holeW/2
		holeR := currentCourse.HoleX + holeW/2
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
		for _, b := range currentCourse.Bunkers {
			if len(b.TopEdge) < 2 {
				continue
			}
			coeffs := terrain.BuildSpline(b.TopEdge)
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

		edges := make([]physics.Edge, 0, int(currentCourse.WorldW/step)+8)
		prevX, prevY, prevSand := 0.0, 0.0, false
		prevY, prevSand = surfaceAt(0)
		for x := step; x <= currentCourse.WorldW; x += step {
			y, sand := surfaceAt(x)
			if !inGap(prevX) && !inGap(x) {
				if prevSand || sand {
					edges = append(edges, physics.NewEdgeMat(prevX, prevY, x, y, bunkerRestitution, bunkerBounceFric))
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
		addTee(currentCourse.TeeBackX)
		addTee(currentCourse.TeeForwardX)

		// No water wall/floor edges: terrain stays solid under every trap, so the
		// ball can never tunnel through a pit side or fall forever. It rolls down the
		// real ground and the water penalty fires the moment it sinks below a trap's
		// pooled surface (see the game loop).

		// Static platform edges. EnsureCW normalises winding so NewEdge outward
		// normals always point away from the platform interior.
		for _, plat := range currentCourse.Platforms {
			if len(plat.Points) < 3 {
				continue
			}
			pts := terrain.EnsureCW(plat.Points)
			for i := 0; i < len(pts); i++ {
				a, b := pts[i], pts[(i+1)%len(pts)]
				edges = append(edges, physics.NewEdge(a.X, a.Y, b.X, b.Y))
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
		b             terrain.Bunker
	}
	var builtBunkers []builtBunker
	rebuildBunkers := func() {
		builtBunkers = nil
		for _, b := range currentCourse.Bunkers {
			if len(b.TopEdge) < 2 {
				continue
			}
			coeffs := terrain.BuildSpline(b.TopEdge)
			leftX, rightX := b.TopEdge[0].X, b.TopEdge[0].X
			for _, p := range b.TopEdge {
				if p.X < leftX {
					leftX = p.X
				}
				if p.X > rightX {
					rightX = p.X
				}
			}
			builtBunkers = append(builtBunkers, builtBunker{coeffs, leftX, rightX, b})
		}
	}
	rebuildBunkers()

	startY := func() float64 { return cty(currentCourse.TeeBackX) - teeH - 10 }
	ball := physics.NewBall(currentCourse.TeeBackX, startY(), 10)

	var ballMu sync.Mutex
	inHoleTicks   := 0
	sinkTicks     := 0
	sinkEntryX    := 0.0
	sinkEntryY    := 0.0
	inWaterTicks  := 0
	penaltyFrozen := false // ball locked at penalty spot until next shot
	penaltyX      := 0.0
	penaltyY      := 0.0
	lastNonWaterX := currentCourse.TeeBackX

	// Bunker state: depth is captured as ball.VY at first entry (downward component).
	inBunker    := false
	bunkerDepth := 0.0   // 0 = shallow, 1 = deep
	activeBunker := builtBunker{}

	// Soft-lock diagnostics: if the ball stays not-resting but confined to a
	// small region (frozen OR bouncing in place) for a sustained window, dump
	// the exact ball state + nearby edges so the geometry can be reproduced.
	slMinX, slMaxX := 0.0, 0.0
	slMinY, slMaxY := 0.0, 0.0
	slWinTicks := 0
	slDumped := false

	ballInBunker := func() (bool, builtBunker) {
		for _, bb := range builtBunkers {
			if ball.X < bb.leftX || ball.X > bb.rightX {
				continue
			}
			topY    := terrain.SplineY(ball.X, bb.coeffs)
			groundY := cty(ball.X)
			// In screen coords Y increases downward, so "rim above terrain"
			// means topY < groundY (smaller Y = higher on screen).
			if topY < groundY {
				return true, bb
			}
		}
		return false, builtBunker{}
	}

	h := &hub{clients: make(map[*websocket.Conn]struct{})}

	go func() {
		ticker := time.NewTicker(tickRate)
		defer ticker.Stop()
		for range ticker.C {
			ballMu.Lock()
			var state ballState
			switch {
			case inHoleTicks > 0:
				state = ballState{X: ball.X, Y: ball.Y, Resting: true, InHole: true}
				inHoleTicks--
				if inHoleTicks == 0 {
					ball = physics.NewBall(currentCourse.TeeBackX, startY(), 10)
				}

			case sinkTicks > 0:
				if sinkTicks > sinkWaitTicks {
					progress := float64(sinkTotalTicks-sinkTicks) / float64(sinkFallTicks)
					ball.Y = sinkEntryY + progress*sinkDepth
				} else {
					ball.Y = sinkEntryY + sinkDepth
				}
				ball.X = sinkEntryX
				ball.VX, ball.VY = 0, 0
				state = ballState{X: ball.X, Y: ball.Y, Resting: false, InWater: true}
				sinkTicks--
				if sinkTicks == 0 {
					ball.X, ball.Y = penaltyX, penaltyY
					ball.VX, ball.VY = 0, 0
					ball.Resting = true
					inWaterTicks = waterPenaltyTicks
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
					lo := ball.X - ball.Radius - 4
					hi := ball.X + ball.Radius + 4
					var nearby []physics.Edge
					for _, e := range terrainEdges {
						// Use min/max so edges going right→left (e.g. the bottom
						// face of a CW-wound platform polygon) are not skipped.
						xMin, xMax := e.X0, e.X1
						if xMin > xMax {
							xMin, xMax = xMax, xMin
						}
						if xMax < lo || xMin > hi {
							continue
						}
						nearby = append(nearby, e)
					}
					ball.Tick(subDt, nearby, 0, currentCourse.WorldW, 0)

					// Bunker: the rim is now a real physics surface (edges added in
					// rebuildEdges), so the ball naturally bounces/rests on it
					// via ball.Tick. We only need to detect the first contact to
					// capture depth (entry speed), then track inBunker for the
					// shot-velocity multiplier.
					nowIn, bb := ballInBunker()
					if nowIn && !inBunker {
						speed := math.Hypot(ball.VX, ball.VY)
						thresh := bb.b.DeepThreshold
						if thresh <= 0 {
							thresh = 300
						}
						bunkerDepth = math.Min(speed/thresh, 1.0)
						activeBunker = bb
						inBunker = true
					}
					if !nowIn {
						inBunker = false
					}

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
				overHole := math.Abs(ball.X-currentCourse.HoleX) <= holeW/2

				if hit != nil {
					// Drop the penalty ball back on whichever bank the ball came from.
					if lastNonWaterX <= hit.cx {
						penaltyX = hit.l - waterPenaltyOffset
					} else {
						penaltyX = hit.r + waterPenaltyOffset
					}
					penaltyY = cty(penaltyX) - ball.Radius
					sinkEntryX, sinkEntryY = ball.X, ball.Y
					ball.VX, ball.VY = 0, 0
					sinkTicks = sinkTotalTicks
					state = ballState{X: ball.X, Y: ball.Y, Resting: false, InWater: true}
				} else if overHole && ball.Y > cty(currentCourse.HoleX) {
					ball.X = currentCourse.HoleX
					ball.Y = cty(currentCourse.HoleX) + holeD/2
					ball.VX, ball.VY = 0, 0
					ball.Resting = true
					inHoleTicks = holeHoldTicks
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
							slMinX = math.Min(slMinX, ball.X); slMaxX = math.Max(slMaxX, ball.X)
							slMinY = math.Min(slMinY, ball.Y); slMaxY = math.Max(slMaxY, ball.Y)
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
			msg, _ := json.Marshal(state)
			ballMu.Unlock()
			h.broadcast(msg)
		}
	}()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("upgrade:", err); return
		}
		h.add(conn)
		log.Println("client connected:", conn.RemoteAddr())
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
				if inHoleTicks == 0 && inWaterTicks == 0 {
					penaltyFrozen = false
					vx, vy := msg.VX, msg.VY
					if inBunker {
						b := activeBunker.b
						shallow, deep := b.ShallowMult, b.DeepMult
						if shallow == 0 { shallow = 0.75 }
						if deep    == 0 { deep    = 0.25 }
						mult := shallow + (deep-shallow)*bunkerDepth
						vx *= mult; vy *= mult
					}
					ball.Shoot(vx, vy)
				}
				ballMu.Unlock()
			case "course":
				var c terrain.Course
				if json.Unmarshal(msg.Data, &c) == nil && (len(c.Segments) > 0 || len(c.ControlPoints) > 0) {
					ballMu.Lock()
					currentCourse = c
					builtSegs = terrain.BuildSegments(c)
					splineCoeffs = terrain.BuildSpline(c.ControlPoints)
					rebuildBunkers()  // must run before rebuildEdges so rim edges use current data
					rebuildEdges()    // recomputes water traps + bunker rim edges
					inHoleTicks, sinkTicks, inWaterTicks, penaltyFrozen = 0, 0, 0, false
					inBunker, bunkerDepth = false, 0
					ball = physics.NewBall(currentCourse.TeeBackX, startY(), 10)
					lastNonWaterX = currentCourse.TeeBackX
					log.Printf("course updated: segments=%d points=%d worldW=%.0f bunkers=%d", len(c.Segments), len(c.ControlPoints), c.WorldW, len(c.Bunkers))
					ballMu.Unlock()
				}
			case "reset":
				ballMu.Lock()
				inHoleTicks = 0; sinkTicks = 0; inWaterTicks = 0; penaltyFrozen = false
				inBunker, bunkerDepth = false, 0
				teeX := currentCourse.TeeBackX
				if msg.Tee == "forward" {
					teeX = currentCourse.TeeForwardX
				}
				ball = physics.NewBall(teeX, cty(teeX)-teeH-10, 10)
				lastNonWaterX = teeX
				log.Printf("reset to tee=%s (x=%.0f)", msg.Tee, teeX)
				ballMu.Unlock()
			case "skipTimer":
				ballMu.Lock()
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
					inHoleTicks = 0
				} else {
					penaltyFrozen = false
				}
				ballMu.Unlock()
			}
		}
	})

	log.Println("listening on", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}
