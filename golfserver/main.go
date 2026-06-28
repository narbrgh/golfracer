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
)

const (
	baseGround = 650.0
	worldW     = 4000.0
	tickRate   = time.Second / 60
	listenAddr = ":8080"

	// Hole geometry — must match client constants.
	holeX = 3700.0
	holeW = 30.0 // 1.5 × ball diameter
	holeD = 40.0 // pit depth (slightly more than 1.5 × diameter for reliable capture)

	// Ticks to hold ball-in-hole state before resetting (~3 s at 60 Hz).
	holeHoldTicks = 180
)

// terrainY returns the ground height at world x. Must match the client formula.
func terrainY(x float64) float64 {
	return baseGround + 80*math.Sin(x/800) + 40*math.Sin(x/300) + 20*math.Sin(x/150)
}

// terrainSlope returns dy/dx at world x (analytic derivative of terrainY).
func terrainSlope(x float64) float64 {
	return 80.0/800.0*math.Cos(x/800) + 40.0/300.0*math.Cos(x/300) + 20.0/150.0*math.Cos(x/150)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type ballState struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Resting bool   `json:"resting"`
	InHole  bool   `json:"inHole,omitempty"`
}

type shootMsg struct {
	VX float64 `json:"vx"`
	VY float64 `json:"vy"`
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

func main() {
	startX := 100.0
	ball := physics.NewBall(startX, terrainY(startX)-10, 10)
	var ballMu sync.Mutex
	inHoleTicks := 0 // > 0 while ball is in hole; counts down then resets ball

	h := &hub{clients: make(map[*websocket.Conn]struct{})}

	go func() {
		ticker := time.NewTicker(tickRate)
		defer ticker.Stop()
		for range ticker.C {
			ballMu.Lock()
			var state ballState
			if inHoleTicks > 0 {
				// Ball is in the hole — freeze physics, broadcast in-hole state.
				state = ballState{X: ball.X, Y: ball.Y, Resting: true, InHole: true}
				inHoleTicks--
				if inHoleTicks == 0 {
					ball = physics.NewBall(startX, terrainY(startX)-10, 10)
				}
			} else {
				gY := terrainY(ball.X)
				slope := terrainSlope(ball.X)
				// Remove ground collision over the hole so the ball falls in.
				overHole := math.Abs(ball.X-holeX) <= holeW/2
				if overHole {
					gY += holeD + ball.Radius + 10
					slope = 0
				}
				ball.Tick(tickRate.Seconds(), gY, slope, 0, worldW, 0)
				// Detect hole entry: ball centre has dropped below terrain surface.
				if overHole && ball.Y > terrainY(holeX) {
					ball.X = holeX
					ball.Y = terrainY(holeX) + holeD/2
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
			log.Println("upgrade:", err)
			return
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
			var s shootMsg
			if json.Unmarshal(data, &s) == nil {
				ballMu.Lock()
				ball.Shoot(s.VX, s.VY)
				ballMu.Unlock()
			}
		}
	})

	log.Println("listening on", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}
