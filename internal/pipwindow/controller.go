package pipwindow

import (
	"errors"
	"fmt"
)

const (
	PositionCurrent     = "current"
	PositionTopLeft     = "top-left"
	PositionTopRight    = "top-right"
	PositionBottomLeft  = "bottom-left"
	PositionBottomRight = "bottom-right"
	PositionCenter      = "center"

	MinOpacity = 20
	MaxOpacity = 100
)

var (
	ErrNotSupported   = errors.New("PiP window controls are not supported on this platform")
	ErrWindowNotFound = errors.New("browser Picture-in-Picture window not found")
)

type Config struct {
	Opacity  int    `json:"opacity"`
	Position string `json:"position"`
	Margin   int    `json:"margin,omitempty"`
}

func (c Config) Validate() error {
	if c.Opacity < MinOpacity || c.Opacity > MaxOpacity {
		return fmt.Errorf("opacity must be between %d and %d", MinOpacity, MaxOpacity)
	}

	switch c.Position {
	case PositionCurrent, PositionTopLeft, PositionTopRight, PositionBottomLeft, PositionBottomRight, PositionCenter:
	default:
		return fmt.Errorf("unsupported position %q", c.Position)
	}

	if c.Margin < 0 || c.Margin > 200 {
		return errors.New("margin must be between 0 and 200")
	}

	return nil
}

type Controller interface {
	Supported() bool
	Apply(Config) error
}
