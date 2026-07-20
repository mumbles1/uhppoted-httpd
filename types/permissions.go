package types

import (
	"fmt"

	core "codeberg.org/uhppoted/uhppoted-core/types"
)

type Permissions struct {
	CardNumber uint32
	From       core.Date
	To         core.Date
	Doors      []string
}

func (p Permissions) String() string {
	return fmt.Sprintf("%-10v %v %v %v", p.CardNumber, p.From, p.To, p.Doors)
}
