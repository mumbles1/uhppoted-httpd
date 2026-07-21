package system

import (
	"sync"

	lib "codeberg.org/uhppoted/uhppoted-core/types"

	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/types"
	"codeberg.org/uhppoted/uhppoted-lib/acl"
)

func (s *system) synchronizeACL() error {
	controllers := s.controllers.AsIControllers()

	if acl, err := s.permissions(controllers); err != nil {
		warnf("ACL", "%v", err)
	} else if diff, err := s.interfaces.CompareACL(controllers, acl, s.withPIN); err != nil {
		warnf("ACL", "%v", err)
	} else if diff == nil {
		warnf("ACL", "invalid ACL diff (%v)", diff)
	} else {
		list := map[uint32]struct{}{}

		for _, v := range diff {
			for _, v := range v.Updated {
				list[v.CardNumber] = struct{}{}
			}

			for _, v := range v.Added {
				list[v.CardNumber] = struct{}{}
			}

			for _, v := range v.Deleted {
				list[v.CardNumber] = struct{}{}
			}
		}

		var wg sync.WaitGroup

		for _, c := range controllers {
			wg.Add(1)

			controller := c
			go func(v types.IController) {
				defer wg.Done()

				for card := range list {
					s.updateCardPermissions(controller, card)
				}
			}(controller)
		}

		wg.Wait()
	}

	return nil
}

func (s *system) compareACL() {
	controllers := s.controllers.AsIControllers()

	if acl, err := s.permissions(controllers); err != nil {
		warnf("ACL", "%v", err)
	} else if diff, err := s.interfaces.CompareACL(controllers, acl, s.withPIN); err != nil {
		warnf("ACL", "%v", err)
	} else if diff == nil {
		warnf("ACL", "invalid ACL diff (%v)", diff)
	} else {
		found := map[uint32]struct{}{}
		cards := map[uint32]struct{}{}

		for _, v := range diff {
			for _, v := range v.Updated {
				cards[v.CardNumber] = struct{}{}
			}

			for _, v := range v.Added {
				cards[v.CardNumber] = struct{}{}
			}

			for _, v := range v.Deleted {
				if !v.From.IsZero() && !v.To.IsZero() {
					cards[v.CardNumber] = struct{}{}
				}
			}
		}

		for _, v := range diff {
			for _, v := range v.Added {
				found[v.CardNumber] = struct{}{}
			}
		}

		remap := func(cards map[uint32]struct{}) []uint32 {
			list := []uint32{}
			for k := range cards {
				list = append(list, k)
			}

			return list
		}

		sys.cards.Found(remap(found))
		sys.cards.MarkIncorrect(remap(cards))
	}
}

// NTS: revoke all if card is nil because card number may have changed and the old card will no longer have access
func (s *system) updateCardPermissions(controller types.IController, cardID uint32) {
	if cardID == 0 {
		return
	}

	PIN := uint32(0)
	from := lib.Date{}
	to := lib.Date{}

	acl := map[uint8]uint8{
		1: 0,
		2: 0,
		3: 0,
		4: 0,
	}

	firstcard := map[uint8]bool{
		1: false,
		2: false,
		3: false,
		4: false,
	}

	type permission struct {
		allowed   bool
		firstcard bool
	}

	permissions := map[schema.OID]permission{}

	card, unconfigured := s.cards.Lookup(cardID)

	if card != nil {
		from = card.From()
		to = card.To()

		if s.withPIN {
			PIN = card.PIN()
		}

		// ... get base permissions from groups
		groups := card.Groups()
		for _, g := range groups {
			if group, ok := s.groups.Group(g); ok {
				for oid, allowed := range group.Doors {
					p := permissions[oid]
					permissions[oid] = permission{
						allowed:   p.allowed || allowed,
						firstcard: p.firstcard || ((p.allowed || allowed) && group.FirstCard),
					}
				}
			}
		}

		for _, d := range []uint8{1, 2, 3, 4} {
			if oid, ok := controller.Door(d); ok {
				p, ok := permissions[oid]
				if ok {
					if p.allowed {
						acl[d] = 1
					}

					if s.withFirstCard && p.firstcard {
						firstcard[d] = p.firstcard
					}
				}
			}
		}

		// ... updated base permissions with grules
		if sys.rules != nil {
			allowed, forbidden, err := sys.rules.Eval(*card, sys.doors)
			if err != nil {
				warnf("ACL", "%v", err)
				return
			}

			for _, door := range allowed {
				for _, d := range []uint8{1, 2, 3, 4} {
					if oid, ok := controller.Door(d); ok && oid == door.OID {
						acl[d] = 1
					}
				}
			}

			for _, door := range forbidden {
				for _, d := range []uint8{1, 2, 3, 4} {
					if oid, ok := controller.Door(d); ok && oid == door.OID {
						acl[d] = 0
					}
				}
			}
		}
	}

	if card == nil || card.IsDeleted() || unconfigured {
		s.interfaces.DeleteCard(controller, cardID)
	} else if from.IsZero() && sys.acl.defaultStartDate.IsZero() {
		warnf("ACL", "%v  excluding card %v (missing start date)", controller.ID(), card.CardID)
		s.interfaces.DeleteCard(controller, cardID)
	} else if to.IsZero() && sys.acl.defaultEndDate.IsZero() {
		warnf("ACL", "%v  excluding card %v (missing end date)", controller.ID(), card.CardID)
		s.interfaces.DeleteCard(controller, cardID)
	} else {
		if from.IsZero() {
			from = sys.acl.defaultStartDate
		}

		if to.IsZero() {
			to = sys.acl.defaultEndDate
		}

		s.interfaces.PutCard(controller, cardID, PIN, from, to, acl, firstcard)
	}
}

func (s *system) permissions(controllers []types.IController) (acl.ACL, error) {
	cards := s.cards.List()
	groups := s.groups
	doors := s.doors

	// initialise empty ACL
	acl := make(acl.ACL)
	for _, b := range controllers {
		if v := b.ID(); v != 0 {
			acl[v] = map[uint32]lib.Card{}
		}
	}

	for _, l := range acl {
		for _, c := range cards {
			if card, ok := c.AsAclCard(); ok && !c.IsDeleted() {
				l[card.CardNumber] = card
			}
		}
	}

	// ... populate ACL from cards + groups + doors
	grant := func(card uint32, controller uint32, door uint8) {
		if card > 0 && controller > 0 && door >= 1 && door <= 4 {
			if _, ok := acl[controller]; ok {
				if _, ok := acl[controller][card]; ok {
					if _, ok := acl[controller][card].Doors[door]; ok {
						acl[controller][card].Doors[door] = 1
					}
				}
			}
		}
	}

	revoke := func(card uint32, controller uint32, door uint8) {
		if card > 0 && controller > 0 && door >= 1 && door <= 4 {
			if _, ok := acl[controller]; ok {
				if _, ok := acl[controller][card]; ok {
					if _, ok := acl[controller][card].Doors[door]; ok {
						acl[controller][card].Doors[door] = 0
					}
				}
			}
		}
	}

	firstcard := func(card uint32) {
		if card > 0 {
			for controller := range acl {
				if c, ok := acl[controller][card]; ok {
					c.FirstCard = lib.FirstCardPrivileges{}

					if allowed, ok := acl[controller][card].Doors[1]; allowed != 0 && ok {
						c.FirstCard.Door1 = true
					}

					if allowed, ok := acl[controller][card].Doors[2]; allowed != 0 && ok {
						c.FirstCard.Door2 = true
					}

					if allowed, ok := acl[controller][card].Doors[3]; allowed != 0 && ok {
						c.FirstCard.Door3 = true
					}

					if allowed, ok := acl[controller][card].Doors[4]; allowed != 0 && ok {
						c.FirstCard.Door4 = true
					}

					acl[controller][card] = c
				}
			}
		}
	}

	for _, c := range cards {
		card := c.CardID
		membership := c.Groups()

		for _, g := range membership {
			if group, ok := groups.Group(g); ok {
				for d, allowed := range group.Doors {
					if door, ok := doors.Door(d); ok && allowed {
						controller := catalog.GetDoorDeviceID(door.OID)
						doorID := catalog.GetDoorDeviceDoor(door.OID)

						grant(card, controller, doorID)
					}
				}

				if group.FirstCard {
					firstcard(card)
				}
			}
		}
	}

	// ... post-process ACL with default start/end dates
	for _, l := range acl {
		for _, c := range cards {
			card := l[c.CardID]

			if card.From.IsZero() {
				card.From = sys.acl.defaultStartDate
			}

			if card.To.IsZero() {
				card.To = sys.acl.defaultEndDate
			}

			l[c.CardID] = card
		}
	}

	// ... post-process ACL with rules
	if sys.rules != nil {
		for _, c := range cards {
			card := c.CardID
			allowed, forbidden, err := sys.rules.Eval(c, sys.doors)
			if err != nil {
				return nil, err
			}

			for _, door := range allowed {
				device := catalog.GetDoorDeviceID(door.OID)
				doorID := catalog.GetDoorDeviceDoor(door.OID)
				grant(card, device, doorID)
			}

			for _, door := range forbidden {
				device := catalog.GetDoorDeviceID(door.OID)
				doorID := catalog.GetDoorDeviceDoor(door.OID)
				revoke(card, device, doorID)
			}
		}
	}

	return acl, nil
}
