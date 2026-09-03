package groups

import (
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"strconv"
	"strings"
	"time"

	core "codeberg.org/uhppoted/uhppoted-core/types"

	"codeberg.org/uhppoted/uhppoted-httpd/auth"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/system/db"
	"codeberg.org/uhppoted/uhppoted-httpd/types"
)

type Group struct {
	catalog.CatalogGroup
	Name      string              `json:"name"`
	Doors     map[schema.OID]bool `json:"doors"`
	FirstCard bool                `json:"firstcard"`
	Schedule  Schedule            `json:"schedule"`

	created  types.Timestamp
	modified types.Timestamp
	deleted  types.Timestamp
}

type Schedule struct {
	Enabled  bool            `json:"enabled"`
	Start    string          `json:"start"`
	End      string          `json:"end"`
	Weekdays map[string]bool `json:"weekdays"`
}

type kv = struct {
	field schema.Suffix
	value any
}

const BLANK = "'blank'"

var created = types.TimestampNow()

func (g Group) String() string {
	return fmt.Sprintf("%v", g.Name)
}

func (g Group) IsValid() bool {
	return g.validate() == nil
}

func (g Group) validate() error {
	if strings.TrimSpace(g.Name) == "" {
		return fmt.Errorf("Group name is blank")
	}

	if g.Schedule.Enabled {
		start, err := core.ParseHHmm(g.Schedule.Start)
		if err != nil || start == nil {
			return fmt.Errorf("%v: invalid access start time (%v)", g.Name, g.Schedule.Start)
		}
		end, err := core.ParseHHmm(g.Schedule.End)
		if err != nil || end == nil {
			return fmt.Errorf("%v: invalid access end time (%v)", g.Name, g.Schedule.End)
		}
		if !start.Before(*end) {
			return fmt.Errorf("%v: access end time must be after start time", g.Name)
		}
		active := false
		for _, day := range weekdayNames {
			active = active || g.Schedule.Weekdays[day]
		}
		if !active {
			return fmt.Errorf("%v: select at least one access weekday", g.Name)
		}
		if _, err := g.TimeProfileID(); err != nil {
			return err
		}
	}

	return nil
}

func (g Group) IsDeleted() bool {
	return !g.deleted.IsZero()
}

func (g *Group) AsObjects(a *auth.Authorizator) []schema.Object {
	list := []kv{}

	if g.IsDeleted() {
		list = append(list, kv{GroupDeleted, g.deleted})
	} else {
		name := g.Name

		list = append(list, kv{GroupStatus, g.Status()})
		list = append(list, kv{GroupCreated, g.created})
		list = append(list, kv{GroupDeleted, g.deleted})
		list = append(list, kv{GroupName, name})

		doors := catalog.GetDoors()
		re := regexp.MustCompile(`^(.*?)(\.[0-9]+)$`)

		for _, door := range doors {
			d := fmt.Sprintf("%v", door)

			if m := re.FindStringSubmatch(d); len(m) > 2 {
				did := m[2]
				allowed := g.Doors[door]

				list = append(list, kv{GroupDoors.Append(did), allowed})
				list = append(list, kv{GroupDoors.Append(did + ".1"), door})
			}
		}

		list = append(list, kv{GroupFirstCard, g.FirstCard})
		if g.Schedule.Enabled || g.Schedule.Start != "" || g.Schedule.End != "" || len(g.Schedule.Weekdays) > 0 {
			if encoded, err := json.Marshal(g.Schedule); err == nil {
				list = append(list, kv{GroupSchedule, string(encoded)})
			}
		}
	}

	return g.toObjects(list, a)
}

func (g Group) AsRuleEntity() (string, any) {
	entity := struct {
		Name      string
		Doors     map[string]bool
		FirstCard bool
	}{
		Name:      fmt.Sprintf("%v", g.Name),
		Doors:     map[string]bool{},
		FirstCard: g.FirstCard,
	}

	doors := catalog.GetDoors()
	for _, d := range doors {
		allowed := g.Doors[d]
		door := catalog.GetV(d, DoorName)

		if v := fmt.Sprintf("%v", door); v != "" {
			entity.Doors[v] = allowed
		}
	}

	return "group", &entity
}

func (g Group) CacheKey() string {
	return ""
}

func (g Group) Status() types.Status {
	if g.IsDeleted() {
		return types.StatusDeleted
	}

	return types.StatusOk
}

func (g *Group) set(a *auth.Authorizator, oid schema.OID, value string, dbc db.DBC) ([]schema.Object, error) {
	if g == nil {
		return []schema.Object{}, nil
	}

	if g.IsDeleted() {
		return g.toObjects([]kv{{GroupDeleted, g.deleted}}, a), fmt.Errorf("Group has been deleted")
	}

	uid := auth.UID(a)
	original := g.clone()
	list := []kv{}

	switch {
	case oid == g.OID.Append(GroupName):
		if err := CanUpdate(a, g, "name", value); err != nil {
			return nil, err
		} else {
			g.Name = value
			g.modified = types.TimestampNow()

			list = append(list, kv{GroupName, g.Name})

			g.log(dbc, uid, "update", "name", g.Name, value, "Updated name from %v to %v", original.Name, g.Name)
		}

	case schema.OID(g.OID.Append(GroupDoors)).Contains(oid):
		if m := regexp.MustCompile(`^(?:.*?)\.([0-9]+)$`).FindStringSubmatch(string(oid)); len(m) > 1 {
			did := m[1]
			k := schema.DoorsOID.AppendS(did)
			door := catalog.GetV(k, DoorName)

			if err := CanUpdate(a, g, door.(string), value); err != nil {
				return nil, err
			} else {
				if value == "true" {
					g.log(dbc, uid, "update", "door", "", "", "Granted access to %v", door)
				} else {
					g.log(dbc, uid, "update", "door", "", "", "Revoked access to %v", door)
				}

				g.Doors[k] = value == "true"
				g.modified = types.TimestampNow()

				list = append(list, kv{GroupDoors.Append(did), g.Doors[k]})
			}
		}

	case oid == g.OID.Append(GroupFirstCard):
		if err := CanUpdate(a, g, "firstcard", value); err != nil {
			return nil, err
		} else {
			if value == "true" {
				g.FirstCard = true
			} else {
				g.FirstCard = false
			}

			g.modified = types.TimestampNow()

			g.log(dbc, uid, "update", "firstcard", g.Name, value, "Updated firstcard from %v to %v", original.FirstCard, g.FirstCard)
			dbc.Updated(g.OID, GroupFirstCard, g.FirstCard)

			list = append(list, kv{GroupFirstCard, g.FirstCard})
		}

	case oid == g.OID.Append(GroupSchedule):
		var schedule Schedule
		if err := json.Unmarshal([]byte(value), &schedule); err != nil {
			return nil, fmt.Errorf("invalid access schedule: %w", err)
		}
		if schedule.Weekdays == nil {
			schedule.Weekdays = map[string]bool{}
		}
		clone := g.clone()
		clone.Schedule = schedule
		if err := clone.validate(); err != nil {
			return nil, err
		}
		if err := CanUpdate(a, g, "schedule", value); err != nil {
			return nil, err
		}
		g.Schedule = schedule
		g.modified = types.TimestampNow()
		g.log(dbc, uid, "update", "schedule", original.Schedule, schedule, "Updated controller time restriction")
		dbc.Updated(g.OID, GroupSchedule, value)
		list = append(list, kv{GroupSchedule, value})
	}

	dbc.Updated(g.OID, "", g.Doors)

	list = append(list, kv{GroupStatus, g.Status()})

	return g.toObjects(list, a), nil
}

func (g *Group) delete(a *auth.Authorizator, dbc db.DBC) ([]schema.Object, error) {
	list := []kv{}

	if g != nil {
		if err := CanDelete(a, g); err != nil {
			return nil, err
		}

		g.log(dbc, auth.UID(a), "delete", "group", g.Name, "", "Deleted group %v", g.Name)
		g.deleted = types.TimestampNow()
		g.modified = types.TimestampNow()

		list = append(list, kv{GroupStatus, g.Status()})
		list = append(list, kv{GroupDeleted, g.deleted})

		catalog.DeleteT(g.CatalogGroup, g.OID)
	}

	return g.toObjects(list, a), nil
}

func (g Group) toObjects(list []kv, a *auth.Authorizator) []schema.Object {
	objects := []schema.Object{}

	if err := CanView(a, g, "OID", g.OID); err == nil && !g.IsDeleted() {
		catalog.Join(&objects, catalog.NewObject(g.OID, ""))
	}

	for _, v := range list {
		field := lookup[v.field]
		if err := CanView(a, g, field, v.value); err == nil {
			catalog.Join(&objects, catalog.NewObject2(g.OID, v.field, v.value))
		}
	}

	return objects
}

func (g Group) serialize() ([]byte, error) {
	record := struct {
		OID       schema.OID      `json:"OID"`
		Name      string          `json:"name,omitempty"`
		Doors     []schema.OID    `json:"doors"`
		FirstCard bool            `json:"firstcard"`
		Schedule  Schedule        `json:"schedule,omitempty"`
		Created   types.Timestamp `json:"created"`
		Modified  types.Timestamp `json:"modified"`
	}{
		OID:       g.OID,
		Name:      g.Name,
		Doors:     []schema.OID{},
		FirstCard: g.FirstCard,
		Schedule:  g.Schedule,
		Created:   g.created.UTC(),
		Modified:  g.modified.UTC(),
	}

	doors := catalog.GetDoors()

	for _, d := range doors {
		if g.Doors[d] {
			record.Doors = append(record.Doors, d)
		}
	}

	return json.Marshal(record)
}

func (g *Group) deserialize(bytes []byte) error {
	created = created.Add(1 * time.Minute)

	record := struct {
		OID       string          `json:"OID"`
		Name      string          `json:"name,omitempty"`
		Doors     []schema.OID    `json:"doors"`
		FirstCard bool            `json:"firstcard"`
		Schedule  Schedule        `json:"schedule,omitempty"`
		Created   types.Timestamp `json:"created"`
		Modified  types.Timestamp `json:"modified"`
	}{
		Created: created,
	}

	if err := json.Unmarshal(bytes, &record); err != nil {
		return err
	}

	g.OID = schema.OID(record.OID)
	g.Name = record.Name
	g.Doors = map[schema.OID]bool{}
	g.FirstCard = record.FirstCard
	g.Schedule = record.Schedule
	g.created = record.Created
	g.modified = record.Modified

	for _, d := range record.Doors {
		g.Doors[schema.OID(d)] = true
	}

	return nil
}

func (g Group) clone() Group {
	group := Group{
		CatalogGroup: catalog.CatalogGroup{
			OID: g.OID,
		},
		Name:      g.Name,
		Doors:     map[schema.OID]bool{},
		FirstCard: g.FirstCard,
		Schedule:  g.Schedule,
		created:   g.created,
		modified:  g.modified,
		deleted:   g.deleted,
	}

	maps.Copy(group.Doors, g.Doors)
	if g.Schedule.Weekdays != nil {
		group.Schedule.Weekdays = map[string]bool{}
		maps.Copy(group.Schedule.Weekdays, g.Schedule.Weekdays)
	}

	return group
}

var weekdayNames = []string{"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}

func (g Group) TimeProfileID() (uint8, error) {
	m := regexp.MustCompile(`\.([0-9]+)$`).FindStringSubmatch(string(g.OID))
	if len(m) != 2 {
		return 0, fmt.Errorf("%v: invalid access level OID (%v)", g.Name, g.OID)
	}
	n, err := strconv.ParseUint(m[1], 10, 8)
	if err != nil || n < 1 || n > 253 {
		return 0, fmt.Errorf("%v: no controller time-profile slot is available", g.Name)
	}
	return uint8(255 - n), nil
}

func (g Group) AccessProfile() (uint8, error) {
	if !g.Schedule.Enabled {
		return 1, nil
	}
	return g.TimeProfileID()
}

func (g Group) TimeProfile() (*core.TimeProfile, error) {
	if !g.Schedule.Enabled {
		return nil, nil
	}
	id, err := g.TimeProfileID()
	if err != nil {
		return nil, err
	}
	start, err := core.ParseHHmm(g.Schedule.Start)
	if err != nil || start == nil {
		return nil, fmt.Errorf("%v: invalid access start time", g.Name)
	}
	end, err := core.ParseHHmm(g.Schedule.End)
	if err != nil || end == nil {
		return nil, fmt.Errorf("%v: invalid access end time", g.Name)
	}
	days := core.Weekdays{}
	for i, day := range weekdayNames {
		days[time.Weekday((i+1)%7)] = g.Schedule.Weekdays[day]
	}
	return &core.TimeProfile{
		ID:       id,
		From:     core.MustParseDate("2020-01-01"),
		To:       core.MustParseDate("2099-12-31"),
		Weekdays: days,
		Segments: core.Segments{
			1: {Start: *start, End: *end},
			2: {Start: core.MustParseHHmm("00:00"), End: core.MustParseHHmm("00:00")},
			3: {Start: core.MustParseHHmm("00:00"), End: core.MustParseHHmm("00:00")},
		},
	}, nil
}

func (g *Group) log(dbc db.DBC, uid, op string, field string, before, after any, format string, fields ...any) {
	dbc.Log(uid, op, g.OID, "group", "", g.Name, field, before, after, format, fields...)
}
