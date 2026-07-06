package rooms

import (
	"encoding/json"
	"math"
	"sort"
	"time"

	"golf01/server/holegeom"
	"golf01/server/physics"
	"golf01/server/terrain"
)

// Per-room gameplay: a match runs its own physics simulation (one ball per member)
// on the chosen course, one hole at a time, through a phase machine:
//
//	countdown → playing → (intermission → playing)* → results → back to lobby
//
// Win condition per hole is fastest time to sink; the match victory condition
// (total time vs holes won) aggregates those. Balls physically collide.
const (
	matchTickRate     = time.Second / 60
	countdownTicks    = 3 * 60
	holeCapTicks      = 180 * 60 // per-hole time cap (3 min); unsunk at the cap is a DNF — the full 3 min is added to the player's total (see finishHole)
	intermissionTicks = 6 * 60
	resultsTicks      = 25 * 60 // auto-return to lobby if the host never clicks
	matchBallRadius   = 10.0
	waterBankOffset   = 20.0
	maxShotSpeed      = 2000.0 // matches the client's strongest club (driver) max speed
	ballCollRest      = 0.9    // restitution for ball-ball impacts

	// Cooldown after a ball settles before its owner may shoot again (the red
	// draining ring). Water incurs double, shown as the "double ring" penalty.
	shotDelayTicks    = 150 // 2.5s
	waterPenaltyTicks = 300 // 5s

	// A ball that enters water sinks under real physics (gravity + terrain
	// collision, heavy drag, no bounce) for this long before respawning on the
	// near shore — mirrors the single-player water sink (main.go).
	waterSinkTicks  = 300 // 5s submerged before respawn
	waterDrag       = 0.90
	waterBounceKill = 0.0 // upward velocity multiplier while submerged (kills bounce)
)

type MatchPhase string

const (
	PhaseCountdown    MatchPhase = "countdown"
	PhasePlaying      MatchPhase = "playing"
	PhaseIntermission MatchPhase = "intermission"
	PhaseResults      MatchPhase = "results"
)

type matchBall struct {
	playerID   int
	name       string
	color      string
	ball       *physics.Ball
	sunk       bool
	finishTick uint64 // ticks from hole start to sink; holeCapTicks if DNF
	totalTicks uint64 // sum of finishTick across holes (victory = time)
	holesWon   int

	// Shot cooldown: the owner may only shoot once tick >= shootReadyTick. Set when
	// the ball settles (shotDelayTicks) or after a water reset (waterPenaltyTicks,
	// flagged so the client draws the double ring). wasResting tracks the settle edge.
	shootReadyTick uint64
	penaltyPending bool
	wasResting     bool

	// Water sink: ticks remaining in the submerged phase (>0 while the ball is
	// sinking under water). During it the ball runs damped physics and normal
	// water/hole/settle handling is skipped; at 0 it respawns on the near bank.
	// bankX/bankY hold the respawn target chosen on entry.
	sinkTicksLeft uint64
	bankX, bankY  float64
}

type shootCmd struct {
	playerID int
	vx, vy   float64
	club     string // driver | wedge | putter — for the (future) bunker penalty
}

type Match struct {
	roomID  string
	victory string
	holes   []terrain.Hole
	balls   []*matchBall

	phase        MatchPhase
	holeIdx      int
	tick         uint64
	phaseEnds    uint64 // tick a timed phase ends (countdown/intermission/results)
	holeStart    uint64 // tick the current hole's play began
	lastWinnerID int    // winner of the previous hole (starts on the back tee); 0 = none
	prevAnyMoving bool  // for rest-silence: were any balls moving last tick

	geom holegeom.Geometry

	shoots  chan shootCmd
	returns chan struct{}
	done    chan struct{}

	send   func([]byte)
	active func() bool
	onEnd  func()
}

func (mt *Match) run() {
	ticker := time.NewTicker(matchTickRate)
	defer ticker.Stop()

	mt.loadHole(0)
	mt.phase = PhaseCountdown
	mt.phaseEnds = mt.tick + countdownTicks
	mt.broadcastState()

	for {
		select {
		case <-mt.done:
			return
		case <-ticker.C:
			if !mt.step() {
				return
			}
		}
	}
}

// step advances one tick; returns false when the match has ended.
func (mt *Match) step() bool {
	mt.tick++

	if !mt.active() { // everyone left
		mt.onEnd()
		return false
	}

	// Drain commands.
	for drained := false; !drained; {
		select {
		case c := <-mt.shoots:
			mt.applyShoot(c)
		case <-mt.returns:
			if mt.phase == PhaseResults {
				mt.onEnd()
				return false
			}
		default:
			drained = true
		}
	}

	prevPhase := mt.phase
	switch mt.phase {
	case PhaseCountdown:
		if mt.tick >= mt.phaseEnds {
			mt.phase = PhasePlaying
			mt.holeStart = mt.tick
		}
	case PhasePlaying:
		mt.simulate()
		if mt.holeOver() {
			mt.finishHole()
		}
	case PhaseIntermission:
		if mt.tick >= mt.phaseEnds {
			mt.phase = PhasePlaying
			mt.holeStart = mt.tick
		}
	case PhaseResults:
		if mt.tick >= mt.phaseEnds {
			mt.onEnd()
			return false
		}
	}
	phaseChanged := mt.phase != prevPhase

	// Rest-silence: while playing, stream state only when a ball is moving (plus the
	// one settle frame when everything stops); at rest the loop is silent and the
	// client extrapolates the hole clock. Non-playing phases send a low-rate tick
	// just to drive their countdown timers.
	anyMoving := false
	if mt.phase == PhasePlaying {
		for _, b := range mt.balls {
			if !b.sunk && b.ball != nil && !b.ball.Resting {
				anyMoving = true
				break
			}
		}
	}
	doBroadcast := phaseChanged
	if mt.phase == PhasePlaying {
		if anyMoving || mt.prevAnyMoving {
			doBroadcast = true
		}
	} else if mt.tick%6 == 0 {
		doBroadcast = true
	}
	mt.prevAnyMoving = anyMoving
	if doBroadcast {
		mt.broadcastState()
	}
	return true
}

// ballInBunker reports whether world-x sits over a bunker (the sand rim there is
// above the bare terrain). Mirrors single-player main.go ballInBunker and the
// client's check, so the in-bunker shot penalty applies consistently.
func (mt *Match) ballInBunker(x float64) bool {
	for _, bk := range mt.geom.Bunkers {
		if x < bk.LeftX || x > bk.RightX {
			continue
		}
		if terrain.SplineY(x, bk.Coeffs) < mt.geom.CTY(x) {
			return true
		}
	}
	return false
}

func (mt *Match) applyShoot(c shootCmd) {
	if mt.phase != PhasePlaying {
		return
	}
	for _, b := range mt.balls {
		if b.playerID != c.playerID || b.sunk || b.ball == nil || !b.ball.Resting || mt.tick < b.shootReadyTick {
			continue
		}
		vx, vy := c.vx, c.vy
		// Bunker penalty: if the ball sits in sand, scale power by the firing
		// club's multiplier — matching single-player (main.go "shoot" handler).
		if mt.ballInBunker(b.ball.X) {
			var mult float64
			switch c.club {
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
		if s := math.Hypot(vx, vy); s > maxShotSpeed {
			k := maxShotSpeed / s
			vx, vy = vx*k, vy*k
		}
		b.ball.Shoot(vx, vy)
		return
	}
}

// loadHole builds geometry for a hole and (re)spawns all balls at its tee.
func (mt *Match) loadHole(idx int) {
	mt.holeIdx = idx
	hole := mt.holes[idx]
	mt.geom = holegeom.Build(hole)

	// Previous hole's winner takes the back tee (farther from the pit); everyone
	// else starts on the forward tee. First hole (no winner yet) defaults to the
	// first ball on the back tee. Multiple balls sharing a tee are staggered.
	backID := mt.lastWinnerID
	if backID == 0 && len(mt.balls) > 0 {
		backID = mt.balls[0].playerID
	}
	backN, fwdN := 0, 0
	for _, b := range mt.balls {
		var x float64
		if b.playerID == backID {
			x = hole.TeeBackX + float64(backN)*28
			backN++
		} else {
			x = hole.TeeForwardX + float64(fwdN)*28
			fwdN++
		}
		y := mt.geom.CTY(x) - holegeom.TeeH - matchBallRadius
		b.ball = physics.NewBall(x, y, matchBallRadius)
		b.sunk = false
		b.finishTick = 0
		// Immediately shootable at hole start (the countdown was the pause).
		b.shootReadyTick = 0
		b.penaltyPending = false
		b.wasResting = true
		b.sinkTicksLeft = 0
	}
	mt.sendHole(idx)
}

func (mt *Match) simulate() {
	hole := mt.holes[mt.holeIdx]
	subDt := matchTickRate.Seconds() / 4
	nearbyEdges := func(b *physics.Ball) []physics.Edge {
		lo := b.X - b.Radius - 4
		hi := b.X + b.Radius + 4
		var nearby []physics.Edge
		for _, e := range mt.geom.Edges {
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
	for ss := 0; ss < 4; ss++ {
		for _, b := range mt.balls {
			if b.sunk || b.ball == nil {
				continue
			}
			if b.sinkTicksLeft > 0 {
				// Submerged: keep terrain collision but damp velocity and kill any
				// upward (bounce) component so the ball sinks and settles on the
				// underwater floor instead of passing through it or bouncing.
				b.ball.Resting = false
				b.ball.VX *= waterDrag
				b.ball.VY *= waterDrag
				if b.ball.VY < 0 {
					b.ball.VY *= waterBounceKill
				}
				b.ball.Tick(subDt, nearbyEdges(b.ball), 0, hole.WorldW, 0)
				if b.ball.VY < 0 {
					b.ball.VY *= waterBounceKill
				}
				continue
			}
			b.ball.Tick(subDt, nearbyEdges(b.ball), 0, hole.WorldW, 0)
		}
		mt.resolveCollisions()
	}

	cty := mt.geom.CTY
	for _, b := range mt.balls {
		if b.sunk || b.ball == nil {
			continue
		}
		// Already submerged: run down the 5s sink, then respawn on the near bank
		// and start the double-length shot cooldown (the double ring). No normal
		// water/hole/settle handling while sinking.
		if b.sinkTicksLeft > 0 {
			// Force not-resting while submerged: even after the ball settles on the
			// lake bottom the physics step marks it Resting, which would let the
			// owner shoot mid-sink (applyShoot gates on Resting). The ball is only
			// truly shootable once it's respawned on the bank below.
			b.ball.Resting = false
			b.wasResting = false
			b.sinkTicksLeft--
			if b.sinkTicksLeft == 0 {
				b.ball.X, b.ball.Y = b.bankX, b.bankY
				b.ball.VX, b.ball.VY = 0, 0
				b.ball.Resting = true
				b.shootReadyTick = mt.tick + waterPenaltyTicks
				b.penaltyPending = true
				b.wasResting = true
			}
			continue
		}
		// Water entry: begin the submerged sink (the ball keeps its momentum into
		// the water; the submerged branch damps it). Respawn bank is chosen now
		// from the side the ball entered. No invulnerability — the opponent can
		// legitimately shove a fresh ball back into the hazard.
		entered := false
		for i := range mt.geom.Water {
			t := &mt.geom.Water[i]
			if b.ball.X >= t.L && b.ball.X <= t.R && b.ball.Y+b.ball.Radius >= t.Surface {
				bankX := t.L - waterBankOffset
				if b.ball.X > t.CX {
					bankX = t.R + waterBankOffset
				}
				b.bankX = bankX
				b.bankY = cty(bankX) - b.ball.Radius
				b.sinkTicksLeft = waterSinkTicks
				entered = true
				break
			}
		}
		if entered {
			b.wasResting = false // it's moving (sinking), not resting
			continue
		}
		// Hole: sink + record finish time.
		if math.Abs(b.ball.X-hole.HoleX) <= holegeom.HoleW/2 && b.ball.Y > cty(hole.HoleX) {
			b.ball.X = hole.HoleX
			b.ball.Y = cty(hole.HoleX) + holegeom.HoleD/2
			b.ball.VX, b.ball.VY = 0, 0
			b.ball.Resting = true
			b.sunk = true
			b.finishTick = mt.tick - mt.holeStart
			continue
		}
		// Normal settle: the tick a moving ball comes to rest, arm the shot cooldown.
		if b.ball.Resting && !b.wasResting {
			b.shootReadyTick = mt.tick + shotDelayTicks
			b.penaltyPending = false
		}
		b.wasResting = b.ball.Resting
	}
}

// resolveCollisions does circle-circle separation + an elastic impulse between any
// two overlapping balls (collision is the strategic weapon).
func (mt *Match) resolveCollisions() {
	for i := 0; i < len(mt.balls); i++ {
		bi := mt.balls[i]
		if bi.sunk || bi.ball == nil {
			continue
		}
		for j := i + 1; j < len(mt.balls); j++ {
			bj := mt.balls[j]
			if bj.sunk || bj.ball == nil {
				continue
			}
			a, b := bi.ball, bj.ball
			dx, dy := b.X-a.X, b.Y-a.Y
			dist := math.Hypot(dx, dy)
			minDist := a.Radius + b.Radius
			if dist >= minDist || dist == 0 {
				continue
			}
			nx, ny := dx/dist, dy/dist
			overlap := minDist - dist
			// Equal-mass elastic collision: separate, then exchange normal momentum.
			a.X -= nx * overlap / 2
			a.Y -= ny * overlap / 2
			b.X += nx * overlap / 2
			b.Y += ny * overlap / 2
			vn := (b.VX-a.VX)*nx + (b.VY-a.VY)*ny
			if vn < 0 { // approaching
				imp := -(1 + ballCollRest) * vn / 2
				a.VX -= imp * nx
				a.VY -= imp * ny
				b.VX += imp * nx
				b.VY += imp * ny
				a.Resting = false
				b.Resting = false
			}
		}
	}
}

func (mt *Match) holeOver() bool {
	if mt.tick-mt.holeStart >= holeCapTicks {
		return true
	}
	for _, b := range mt.balls {
		if !b.sunk {
			return false
		}
	}
	return true
}

func (mt *Match) finishHole() {
	// DNF cap for anyone still out.
	for _, b := range mt.balls {
		if !b.sunk {
			b.finishTick = holeCapTicks
		}
	}
	// Hole winner = unique fastest.
	best := uint64(math.MaxUint64)
	var winner *matchBall
	tie := false
	for _, b := range mt.balls {
		if b.finishTick < best {
			best, winner, tie = b.finishTick, b, false
		} else if b.finishTick == best {
			tie = true
		}
	}
	if winner != nil && !tie {
		winner.holesWon++
		mt.lastWinnerID = winner.playerID // takes the back tee next hole
	}
	for _, b := range mt.balls {
		b.totalTicks += b.finishTick
	}

	last := mt.holeIdx == len(mt.holes)-1
	mt.broadcastLeaderboard(last)
	if last {
		mt.phase = PhaseResults
		mt.phaseEnds = mt.tick + resultsTicks
	} else {
		mt.loadHole(mt.holeIdx + 1)
		mt.phase = PhaseIntermission
		mt.phaseEnds = mt.tick + intermissionTicks
	}
}

// ---- broadcasting ----

func ticksToMs(t uint64) int { return int(t) * 1000 / 60 }

func (mt *Match) sendHole(idx int) {
	mt.emit(map[string]any{
		"type":      "match:hole",
		"holeIndex": idx,
		"holeCount": len(mt.holes),
		"hole":      mt.holes[idx],
	})
}

func (mt *Match) broadcastState() {
	balls := make([]map[string]any, 0, len(mt.balls))
	for _, b := range mt.balls {
		x, y, resting := 0.0, 0.0, true
		if b.ball != nil {
			x, y, resting = b.ball.X, b.ball.Y, b.ball.Resting
		}
		readyInMs := 0
		if b.shootReadyTick > mt.tick {
			readyInMs = ticksToMs(b.shootReadyTick - mt.tick)
		}
		balls = append(balls, map[string]any{
			"playerId": b.playerID, "x": x, "y": y,
			"color": b.color, "resting": resting, "sunk": b.sunk,
			"readyInMs": readyInMs, "penalty": b.penaltyPending,
			"inWater": b.sinkTicksLeft > 0,
		})
	}
	msLeft := 0
	if mt.phase == PhaseCountdown || mt.phase == PhaseIntermission || mt.phase == PhaseResults {
		if mt.phaseEnds > mt.tick {
			msLeft = ticksToMs(mt.phaseEnds - mt.tick)
		}
	}
	holeMs := 0
	if mt.phase == PhasePlaying {
		holeMs = ticksToMs(mt.tick - mt.holeStart)
	}
	mt.emit(map[string]any{
		"type":      "match:state",
		"phase":     mt.phase,
		"holeIndex": mt.holeIdx,
		"holeCount": len(mt.holes),
		"phaseMsLeft": msLeft,
		"holeMs":    holeMs,
		"balls":     balls,
	})
}

func (mt *Match) broadcastLeaderboard(final bool) {
	entries := make([]map[string]any, 0, len(mt.balls))
	for _, b := range mt.balls {
		entries = append(entries, map[string]any{
			"playerId": b.playerID, "name": b.name, "color": b.color,
			"totalMs": ticksToMs(b.totalTicks), "holesWon": b.holesWon,
			"holeMs": ticksToMs(b.finishTick), "dnf": b.finishTick >= holeCapTicks,
		})
	}
	mt.emit(map[string]any{
		"type": "match:leaderboard", "final": final, "victory": mt.victory,
		"holeIndex": mt.holeIdx, "holeCount": len(mt.holes), "entries": entries,
	})
}

func (mt *Match) emit(v any) {
	if b, err := json.Marshal(v); err == nil {
		mt.send(b)
	}
}

// ---- Manager integration ----

// BeginMatch spins up a match for a room on the given course holes. Call after
// Start() has flipped the room to in_game. Members become balls in id order.
func (m *Manager) BeginMatch(roomID string, holes []terrain.Hole) {
	if len(holes) == 0 {
		return
	}
	m.mu.Lock()
	r, ok := m.rooms[roomID]
	if !ok || m.matches[roomID] != nil {
		m.mu.Unlock()
		return
	}
	ids := make([]int, 0, len(r.Members))
	for id := range r.Members {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	balls := make([]*matchBall, 0, len(ids))
	for _, id := range ids {
		p := r.Members[id]
		balls = append(balls, &matchBall{playerID: p.ID, name: p.Name, color: p.Color})
	}
	victory := r.Victory
	mt := &Match{
		roomID:  roomID,
		victory: victory,
		holes:   holes,
		balls:   balls,
		shoots:  make(chan shootCmd, 64),
		returns: make(chan struct{}, 4),
		done:    make(chan struct{}),
		send:    func(b []byte) { m.Broadcast(roomID, b) },
		active:  func() bool { return m.roomActive(roomID) },
		onEnd:   func() { m.endMatch(roomID) },
	}
	m.matches[roomID] = mt
	m.mu.Unlock()

	go mt.run()
}

// MatchShoot routes a shot to the shooter's ball in their room's match. club is
// the firing club (driver|wedge|putter); it is carried through for the bunker
// penalty (not yet applied in the match loop — see applyShoot).
func (m *Manager) MatchShoot(playerID int, vx, vy float64, club string) {
	m.mu.Lock()
	roomID := m.playerRoom[playerID]
	mt := m.matches[roomID]
	m.mu.Unlock()
	if mt != nil {
		select {
		case mt.shoots <- shootCmd{playerID: playerID, vx: vx, vy: vy, club: club}:
		default:
		}
	}
}

// MatchReturn asks the current match to end (used from the results screen).
func (m *Manager) MatchReturn(playerID int) {
	m.mu.Lock()
	roomID := m.playerRoom[playerID]
	mt := m.matches[roomID]
	m.mu.Unlock()
	if mt != nil {
		select {
		case mt.returns <- struct{}{}:
		default:
		}
	}
}

// RoomCourse returns the host-selected course id for a room ("" if none).
func (m *Manager) RoomCourse(roomID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.rooms[roomID]; ok {
		return r.CourseID
	}
	return ""
}

func (m *Manager) roomActive(roomID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rooms[roomID]
	return ok && len(r.Members) > 0
}

// endMatch tears down a room's match and resets the room to the lobby, notifying
// clients (match:end) so they leave the match screen.
func (m *Manager) endMatch(roomID string) {
	m.mu.Lock()
	mt := m.matches[roomID]
	if mt == nil {
		m.mu.Unlock()
		return
	}
	delete(m.matches, roomID)
	if r, ok := m.rooms[roomID]; ok {
		r.Status = StatusOpen
		for _, p := range r.Members {
			p.Ready = false
		}
	}
	m.mu.Unlock()

	close(mt.done)
	if b, err := json.Marshal(map[string]any{"type": "match:end"}); err == nil {
		m.Broadcast(roomID, b)
	}
	m.BroadcastState(roomID)
}
