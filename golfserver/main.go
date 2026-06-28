package main

import (
	"fmt"
	"golf01/server/physics"
)

func main() {
	fmt.Println("speedgolf server starting...")

	ball := physics.NewBall(50, 100, 10)
	ball.Shoot(150, -300)
	for i := 0; i < 200; i++ {
		ball.Tick(1.0/60.0, 400)
		fmt.Printf("t=%.2f  x=%.1f y=%.1f resting=%v\n", float64(i)/60.0, ball.X, ball.Y, ball.Resting)
	}
}
