package pipwindow

import "testing"

func TestConfigValidate(t *testing.T) {
	for _, position := range []string{
		PositionCurrent,
		PositionTopLeft,
		PositionTopRight,
		PositionBottomLeft,
		PositionBottomRight,
		PositionCenter,
	} {
		t.Run(position, func(t *testing.T) {
			if err := (Config{Opacity: 65, Position: position, Margin: 12}).Validate(); err != nil {
				t.Errorf("Validate() error = %v", err)
			}
		})
	}
}

func TestConfigValidateRejectsInvalidValues(t *testing.T) {
	cases := []Config{
		{Opacity: MinOpacity - 1, Position: PositionCurrent},
		{Opacity: MaxOpacity + 1, Position: PositionCurrent},
		{Opacity: 65, Position: "outside-screen"},
		{Opacity: 65, Position: PositionCurrent, Margin: -1},
		{Opacity: 65, Position: PositionCurrent, Margin: 201},
	}

	for _, config := range cases {
		if err := config.Validate(); err == nil {
			t.Errorf("Validate(%+v) returned nil", config)
		}
	}
}
