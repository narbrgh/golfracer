// Package rooms is the in-memory registry of online lobby rooms and their members.
// It ports the pattern of the Botonoids room system (create / join / list, room
// summaries, per-room broadcast) without its game-specific role/tilemap concepts.
// Rooms are ephemeral — they live only in memory and vanish on restart, and an
// empty room is deleted automatically.
//
// The Manager is the single source of truth: it owns rooms, their members (each
// holding an outbound Send channel), and a player→room index. All mutation and
// broadcast go through its mutex. The WebSocket transport (main.go) owns the
// socket lifecycle and drains each Player.Send.
package rooms

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
)

type Status string

const (
	StatusOpen     Status = "open"
	StatusInGame   Status = "in_game"
	StatusFinished Status = "finished"
)

// A room holds up to maxOccupants people, of whom at most maxPlayers are active
// players (each becomes a ball); the rest are spectators. Picking a ball color
// claims a player slot; choosing spectator frees it.
const (
	maxOccupants = 6
	maxPlayers   = 4
)

// BallColors are the selectable ball colors. Used to auto-assign a free color on
// join and to enforce uniqueness within a room. Must match the client palette
// order in golfclient/src/screens/roomLobby.ts.
var BallColors = []string{"white", "green", "teal", "blue", "orange", "red", "yellow", "pink"}

func validColor(c string) bool {
	for _, bc := range BallColors {
		if bc == c {
			return true
		}
	}
	return false
}

var validVictory = map[string]bool{"time": true, "holes": true}

var (
	ErrNoRoom       = errors.New("join a room first")
	ErrRoomNotFound = errors.New("room not found")
	ErrRoomFull     = errors.New("room is full")
	ErrRoomInGame   = errors.New("room already in game")
	ErrNotHost      = errors.New("only the host can do that")
	ErrColorTaken   = errors.New("that color is taken")
	ErrBadColor     = errors.New("invalid color")
	ErrNotReady     = errors.New("everyone must be ready")
	ErrBadVictory   = errors.New("invalid victory condition")
	ErrNoPlayerSlot = errors.New("all player slots are taken")
)

// Player is a connected lobby participant. Send is a buffered outbound queue the
// transport's writer goroutine drains.
type Player struct {
	ID        int
	Name      string
	Color     string
	Ready     bool
	Spectator bool // watches only; not turned into a ball, excluded from the ready gate
	Send      chan []byte
}

type Room struct {
	ID         string
	Name       string
	MaxPlayers int
	Status     Status
	CreatedAt  time.Time
	HostID     int
	CourseID   string
	Victory    string
	Members    map[int]*Player
}

// Summary is the room-browser wire shape (JSON tags match the TS RoomSummary).
type Summary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	PlayerCount int    `json:"playerCount"`
	MaxPlayers  int    `json:"maxPlayers"`
	Status      Status `json:"status"`
	CreatedAt   int64  `json:"createdAtUnix"`
}

func (r *Room) summary() Summary {
	return Summary{
		ID:          r.ID,
		Name:        r.Name,
		PlayerCount: len(r.Members),
		MaxPlayers:  r.MaxPlayers,
		Status:      r.Status,
		CreatedAt:   r.CreatedAt.Unix(),
	}
}

// PlayerState / RoomState are the lobby snapshot wire shapes.
type PlayerState struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	Ready     bool   `json:"ready"`
	IsHost    bool   `json:"isHost"`
	Spectator bool   `json:"spectator"`
}

type RoomState struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	HostID       int           `json:"hostId"`
	Status       Status        `json:"status"`
	MaxPlayers   int           `json:"maxPlayers"`   // active-player cap (4)
	MaxOccupants int           `json:"maxOccupants"` // total people cap (6)
	PlayerCount  int           `json:"playerCount"`  // current non-spectator members
	CourseID     string        `json:"courseId"`
	Victory      string        `json:"victory"`
	CanStart     bool          `json:"canStart"`
	Players      []PlayerState `json:"players"`
}

func (r *Room) state() RoomState {
	players := make([]PlayerState, 0, len(r.Members))
	for _, p := range r.Members {
		players = append(players, PlayerState{
			ID: p.ID, Name: p.Name, Color: p.Color, Ready: p.Ready,
			IsHost: p.ID == r.HostID, Spectator: p.Spectator,
		})
	}
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })
	return RoomState{
		ID: r.ID, Name: r.Name, HostID: r.HostID, Status: r.Status,
		MaxPlayers: maxPlayers, MaxOccupants: maxOccupants, PlayerCount: r.playerCount(),
		CourseID: r.CourseID, Victory: r.Victory, CanStart: r.canStart(), Players: players,
	}
}

// playerCount is the number of non-spectator members (the balls a match spawns).
func (r *Room) playerCount() int {
	n := 0
	for _, p := range r.Members {
		if !p.Spectator {
			n++
		}
	}
	return n
}

// canStart is true when there's at least one player and every player is ready
// (spectators are ignored). Colors are already unique by construction. Solo is
// allowed for now so a host can test flow.
func (r *Room) canStart() bool {
	players := 0
	for _, p := range r.Members {
		if p.Spectator {
			continue
		}
		players++
		if !p.Ready {
			return false
		}
	}
	return players > 0
}

type Manager struct {
	mu         sync.Mutex
	rooms      map[string]*Room
	playerRoom map[int]string    // playerID -> roomID (a player is in at most one room)
	matches    map[string]*Match // roomID -> running match (present only while in_game)
}

func NewManager() *Manager {
	return &Manager{
		rooms:      make(map[string]*Room),
		playerRoom: make(map[int]string),
		matches:    make(map[string]*Match),
	}
}

// CreateAndJoin makes a new open room with p as host + first member.
func (m *Manager) CreateAndJoin(p *Player, name string) string {
	m.mu.Lock()
	defer m.mu.Unlock()

	name = trimRoomName(name)
	id := m.freeIDLocked()
	r := &Room{
		ID: id, Name: name, MaxPlayers: maxOccupants, Status: StatusOpen,
		CreatedAt: time.Now(), HostID: p.ID, Victory: "time", Members: make(map[int]*Player),
	}
	m.leaveLocked(p.ID)
	p.Ready = false
	m.assignColorLocked(r, p)
	r.Members[p.ID] = p
	m.rooms[id] = r
	m.playerRoom[p.ID] = id
	return id
}

// Join adds p to an open room with space.
func (m *Manager) Join(p *Player, roomID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	r, ok := m.rooms[roomID]
	if !ok {
		return ErrRoomNotFound
	}
	if r.Status != StatusOpen {
		return ErrRoomInGame
	}
	if _, already := r.Members[p.ID]; !already && len(r.Members) >= maxOccupants {
		return ErrRoomFull
	}
	m.leaveLocked(p.ID)
	p.Ready = false
	// Join as a player if a slot is free, else as a spectator.
	p.Spectator = r.playerCount() >= maxPlayers
	if p.Spectator {
		p.Color = ""
	} else {
		m.assignColorLocked(r, p)
	}
	r.Members[p.ID] = p
	m.playerRoom[p.ID] = roomID
	return nil
}

// Leave removes a player from its room. Returns the roomID and whether the room
// still exists (empty rooms are deleted).
func (m *Manager) Leave(playerID int) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.leaveLocked(playerID)
}

func (m *Manager) leaveLocked(playerID int) (string, bool) {
	roomID, ok := m.playerRoom[playerID]
	if !ok {
		return "", false
	}
	delete(m.playerRoom, playerID)
	r, ok := m.rooms[roomID]
	if !ok {
		return "", false
	}
	delete(r.Members, playerID)
	if len(r.Members) == 0 {
		delete(m.rooms, roomID)
		return roomID, false
	}
	if r.HostID == playerID {
		// Promote the lowest remaining player id to host.
		next := -1
		for id := range r.Members {
			if next == -1 || id < next {
				next = id
			}
		}
		r.HostID = next
	}
	return roomID, true
}

func (m *Manager) SetName(playerID int, name string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roomID, _, p, ok := m.memberLocked(playerID)
	if !ok {
		return "", false
	}
	n := trimSpace(name)
	if n == "" {
		return roomID, false // ignore empty rename, no broadcast
	}
	if len(n) > 16 {
		n = n[:16]
	}
	p.Name = n
	return roomID, true
}

func (m *Manager) SetColor(playerID int, color string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roomID, r, p, ok := m.memberLocked(playerID)
	if !ok {
		return "", ErrNoRoom
	}
	if !validColor(color) {
		return "", ErrBadColor
	}
	for _, o := range r.Members {
		if o.ID != playerID && o.Color == color {
			return "", ErrColorTaken
		}
	}
	// Picking a color claims a player slot: a spectator becomes a player if one is
	// free (else the choice is rejected so slots aren't overrun).
	if p.Spectator {
		if r.playerCount() >= maxPlayers {
			return "", ErrNoPlayerSlot
		}
		p.Spectator = false
	}
	p.Color = color
	return roomID, nil
}

// SetSpectator toggles a member's spectator role. Becoming a spectator always
// succeeds and frees a player slot; becoming a player requires a free slot and
// auto-assigns a color.
func (m *Manager) SetSpectator(playerID int, spectator bool) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roomID, r, p, ok := m.memberLocked(playerID)
	if !ok {
		return "", ErrNoRoom
	}
	if spectator == p.Spectator {
		return roomID, nil
	}
	if spectator {
		p.Spectator = true
		p.Ready = false
		p.Color = ""
	} else {
		if r.playerCount() >= maxPlayers {
			return "", ErrNoPlayerSlot
		}
		p.Spectator = false
		m.assignColorLocked(r, p)
	}
	return roomID, nil
}

func (m *Manager) SetReady(playerID int, ready bool) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roomID, _, p, ok := m.memberLocked(playerID)
	if !ok {
		return "", false
	}
	p.Ready = ready
	return roomID, true
}

func (m *Manager) SetCourse(playerID int, courseID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roomID, r, _, ok := m.memberLocked(playerID)
	if !ok {
		return "", ErrNoRoom
	}
	if r.HostID != playerID {
		return "", ErrNotHost
	}
	r.CourseID = courseID
	return roomID, nil
}

func (m *Manager) SetVictory(playerID int, victory string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roomID, r, _, ok := m.memberLocked(playerID)
	if !ok {
		return "", ErrNoRoom
	}
	if r.HostID != playerID {
		return "", ErrNotHost
	}
	if !validVictory[victory] {
		return "", ErrBadVictory
	}
	r.Victory = victory
	return roomID, nil
}

// Start marks the room in-game if the host requests it and everyone is ready.
func (m *Manager) Start(playerID int) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	roomID, r, _, ok := m.memberLocked(playerID)
	if !ok {
		return "", ErrNoRoom
	}
	if r.HostID != playerID {
		return "", ErrNotHost
	}
	if !r.canStart() {
		return "", ErrNotReady
	}
	r.Status = StatusInGame
	return roomID, nil
}

func (m *Manager) RoomOf(playerID int) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.playerRoom[playerID]
	return id, ok
}

func (m *Manager) PlayerName(playerID int) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, _, p, ok := m.memberLocked(playerID)
	if !ok {
		return ""
	}
	return p.Name
}

// List returns room summaries, newest first.
func (m *Manager) List() []Summary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Summary, 0, len(m.rooms))
	for _, r := range m.rooms {
		out = append(out, r.summary())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

// BroadcastState sends the current room snapshot to every member.
func (m *Manager) BroadcastState(roomID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rooms[roomID]
	if !ok {
		return
	}
	b, err := json.Marshal(map[string]any{"type": "room:state", "room": r.state()})
	if err != nil {
		return
	}
	for _, p := range r.Members {
		trySend(p, b)
	}
}

// Broadcast sends a pre-marshaled message to every member of a room (used for chat
// and start signals).
func (m *Manager) Broadcast(roomID string, msg []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rooms[roomID]
	if !ok {
		return
	}
	for _, p := range r.Members {
		trySend(p, msg)
	}
}

// --- locked helpers ---

func (m *Manager) memberLocked(playerID int) (string, *Room, *Player, bool) {
	roomID, ok := m.playerRoom[playerID]
	if !ok {
		return "", nil, nil, false
	}
	r, ok := m.rooms[roomID]
	if !ok {
		return "", nil, nil, false
	}
	p, ok := r.Members[playerID]
	if !ok {
		return "", nil, nil, false
	}
	return roomID, r, p, true
}

func (m *Manager) assignColorLocked(r *Room, p *Player) {
	used := make(map[string]bool)
	for _, o := range r.Members {
		if o.ID != p.ID {
			used[o.Color] = true
		}
	}
	if p.Color != "" && !used[p.Color] {
		return
	}
	for _, c := range BallColors {
		if !used[c] {
			p.Color = c
			return
		}
	}
}

func (m *Manager) freeIDLocked() string {
	id := newID()
	for _, taken := m.rooms[id]; taken; _, taken = m.rooms[id] {
		id = newID()
	}
	return id
}

// trySend enqueues without blocking; drops if the queue is full or the channel is
// closed (recover guards a send on a just-closed channel during disconnect).
func trySend(p *Player, msg []byte) {
	defer func() { _ = recover() }()
	select {
	case p.Send <- msg:
	default:
	}
}

func trimRoomName(name string) string {
	name = trimSpace(name)
	if name == "" {
		return "Room"
	}
	if len(name) > 24 {
		name = name[:24]
	}
	return name
}

func trimSpace(s string) string {
	// small local trim to avoid importing strings for one call
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
