package rooms

import (
	"reflect"
	"testing"
)

// selectTees always keeps the back tee and fills the rest from the front-most
// tees, spreading the field to the extremes as players thin out.
func TestSelectTees(t *testing.T) {
	four := []float64{200, 267, 333, 400}
	cases := []struct {
		name string
		tees []float64
		n    int
		want []float64
	}{
		{"4-tee, 2 players", four, 2, []float64{200, 400}},
		{"4-tee, 3 players", four, 3, []float64{200, 333, 400}},
		{"4-tee, 4 players", four, 4, four},
		{"4-tee, 1 player", four, 1, []float64{200}},
		{"more players than tees", four, 6, four},
		{"empty tees", nil, 3, nil},
		{"single tee", []float64{200}, 3, []float64{200}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := selectTees(c.tees, c.n)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("selectTees(%v, %d) = %v, want %v", c.tees, c.n, got, c.want)
			}
		})
	}
}
