package terrain

import "math"

type TerrainWave struct {
	Amplitude float64 `json:"amplitude"`
	Period    float64 `json:"period"`
	Phase     float64 `json:"phase"`
}

type TerrainSegment struct {
	Length float64       `json:"length"`
	Waves  []TerrainWave `json:"waves"`
}

type Course struct {
	WorldW      float64          `json:"worldW"`
	WorldH      float64          `json:"worldH"`
	BaseGround  float64          `json:"baseGround"`
	TeeBackX    float64          `json:"teeBackX"`
	TeeForwardX float64          `json:"teeForwardX"`
	HoleX       float64          `json:"holeX"`
	Segments    []TerrainSegment `json:"segments"`
}

// BuiltSegment is a precomputed segment with continuity offset.
type BuiltSegment struct {
	StartX float64
	Length float64
	Waves  []TerrainWave
	Offset float64 // vertical shift so Y(StartX) == previous segment's end Y
}

// BuildSegments computes startX and offset for each segment so adjacent
// segments always connect at the same height (C0 continuity).
func BuildSegments(c Course) []BuiltSegment {
	built := make([]BuiltSegment, len(c.Segments))
	curX := 0.0
	curY := c.BaseGround
	for i, seg := range c.Segments {
		atStart := 0.0
		for _, w := range seg.Waves {
			atStart += w.Amplitude * math.Sin(w.Phase)
		}
		offset := curY - atStart
		atEnd := 0.0
		for _, w := range seg.Waves {
			atEnd += w.Amplitude * math.Sin(seg.Length/w.Period+w.Phase)
		}
		curY = offset + atEnd
		built[i] = BuiltSegment{StartX: curX, Length: seg.Length, Waves: seg.Waves, Offset: offset}
		curX += seg.Length
	}
	return built
}

func TerrainY(x float64, segs []BuiltSegment) float64 {
	for i, s := range segs {
		if x < s.StartX+s.Length || i == len(segs)-1 {
			lx := x - s.StartX
			y := s.Offset
			for _, w := range s.Waves {
				y += w.Amplitude * math.Sin(lx/w.Period+w.Phase)
			}
			return y
		}
	}
	if len(segs) > 0 {
		return segs[0].Offset
	}
	return 650
}

func TerrainSlope(x float64, segs []BuiltSegment) float64 {
	for i, s := range segs {
		if x < s.StartX+s.Length || i == len(segs)-1 {
			lx := x - s.StartX
			slope := 0.0
			for _, w := range s.Waves {
				slope += (w.Amplitude / w.Period) * math.Cos(lx/w.Period+w.Phase)
			}
			return slope
		}
	}
	return 0
}

// DefaultCourse returns the original 3-sinusoid terrain as a single segment.
func DefaultCourse() Course {
	return Course{
		WorldW:      4000,
		WorldH:      1000,
		BaseGround:  650,
		TeeBackX:    200,
		TeeForwardX: 400,
		HoleX:       3700,
		Segments: []TerrainSegment{{
			Length: 4000,
			Waves: []TerrainWave{
				{Amplitude: 80, Period: 800, Phase: 0},
				{Amplitude: 40, Period: 300, Phase: 0},
				{Amplitude: 20, Period: 150, Phase: 0},
			},
		}},
	}
}
