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
		edges := make([]physics.Edge, 0, int(currentCourse.WorldW/step)+8)
		prevX, prevY := 0.0, cty(0)
		for x := step; x <= currentCourse.WorldW; x += step {
			y := cty(x)
			if !inGap(prevX) && !inGap(x) {
				edges = append(edges, physics.NewEdge(prevX, prevY, x, y))
			}
			prevX, prevY = x, y
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

		terrainEdges = edges
	}
	rebuildEdges()

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
						if e.X1 < lo || e.X0 > hi {
							continue
						}
						nearby = append(nearby, e)
					}
					ball.Tick(subDt, nearby, 0, currentCourse.WorldW, 0)

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
					ball.Shoot(msg.VX, msg.VY)
				}
				ballMu.Unlock()
			case "course":
				var c terrain.Course
				if json.Unmarshal(msg.Data, &c) == nil && (len(c.Segments) > 0 || len(c.ControlPoints) > 0) {
					ballMu.Lock()
					currentCourse = c
					builtSegs = terrain.BuildSegments(c)
					splineCoeffs = terrain.BuildSpline(c.ControlPoints)
					rebuildEdges() // recomputes water traps from the new course
					// The old ball position was computed for the previous terrain and
					// may now sit underground or mid-air, so drop it back on the tee
					// the same way "reset" does.
					inHoleTicks, sinkTicks, inWaterTicks, penaltyFrozen = 0, 0, 0, false
					ball = physics.NewBall(currentCourse.TeeBackX, startY(), 10)
					lastNonWaterX = currentCourse.TeeBackX
					log.Printf("course updated: segments=%d points=%d worldW=%.0f", len(c.Segments), len(c.ControlPoints), c.WorldW)
					ballMu.Unlock()
				}
			case "reset":
				ballMu.Lock()
				inHoleTicks = 0; sinkTicks = 0; inWaterTicks = 0; penaltyFrozen = false
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
