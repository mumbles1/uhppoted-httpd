package system

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	lib "codeberg.org/uhppoted/uhppoted-core/types"
	"codeberg.org/uhppoted/uhppoted-httpd/auth"
	"codeberg.org/uhppoted/uhppoted-httpd/system/cards"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/system/db"
	"codeberg.org/uhppoted/uhppoted-lib/acl"
)

type ControllerImportCredential struct {
	CardNumber  uint32   `json:"cardNumber"`
	PIN         uint32   `json:"pin,omitempty"`
	From        string   `json:"from"`
	To          string   `json:"to"`
	Relays      []string `json:"relays"`
	Controllers []uint32 `json:"controllers"`
	Supported   bool     `json:"supported"`
	Resolvable  bool     `json:"resolvable"`
	LocalMatch  bool     `json:"localMatch"`
	Warning     string   `json:"warning,omitempty"`
}

type ControllerImportPreview struct {
	Controllers int                          `json:"controllers"`
	Credentials []ControllerImportCredential `json:"credentials"`
	Supported   int                          `json:"supported"`
	Resolvable  int                          `json:"resolvable"`
	Skipped     int                          `json:"skipped"`
	Warnings    []string                     `json:"warnings"`
	raw         acl.ACL
}

type ControllerImportResolution struct {
	Mode       string `json:"mode"`
	Controller uint32 `json:"controller"`
}

func ReadControllerImport() (ControllerImportPreview, error) {
	controllers := sys.controllers.AsIControllers()
	if len(controllers) == 0 {
		return ControllerImportPreview{}, fmt.Errorf("no configured controllers")
	}
	current, failures := sys.interfaces.ControllerACL(controllers)
	if len(failures) > 0 {
		return ControllerImportPreview{}, errors.Join(failures...)
	}
	if current == nil {
		return ControllerImportPreview{}, fmt.Errorf("controller returned no credential data")
	}

	type aggregate struct {
		card        lib.Card
		controllers []uint32
		relays      map[schema.OID]bool
		unsupported []string
		conflict    bool
	}
	merged := map[uint32]*aggregate{}
	for controllerID, list := range current {
		var controllerDoor func(uint8) (schema.OID, bool)
		for _, controller := range controllers {
			if controller.ID() == controllerID {
				controllerDoor = controller.Door
				break
			}
		}
		for number, card := range list {
			a := merged[number]
			if a == nil {
				a = &aggregate{card: card, relays: map[schema.OID]bool{}}
				merged[number] = a
			} else if fmt.Sprint(a.card.From) != fmt.Sprint(card.From) || fmt.Sprint(a.card.To) != fmt.Sprint(card.To) || (sys.withPIN && a.card.PIN != card.PIN) {
				a.conflict = true
			}
			a.controllers = append(a.controllers, controllerID)
		forDoors:
			for door, profile := range card.Doors {
				if profile == 0 {
					continue
				}
				if profile != 1 {
					a.unsupported = append(a.unsupported, fmt.Sprintf("controller %d relay %d uses time profile %d", controllerID, door, profile))
					continue forDoors
				}
				if controllerDoor != nil {
					if oid, ok := controllerDoor(door); ok {
						a.relays[oid] = true
					} else {
						a.unsupported = append(a.unsupported, fmt.Sprintf("controller %d relay %d is not assigned locally", controllerID, door))
					}
				}
			}
			if card.FirstCard.Door1 || card.FirstCard.Door2 || card.FirstCard.Door3 || card.FirstCard.Door4 {
				a.unsupported = append(a.unsupported, fmt.Sprintf("controller %d has first-card privileges", controllerID))
			}
		}
	}

	preview := ControllerImportPreview{Controllers: len(current), Credentials: []ControllerImportCredential{}, Warnings: []string{}, raw: current}
	localCards := map[uint32]bool{}
	for _, card := range sys.cards.List() {
		if card.CardID != 0 && !card.IsDeleted() {
			localCards[card.CardID] = true
		}
	}
	numbers := make([]uint32, 0, len(merged))
	for number := range merged {
		numbers = append(numbers, number)
	}
	sort.Slice(numbers, func(i, j int) bool { return numbers[i] < numbers[j] })
	for _, number := range numbers {
		a := merged[number]
		relays := make([]string, 0, len(a.relays))
		for oid := range a.relays {
			relays = append(relays, string(oid))
		}
		sort.Strings(relays)
		sort.Slice(a.controllers, func(i, j int) bool { return a.controllers[i] < a.controllers[j] })
		warning := strings.Join(a.unsupported, "; ")
		if a.conflict {
			warning = strings.Trim(strings.Join([]string{warning, "credential dates or PIN conflict between controllers"}, "; "), "; ")
		}
		supported := !a.conflict && len(a.unsupported) == 0
		resolvable := a.conflict && len(a.unsupported) == 0
		if supported {
			preview.Supported++
		} else if resolvable {
			preview.Resolvable++
		} else {
			preview.Skipped++
		}
		preview.Credentials = append(preview.Credentials, ControllerImportCredential{
			CardNumber: number, PIN: uint32(a.card.PIN), From: fmt.Sprint(a.card.From), To: fmt.Sprint(a.card.To),
			Relays: relays, Controllers: a.controllers, Supported: supported, Resolvable: resolvable,
			LocalMatch: localCards[number], Warning: warning,
		})
	}
	if preview.Skipped > 0 {
		preview.Warnings = append(preview.Warnings, "Timed, first-card, or unmapped credentials are shown but cannot be imported safely.")
	}
	if preview.Resolvable > 0 {
		preview.Warnings = append(preview.Warnings, "Credentials that differ between controllers require you to select the controller whose dates and PIN should be used.")
	}
	return preview, nil
}

func ApplyControllerImport(uid, role string, resolutions map[uint32]ControllerImportResolution) (map[string]any, error) {
	preview, err := ReadControllerImport()
	if err != nil {
		return nil, err
	}
	safety, err := CreateBackup("automatic safety backup before controller import")
	if err != nil {
		return nil, fmt.Errorf("could not create safety backup: %w", err)
	}

	sys.Lock()
	defer sys.Unlock()
	a := auth.NewAuthorizator(uid, role)
	dbc := db.NewDBC(sys.trail)
	groupShadow := sys.groups.Clone()
	cardShadow := sys.cards.Clone()
	imports := []cards.ControllerImport{}
	processed := 0
	for _, credential := range preview.Credentials {
		resolution := resolutions[credential.CardNumber]
		if !credential.Supported && !credential.Resolvable {
			continue
		}
		if resolution.Mode == "skip" {
			continue
		}
		selectedController := uint32(0)
		if credential.Resolvable {
			selectedController = resolution.Controller
			if !containsController(credential.Controllers, selectedController) {
				continue
			}
		}
		relays := make([]schema.OID, 0, len(credential.Relays))
		for _, relay := range credential.Relays {
			relays = append(relays, schema.OID(relay))
		}
		group, err := groupShadow.EnsureImported(a, "Imported controller access", relays, dbc)
		if err != nil {
			return nil, err
		}
		card := findACLCard(preview.raw, credential.CardNumber, selectedController)
		imports = append(imports, cards.ControllerImport{
			CardNumber: credential.CardNumber, PIN: uint32(card.PIN), From: card.From, To: card.To, Group: group,
			PreserveDetails: credential.LocalMatch && resolution.Mode != "override",
		})
		processed++
	}
	added, updated, err := cardShadow.MergeControllerImports(a, imports, dbc, sys.withPIN)
	if err != nil {
		return nil, err
	}
	if err := groupShadow.Validate(); err != nil {
		return nil, err
	}
	if err := save(TagGroups, &groupShadow); err != nil {
		return nil, err
	}
	if err := save(TagCards, &cardShadow); err != nil {
		return nil, err
	}
	dbc.Commit(&sys, func() {
		sys.groups = groupShadow
		sys.cards = cardShadow
	})
	if err := exportCredentialsCSVLocked(); err != nil {
		warnf("credentials", "could not update credentials CSV: %v", err)
	}
	return map[string]any{"ok": true, "added": added, "updated": updated, "skipped": len(preview.Credentials) - processed, "safetyBackup": safety}, nil
}

func findACLCard(current acl.ACL, number uint32, controller uint32) lib.Card {
	if controller != 0 {
		if card, ok := current[controller][number]; ok {
			return card
		}
	}
	controllers := make([]uint32, 0, len(current))
	for id := range current {
		controllers = append(controllers, id)
	}
	sort.Slice(controllers, func(i, j int) bool { return controllers[i] < controllers[j] })
	for _, id := range controllers {
		list := current[id]
		if card, ok := list[number]; ok {
			return card
		}
	}
	return lib.Card{}
}

func containsController(controllers []uint32, controller uint32) bool {
	for _, id := range controllers {
		if id == controller {
			return true
		}
	}
	return false
}
	
