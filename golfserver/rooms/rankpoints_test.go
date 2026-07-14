package rooms

import "testing"

// holeRankPoints assigns per-hole rank points in Match scope. Every tie group's
// members receive the points of the lowest rank position the group occupies.
// These cases lock in the point tables agreed for 2/3/4 players.
func TestHoleRankPoints(t *testing.T) {
	cases := []struct {
		name    string
		metrics []uint64 // lower = better
		want    []int    // parallel to metrics
	}{
		// 2 players
		{"2p A B", []uint64{1, 2}, []int{1, 0}},
		{"2p AA", []uint64{5, 5}, []int{0, 0}},

		// 3 players
		{"3p A B C", []uint64{1, 2, 3}, []int{3, 1, 0}},
		{"3p AA B", []uint64{1, 1, 2}, []int{1, 1, 0}},
		{"3p A BB", []uint64{1, 2, 2}, []int{3, 0, 0}},
		{"3p AAA", []uint64{2, 2, 2}, []int{0, 0, 0}},

		// 4 players
		{"4p A B C D", []uint64{1, 2, 3, 4}, []int{4, 2, 1, 0}},
		{"4p AA B C", []uint64{1, 1, 2, 3}, []int{2, 2, 1, 0}},
		{"4p A BB C", []uint64{1, 2, 2, 3}, []int{4, 1, 1, 0}},
		{"4p A B CC", []uint64{1, 2, 3, 3}, []int{4, 2, 0, 0}},
		{"4p AAA B", []uint64{1, 1, 1, 2}, []int{1, 1, 1, 0}},
		{"4p A BBB", []uint64{1, 2, 2, 2}, []int{4, 0, 0, 0}},
		{"4p AA BB", []uint64{1, 1, 2, 2}, []int{2, 2, 0, 0}},
		{"4p AAAA", []uint64{3, 3, 3, 3}, []int{0, 0, 0, 0}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := holeRankPoints(c.metrics)
			if len(got) != len(c.want) {
				t.Fatalf("len = %d, want %d", len(got), len(c.want))
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Errorf("player %d: got %d, want %d (metrics=%v got=%v)", i, got[i], c.want[i], c.metrics, got)
				}
			}
		})
	}
}
