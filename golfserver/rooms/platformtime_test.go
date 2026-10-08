package rooms

import "testing"

// The platform clock must read 0 exactly when play begins on a hole, run in step
// with the match ticks after that, and hold at 0 whenever play isn't running (so
// platforms rest at their start pose through the countdown and intermission).
func TestPlatformTimeStartsAtZeroWhenPlayBegins(t *testing.T) {
	mt := &Match{phase: PhaseCountdown, tick: 500, holeStart: 100} // stale holeStart from a previous hole
	if got := mt.platformTime(); got != 0 {
		t.Fatalf("countdown: platform time = %v, want 0 (held at the start pose)", got)
	}

	mt.tick = 700
	mt.startPlaying() // the real GO transition: sets holeStart = tick, phase = playing
	if mt.phase != PhasePlaying || mt.holeStart != 700 {
		t.Fatalf("startPlaying should begin play at tick 700, got phase=%v holeStart=%d", mt.phase, mt.holeStart)
	}
	if got := mt.platformTime(); got != 0 {
		t.Fatalf("at GO: platform time = %v, want exactly 0", got)
	}

	mt.tick = 700 + 90
	if got := mt.platformTime(); got != 1.5 {
		t.Fatalf("90 ticks after GO: platform time = %v, want 1.5s", got)
	}

	mt.phase = PhaseIntermission
	if got := mt.platformTime(); got != 0 {
		t.Fatalf("intermission: platform time = %v, want 0 (held)", got)
	}
}
