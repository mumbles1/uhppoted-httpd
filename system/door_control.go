package system

import (
	"fmt"
	"strconv"
	"strings"

	lib "codeberg.org/uhppoted/uhppoted-core/types"
	"codeberg.org/uhppoted/uhppoted-httpd/auth"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/system/doors"
	"codeberg.org/uhppoted/uhppoted-httpd/types"
)

// ControlControllerDoor applies a door control mode to a physical controller
// channel. It is used for discovered controllers that have not yet had logical
// door records assigned to their channels.
func ControlControllerDoor(controllerID string, door uint8, requestedMode string) error {
	id, err := strconv.ParseUint(strings.TrimSpace(controllerID), 10, 32)
	if err != nil || id == 0 {
		return fmt.Errorf("invalid controller ID %q", controllerID)
	}

	if door < 1 || door > 4 {
		return fmt.Errorf("invalid controller door %d", door)
	}

	mode, err := parseControlMode(requestedMode)
	if err != nil {
		return err
	}

	var controller types.IController

	sys.RLock()
	for _, c := range sys.controllers.AsIControllers() {
		if c.ID() == uint32(id) {
			controller = c
			break
		}
	}
	sys.RUnlock()

	if controller == nil {
		return fmt.Errorf("controller %q not found", controllerID)
	}

	return sys.interfaces.SetDoorControl(controller, door, mode)
}

// ControlDoor applies a door control mode synchronously. A nil error means the
// controller exchange completed, rather than merely being queued in the UI.
func ControlDoor(uid, role, doorID, requestedMode string) error {
	oid := schema.OID(strings.TrimSpace(doorID))
	mode, err := parseControlMode(requestedMode)
	if err != nil {
		return err
	}

	var controller types.IController
	var controllerDoor uint8

	sys.RLock()
	door, ok := sys.doors.Door(oid)
	if !ok || door.IsDeleted() {
		sys.RUnlock()
		return fmt.Errorf("door %q not found", doorID)
	}

	authorizer := auth.NewAuthorizator(uid, role)
	if err := doors.CanUpdate(authorizer, &door, "mode", requestedMode); err != nil {
		sys.RUnlock()
		return err
	}

	for _, c := range sys.controllers.AsIControllers() {
		for _, n := range []uint8{1, 2, 3, 4} {
			if mapped, exists := c.Door(n); exists && mapped == oid {
				controller = c
				controllerDoor = n
				break
			}
		}
		if controller != nil {
			break
		}
	}
	sys.RUnlock()

	if controller == nil {
		return fmt.Errorf("door %q is not assigned to a controller", doorID)
	}

	return sys.interfaces.SetDoorControl(controller, controllerDoor, mode)
}

func parseControlMode(value string) (lib.ControlState, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "controlled":
		return lib.Controlled, nil
	case "normally open":
		return lib.NormallyOpen, nil
	case "normally closed":
		return lib.NormallyClosed, nil
	default:
		return lib.ModeUnknown, fmt.Errorf("invalid door control mode %q", value)
	}
}
