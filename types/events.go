package types

import (
	"codeberg.org/uhppoted/uhppoted-lib/uhppoted"
)

type EventsList struct {
	DeviceID uint32
	Events   []uhppoted.Event
}
