package doors

import (
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
)

const DoorStatus = schema.Status
const DoorCreated = schema.Created
const DoorDeleted = schema.Deleted

const DoorName = schema.DoorName
const DoorDelay = schema.DoorDelay
const DoorDelayStatus = schema.DoorDelayStatus
const DoorDelayConfigured = schema.DoorDelayConfigured
const DoorDelayError = schema.DoorDelayError
const DoorDelayModified = schema.DoorDelayModified
const DoorControl = schema.DoorControl
const DoorControlStatus = schema.DoorControlStatus
const DoorControlConfigured = schema.DoorControlConfigured
const DoorControlError = schema.DoorControlError
const DoorControlModified = schema.DoorControlModified
const DoorKeypad = schema.DoorKeypad
const DoorPasscodes = schema.DoorPasscodes
const DoorReaderEntry = schema.DoorReaderEntry
const DoorReaderExit = schema.DoorReaderExit

const DoorFirstCardStartTime = schema.DoorFirstCardStartTime
const DoorFirstCardEndTime = schema.DoorFirstCardEndTime
const DoorFirstCardActiveMode = schema.DoorFirstCardActiveMode
const DoorFirstCardInactiveMode = schema.DoorFirstCardInactiveMode
const DoorFirstCardMonday = schema.DoorFirstCardMonday
const DoorFirstCardTuesday = schema.DoorFirstCardTuesday
const DoorFirstCardWednesday = schema.DoorFirstCardWednesday
const DoorFirstCardThursday = schema.DoorFirstCardThursday
const DoorFirstCardFriday = schema.DoorFirstCardFriday
const DoorFirstCardSaturday = schema.DoorFirstCardSaturday
const DoorFirstCardSunday = schema.DoorFirstCardSunday

var lookup = map[schema.Suffix]string{
	DoorStatus:            "door.status",
	DoorCreated:           "door.created",
	DoorDeleted:           "door.deleted",
	DoorName:              "door.name",
	DoorDelay:             "door.delay",
	DoorDelayStatus:       "door.delay.status",
	DoorDelayConfigured:   "door.delay.configured",
	DoorDelayError:        "door.delay.error",
	DoorDelayModified:     "door.delay.modified",
	DoorControl:           "door.control",
	DoorControlStatus:     "door.control.status",
	DoorControlConfigured: "door.control.configured",
	DoorControlError:      "door.control.error",
	DoorControlModified:   "door.control.modified",
	DoorKeypad:            "door.keypad",
	DoorPasscodes:         "door.passcodes",
	DoorReaderEntry:       "door.readers.entry",
	DoorReaderExit:        "door.readers.exit",

	DoorFirstCardStartTime:    "door.firstcard.start-time",
	DoorFirstCardEndTime:      "door.firstcard.end-time",
	DoorFirstCardActiveMode:   "door.firstcard.active-mode",
	DoorFirstCardInactiveMode: "door.firstcard.inactive-mode",
	DoorFirstCardMonday:       "door.firstcard.weekdays.monday",
	DoorFirstCardTuesday:      "door.firstcard.weekdays.tuesday",
	DoorFirstCardWednesday:    "door.firstcard.weekdays.wednesday",
	DoorFirstCardThursday:     "door.firstcard.weekdays.thursday",
	DoorFirstCardFriday:       "door.firstcard.weekdays.friday",
	DoorFirstCardSaturday:     "door.firstcard.weekdays.saturday",
	DoorFirstCardSunday:       "door.firstcard.weekdays.sunday",
}
