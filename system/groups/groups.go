package groups

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"codeberg.org/uhppoted/uhppoted-httpd/auth"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/system/db"
	"codeberg.org/uhppoted/uhppoted-httpd/types"
)

type Groups struct {
	groups map[schema.OID]Group
}

var guard sync.RWMutex

func NewGroups() Groups {
	return Groups{
		groups: map[schema.OID]Group{},
	}
}

func (gg Groups) Doors(groups ...schema.OID) []schema.OID {
	doors := []schema.OID{}

	for _, oid := range groups {
		if g, ok := gg.groups[oid]; ok {
			for k, v := range g.Doors {
				if v {
					doors = append(doors, k)
				}
			}
		}
	}

	return doors
}

func (gg *Groups) AsObjects(a *auth.Authorizator) []schema.Object {
	guard.RLock()
	defer guard.RUnlock()

	objects := []schema.Object{}

	for _, g := range gg.groups {
		if g.IsValid() || g.IsDeleted() {
			catalog.Join(&objects, g.AsObjects(a)...)
		}
	}

	return objects
}

func (gg *Groups) Create(a *auth.Authorizator, oid schema.OID, value string, dbc db.DBC) ([]schema.Object, error) {
	objects := []schema.Object{}

	if gg != nil {
		if g, err := gg.add(a, Group{}); err != nil {
			return nil, err
		} else if g == nil {
			return nil, fmt.Errorf("failed to add 'new' group")
		} else {
			g.log(dbc, auth.UID(a), "add", "group", "", "", "Added 'new' group")

			catalog.Join(&objects, catalog.NewObject(g.OID, "new"))
			catalog.Join(&objects, catalog.NewObject2(g.OID, GroupCreated, g.created))
		}
	}

	return objects, nil
}

func (gg *Groups) Update(a *auth.Authorizator, oid schema.OID, value string, dbc db.DBC) ([]schema.Object, error) {
	objects := []schema.Object{}

	if gg != nil {
		for k, g := range gg.groups {
			if g.OID.Contains(oid) {
				objects, err := g.set(a, oid, value, dbc)
				if err == nil {
					gg.groups[k] = g
				}

				return objects, err
			}
		}
	}

	return objects, nil
}

func (gg *Groups) Delete(auth *auth.Authorizator, oid schema.OID, dbc db.DBC) ([]schema.Object, error) {
	if gg != nil {
		for k, g := range gg.groups {
			if g.OID == oid {
				if g.IsBuiltin() {
					return nil, fmt.Errorf("access level %v is permanent and cannot be deleted", g.Name)
				}
				objects, err := g.delete(auth, dbc)
				if err == nil {
					gg.groups[k] = g
				}

				return objects, err
			}
		}
	}

	return []schema.Object{}, nil
}

// EnsureDefaults installs and repairs the two controller-native permanent
// access levels. Reserved OIDs keep them independent of user-created levels.
func (gg *Groups) EnsureDefaults() {
	if gg == nil {
		return
	}

	now := types.TimestampNow()
	noAccess := Group{
		CatalogGroup: catalog.CatalogGroup{OID: NoAccessOID},
		Name:         "0 - No Access",
		Doors:        map[schema.OID]bool{},
		Schedule:     Schedule{Weekdays: map[string]bool{}},
		created:      now,
	}
	always := Group{
		CatalogGroup: catalog.CatalogGroup{OID: AlwaysAccessOID},
		Name:         "1 - 24/7 Access",
		Doors:        map[schema.OID]bool{},
		Schedule:     Schedule{Weekdays: map[string]bool{}},
		created:      now,
	}
	for _, oid := range catalog.GetDoors() {
		always.Doors[oid] = true
	}
	if existing, ok := gg.groups[NoAccessOID]; ok && !existing.created.IsZero() {
		noAccess.created = existing.created
	}
	if existing, ok := gg.groups[AlwaysAccessOID]; ok && !existing.created.IsZero() {
		always.created = existing.created
	}
	gg.groups[NoAccessOID] = noAccess
	gg.groups[AlwaysAccessOID] = always
	for _, group := range []Group{noAccess, always} {
		catalog.PutT(group.CatalogGroup)
		catalog.PutV(group.OID, GroupName, group.Name)
		catalog.PutV(group.OID, GroupCreated, group.created)
	}
}

func (gg *Groups) Load(blob json.RawMessage) error {
	rs := []json.RawMessage{}
	if err := json.Unmarshal(blob, &rs); err != nil {
		return err
	}

	for _, v := range rs {
		var g Group
		if err := g.deserialize(v); err == nil {
			if _, ok := gg.groups[g.OID]; ok {
				return fmt.Errorf("group '%v': duplicate OID (%v)", g.Name, g.OID)
			}

			gg.groups[g.OID] = g
		}
	}

	for _, g := range gg.groups {
		catalog.PutT(g.CatalogGroup)
		catalog.PutV(g.OID, GroupName, g.Name)
		catalog.PutV(g.OID, GroupCreated, g.created)
	}

	return nil
}

func (gg Groups) Save() (json.RawMessage, error) {
	if err := gg.Validate(); err != nil {
		return nil, err
	}

	serializable := []json.RawMessage{}

	for _, g := range gg.groups {
		if g.IsValid() && !g.IsDeleted() {
			if record, err := g.serialize(); err == nil && record != nil {
				serializable = append(serializable, record)
			}
		}
	}

	return json.MarshalIndent(serializable, "", "  ")
}

func (gg *Groups) Group(oid schema.OID) (Group, bool) {
	g, ok := gg.groups[oid]

	return g, ok
}

func (gg *Groups) List() []Group {
	guard.RLock()
	defer guard.RUnlock()

	list := []Group{}
	for _, group := range gg.groups {
		if !group.IsDeleted() {
			list = append(list, group.clone())
		}
	}
	return list
}

// EnsureImported returns an unrestricted access level for the exact relay set,
// creating one when necessary. It operates on a shadow copy owned by the caller.
func (gg *Groups) EnsureImported(a *auth.Authorizator, name string, relayOIDs []schema.OID, dbc db.DBC) (schema.OID, error) {
	wanted := map[schema.OID]bool{}
	for _, oid := range relayOIDs {
		wanted[oid] = true
	}
	for _, existing := range gg.groups {
		if existing.IsDeleted() || existing.OID == NoAccessOID || existing.Schedule.Enabled || existing.FirstCard || len(existing.AccessDoors()) != len(wanted) {
			continue
		}
		match := true
		for oid := range wanted {
			if !existing.AccessDoors()[oid] {
				match = false
				break
			}
		}
		if match {
			return existing.OID, nil
		}
	}

	base := strings.TrimSpace(name)
	if base == "" {
		base = "Imported controller access"
	}
	candidate := base
	for suffix := 2; ; suffix++ {
		duplicate := false
		for _, existing := range gg.groups {
			if !existing.IsDeleted() && strings.EqualFold(strings.TrimSpace(existing.Name), candidate) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			break
		}
		candidate = fmt.Sprintf("%s %d", base, suffix)
	}

	group, err := gg.add(a, Group{Name: candidate, Doors: wanted, Schedule: Schedule{Weekdays: map[string]bool{}}})
	if err != nil {
		return "", err
	}
	group.log(dbc, auth.UID(a), "import", "group", "", candidate, "Imported controller access level %v", candidate)
	return group.OID, nil
}

func (gg Groups) Print() {
	serializable := []json.RawMessage{}
	for _, g := range gg.groups {
		if g.IsValid() && !g.IsDeleted() {
			if record, err := g.serialize(); err == nil && record != nil {
				serializable = append(serializable, record)
			}
		}
	}

	if b, err := json.MarshalIndent(serializable, "", "  "); err == nil {
		fmt.Printf("----------------- GROUPS\n%s\n", string(b))
	}
}

// NTS: 'added' is specifically not cloned - it has a lifetime for the duration of
//
//	the 'shadow' copy only
//
// NTS: 'added' is specifically not cloned - it has a lifetime for the duration of
//
//	the 'shadow' copy only
func (gg *Groups) Clone() Groups {
	guard.RLock()
	defer guard.RUnlock()

	shadow := Groups{
		groups: map[schema.OID]Group{},
	}

	for k, v := range gg.groups {
		shadow.groups[k] = v.clone()
	}

	return shadow
}

func (gg Groups) Validate() error {
	names := map[string]string{}

	for k, g := range gg.groups {
		if g.IsDeleted() {
			continue
		}

		if g.OID == "" {
			return fmt.Errorf("invalid group OID (%v)", g.OID)
		} else if k != g.OID {
			return fmt.Errorf("group %s: mismatched group OID %v (expected %v)", g.Name, g.OID, k)
		}

		if err := g.validate(); err != nil {
			if !g.modified.IsZero() {
				return err
			}
		}

		n := strings.TrimSpace(strings.ToLower(g.Name))
		if v, ok := names[n]; ok && n != "" {
			return fmt.Errorf("'%v': duplicate group name (%v)", g.Name, v)
		}

		names[n] = g.Name
	}

	return nil
}

func (gg *Groups) Sweep(retention time.Duration) {
	if gg != nil {
		cutoff := time.Now().Add(-retention)
		for i, v := range gg.groups {
			if v.IsDeleted() && v.deleted.Before(cutoff) {
				delete(gg.groups, i)
			}
		}
	}
}

func (gg *Groups) add(a auth.OpAuth, g Group) (*Group, error) {
	oid := catalog.NewT(g.CatalogGroup)
	if _, ok := gg.groups[oid]; ok {
		return nil, fmt.Errorf("catalog returned duplicate OID (%v)", oid)
	}

	group := g.clone()
	group.OID = oid
	group.created = types.TimestampNow()

	if err := CanAdd(a, &group); err != nil {
		return nil, err
	}

	gg.groups[group.OID] = group

	return &group, nil
}
	
