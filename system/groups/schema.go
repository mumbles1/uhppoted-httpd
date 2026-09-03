package groups

import (
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
)

const GroupStatus = schema.Status
const GroupCreated = schema.Created
const GroupDeleted = schema.Deleted
const GroupModified = schema.Modified
const GroupName = schema.GroupName
const GroupDoors = schema.GroupDoors
const GroupFirstCard = schema.GroupFirstCard
const GroupSchedule = schema.GroupSchedule

const DoorName = schema.DoorName

var lookup = map[schema.Suffix]string{
	GroupStatus:    "group.status",
	GroupCreated:   "group.created",
	GroupDeleted:   "group.deleted",
	GroupModified:  "group.modified",
	GroupName:      "group.name",
	GroupDoors:     "group.doors",
	GroupFirstCard: "group.firstcard",
	GroupSchedule:  "group.schedule",
}
