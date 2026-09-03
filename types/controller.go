package types

import (
	"time"

	"codeberg.org/uhppoted/uhppoted-core/types"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
)

type IController interface {
	OID() schema.OID
	Name() string
	ID() uint32
	EndPoint() types.ControllerAddr
	TimeZone() *time.Location
	Protocol() string
	Door(uint8) (schema.OID, bool)
	Interlock() types.Interlock
	AntiPassback() types.AntiPassback

	DateTimeOk() bool
}
