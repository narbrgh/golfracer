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

	// Water trap — must match client hazards[1] (cx:2050, w:210).
	waterCX            = 2050.0
	waterHW            = 105.0
	waterL             = waterCX - waterHW
	waterR             = waterCX + waterHW
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

// clientMsg covers both shoot and course-update messages.
type clientMsg struct {
	Type string          `json:"type"`
	VX   float64         `json:"vx"`
	VY   float64         `json:"vy"`
	Data json.RawMessage `json:"data"`
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
	waterSurface := math.Max(terrain.TerrainY(waterL, builtSegs), terrain.TerrainY(waterR, builtSegs))

	startY := func() float64 { return terrain.TerrainY(currentCourse.TeeBackX, builtSegs) - teeH - 10 }
	ball := physics.NewBall(currentCourse.TeeBackX, startY(), 10)

	var ballMu sync.Mutex
	inHoleTicks  := 0
	sinkTicks    := 0
	sinkEntryX   := 0.0
	sinkEntryY   := 0.0
	inWaterTicks := 0
	penaltyX     := 0.0
	penaltyY     := 0.0
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

			default:
				gY := terrain.TerrainY(ball.X, builtSegs)
				slope := terrain.TerrainSlope(ball.X, builtSegs)

				overTee := math.Abs(ball.X-currentCourse.TeeBackX) <= teeHalfW || math.Abs(ball.X-currentCourse.TeeForwardX) <= teeHalfW
				if overTee { gY -= teeH; slope = 0 }

				overWater := ball.X >= waterL && ball.X <= waterR
				if overWater {
					gY = waterSurface + 10000
					slope = 0
				} else {
					lastNonWaterX = ball.X
				}

				overHole := math.Abs(ball.X-currentCourse.HoleX) <= holeW/2
				if overHole { gY += holeD + ball.Radius + 10; slope = 0 }

				ball.Tick(tickRate.Seconds(), gY, slope, 0, currentCourse.WorldW, 0)

				if overWater && ball.Y >= waterSurface {
					if lastNonWaterX <= waterCX {
						penaltyX = waterL - waterPenaltyOffset
					} else {
						penaltyX = waterR + waterPenaltyOffset
					}
					penaltyY = terrain.TerrainY(penaltyX, builtSegs) - ball.Radius
					sinkEntryX, sinkEntryY = ball.X, ball.Y
					ball.VX, ball.VY = 0, 0
					sinkTicks = sinkTotalTicks
					state = ballState{X: ball.X, Y: ball.Y, Resting: false, InWater: true}
				} else if overHole && ball.Y > terrain.TerrainY(currentCourse.HoleX, builtSegs) {
					ball.X = currentCourse.HoleX
					ball.Y = terrain.TerrainY(currentCourse.HoleX, builtSegs) + holeD/2
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
					ball.Shoot(msg.VX, msg.VY)
				}
				ballMu.Unlock()
			case "course":
				var c terrain.Course
				if json.Unmarshal(msg.Data, &c) == nil && len(c.Segments) > 0 {
					ballMu.Lock()
					currentCourse = c
					builtSegs = terrain.BuildSegments(c)
					waterSurface = math.Max(
						terrain.TerrainY(waterL, builtSegs),
						terrain.TerrainY(waterR, builtSegs),
					)
					log.Printf("course updated: %d segment(s), worldW=%.0f", len(c.Segments), c.WorldW)
					ballMu.Unlock()
				}
			}
		}
	})

	log.Println("listening on", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}
