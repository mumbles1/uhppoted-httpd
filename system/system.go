package system

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/hyperjumptech/grule-rule-engine/ast"
	"github.com/hyperjumptech/grule-rule-engine/builder"
	"github.com/hyperjumptech/grule-rule-engine/pkg"

	lib "codeberg.org/uhppoted/uhppoted-core/types"
	"codeberg.org/uhppoted/uhppoted-lib/config"
	libos "codeberg.org/uhppoted/uhppoted-lib/os"

	"codeberg.org/uhppoted/uhppoted-httpd/audit"
	"codeberg.org/uhppoted/uhppoted-httpd/log"
	"codeberg.org/uhppoted/uhppoted-httpd/system/cards"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/impl"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/system/controllers"
	"codeberg.org/uhppoted/uhppoted-httpd/system/doors"
	"codeberg.org/uhppoted/uhppoted-httpd/system/events"
	"codeberg.org/uhppoted/uhppoted-httpd/system/groups"
	"codeberg.org/uhppoted/uhppoted-httpd/system/grule"
	"codeberg.org/uhppoted/uhppoted-httpd/system/history"
	"codeberg.org/uhppoted/uhppoted-httpd/system/interfaces"
	"codeberg.org/uhppoted/uhppoted-httpd/system/logs"
	"codeberg.org/uhppoted/uhppoted-httpd/system/users"
	"codeberg.org/uhppoted/uhppoted-httpd/types"
)

type Tag string

const (
	TagInterfaces  Tag = "interfaces"
	TagControllers Tag = "controllers"
	TagDoors       Tag = "doors"
	TagCards       Tag = "cards"
	TagGroups      Tag = "groups"
	TagEvents      Tag = "events"
	TagLogs        Tag = "logs"
	TagUsers       Tag = "users"
	TagHistory     Tag = "history"
)

var channels = struct {
	events chan types.EventsList
}{
	events: make(chan types.EventsList),
}

var sys = system{
	interfaces:  interfaces.NewInterfaces(channels.events),
	controllers: controllers.NewControllers(),
	doors:       doors.NewDoors(),
	cards:       cards.NewCards(),
	groups:      groups.NewGroups(),
	events:      events.NewEvents(),
	logs:        logs.NewLogs(),
	users:       users.NewUsers(),
	history:     history.NewHistory(),

	mode:          types.Normal,
	withPIN:       false,
	withFirstCard: false,
	taskQ:         NewTaskQ(),
	retention:     6 * time.Hour,

	acl: struct {
		defaultStartDate lib.Date
		defaultEndDate   lib.Date
	}{},
}

type system struct {
	sync.RWMutex
	conf string

	interfaces  interfaces.Interfaces
	controllers controllers.Controllers
	doors       doors.Doors
	cards       cards.Cards
	groups      groups.Groups
	events      events.Events
	logs        logs.Logs
	users       users.Users
	history     history.History

	files         map[Tag]string
	rules         grule.Rules
	taskQ         TaskQ
	retention     time.Duration // time after which 'deleted' items are permanently removed
	trail         trail
	mode          types.RunMode
	withPIN       bool
	withFirstCard bool
	debug         bool

	acl struct {
		defaultStartDate lib.Date
		defaultEndDate   lib.Date
	}

	pending sync.Map
}

type trail struct {
	trail audit.AuditTrail
}

func (t trail) Write(records ...audit.AuditRecord) {
	t.trail.Write(records...)
	sys.logs.Received(records...)
	sys.history.Received(records...)

	if err := save(TagLogs, &sys.logs); err != nil {
		warnf("system", "%v", err)
	}

	if err := save(TagHistory, &sys.history); err != nil {
		warnf("system", "%v", err)
	}
}

type object struct {
	OID   schema.OID `json:"OID"`
	Value string     `json:"value"`
}

type serializable interface {
	Load(blob json.RawMessage) error
	Save() (json.RawMessage, error)
	Print()
}

func Init(cfg config.Config, conf string, mode types.RunMode, debug bool) error {
	catalog.Init(memdb.NewCatalog())

	sys.mode = mode
	sys.withPIN = cfg.HTTPD.PIN.Enabled
	sys.withFirstCard = cfg.HTTPD.FirstCard.Enabled

	sys.files = map[Tag]string{
		TagInterfaces:  cfg.HTTPD.System.Interfaces,
		TagControllers: cfg.HTTPD.System.Controllers,
		TagDoors:       cfg.HTTPD.System.Doors,
		TagCards:       cfg.HTTPD.System.Cards,
		TagGroups:      cfg.HTTPD.System.Groups,
		TagEvents:      cfg.HTTPD.System.Events,
		TagLogs:        cfg.HTTPD.System.Logs,
		TagUsers:       cfg.HTTPD.System.Users,
		TagHistory:     cfg.HTTPD.System.History,
	}

	list := subsystems()
	for _, v := range list {
		if err := load(v.tag, v.serializable); err != nil {
			log.Errorf("Unable to load %v from %v (%v)", v.tag, sys.files[v.tag], err)
			return err
		}
	}

	kb := ast.NewKnowledgeLibrary()
	if err := builder.NewRuleBuilder(kb).BuildRuleFromResource("acl", "0.0.0", pkg.NewFileResource(cfg.HTTPD.DB.Rules.ACL)); err != nil {
		log.Fatalf("Error loading ACL ruleset (%v)", err)
	}

	rules, err := grule.NewGrule(kb)
	if err != nil {
		log.Fatalf("Error initialising ACL ruleset (%v)", err)
	}

	sys.debug = debug
	sys.conf = conf
	sys.rules = rules
	sys.retention = cfg.HTTPD.Retention
	sys.trail = trail{
		trail: audit.MakeTrail(),
	}

	controllers.SetWindows(cfg.HTTPD.System.Windows.Ok,
		cfg.HTTPD.System.Windows.Uncertain,
		cfg.HTTPD.System.Windows.Systime,
		cfg.HTTPD.System.Windows.CacheExpiry)

	go func() {
		time.Sleep(2500 * time.Millisecond)
		sys.refresh()

		c := time.Tick(cfg.HTTPD.System.Refresh)
		for range c {
			sys.refresh()
		}
	}()

	go func(ch <-chan types.EventsList) {
		for v := range ch {
			AppendEvents(v)
		}
	}(channels.events)

	return nil
}

func (s *system) refresh() {
	if s == nil {
		return
	}

	f := func(controllers []types.IController) []uint32 {
		list := []uint32{}
		for _, c := range controllers {
			list = append(list, c.ID())
		}

		return list
	}

	controllers := s.controllers.AsIControllers()
	missing := s.events.Missing(2, f(controllers)...) // Fix at most 2 gaps in each controller's event list

	sys.taskQ.Add(Task{
		f: func() {
			found := s.interfaces.Search(controllers)
			s.controllers.Found(found)
		},
	})

	sys.taskQ.Add(Task{
		f: func() {
			s.interfaces.Refresh(controllers)
		},
	})

	sys.taskQ.Add(Task{
		f: func() {
			s.interfaces.GetEvents(controllers, missing)
		},
	})

	sys.taskQ.Add(Task{
		f: s.sweep,
	})

	sys.taskQ.Add(Task{
		f: func() {
			s.compareACL()
		},
	})

	if sys.mode == types.Synchronize {
		sys.taskQ.Add(Task{
			f: func() {
				s.synchronize()
			},
		})
	}
}

// Refresh performs an immediate controller discovery, status, event and ACL
// refresh. The interactive API must not return before the controller work has
// actually run: queuing it made the Refresh button consistently display stale
// data and allowed a later, unrelated task to mask failures.
func Refresh() {
	controllers := sys.controllers.AsIControllers()
	found := sys.interfaces.Search(controllers)
	sys.controllers.Found(found)

	controllers = sys.controllers.AsIControllers()
	sys.interfaces.Refresh(controllers)

	ids := make([]uint32, 0, len(controllers))
	for _, controller := range controllers {
		ids = append(ids, controller.ID())
	}

	missing := sys.events.Missing(2, ids...)
	sys.interfaces.GetEvents(controllers, missing)

	// Event delivery uses an unbuffered interface channel. Yield briefly after
	// the hand-off so the consumer can commit the received batch before the API
	// snapshot is reloaded.
	time.Sleep(50 * time.Millisecond)
	sys.sweep()
	sys.compareACL()
}

func (s *system) synchronize() {
	infof("system", "checking system synchronization")
	controllers := sys.controllers.AsIControllers()

	unsynchronized := struct {
		datetime bool
		doors    bool
		ACL      bool
	}{}

	for _, c := range controllers {
		if !c.DateTimeOk() {
			warnf("system", "Controller %v date/time out of synch", c.ID())
			unsynchronized.datetime = true
		}

		for _, d := range []uint8{1, 2, 3, 4} {
			if oid, ok := c.Door(d); ok {
				if door, ok := sys.doors.Door(oid); ok {
					if !door.IsOk() {
						warnf("system", "Door '%v' out of synch", door)
						unsynchronized.doors = true
					}
				}
			}
		}
	}

	if acl, err := s.permissions(controllers); err != nil {
		warnf("system", "%v", err)
	} else if diff, err := s.interfaces.CompareACL(controllers, acl, s.withPIN); err != nil {
		warnf("system", "%v", err)
	} else if diff == nil {
		warnf("system", "Invalid ACL diff (%v)", diff)
	} else {
		count := 0
		for _, v := range diff {
			count += len(v.Updated)
			count += len(v.Added)
			count += len(v.Deleted)
		}

		if count > 0 {
			warnf("system", "ACL out of synch")
			unsynchronized.ACL = true
		}
	}

	if unsynchronized.datetime {
		warnf("system", "Resynchronizing all controller date/times")
		SynchronizeDateTime()
	}

	if unsynchronized.doors {
		warnf("system", "Resynchronizing mode and delay for all doors")
		SynchronizeDoors(s.withFirstCard)
	}

	if unsynchronized.ACL {
		warnf("system", "Resynchronizing ACL")
		SynchronizeACL()
	}
}

func SynchronizeACL() error {
	if err := sys.synchronizeACL(); err != nil {
		return err
	}

	sys.compareACL()

	return nil
}

func SynchronizeDateTime() error {
	return SynchronizeDateTimeAt(time.Now())
}

func SynchronizeDateTimeAt(now time.Time) error {
	controllers := sys.controllers.AsIControllers()
	if len(controllers) == 0 {
		return fmt.Errorf("no configured controllers")
	}
	var failures []error

	for _, c := range controllers {
		if err := sys.interfaces.SetTime(c, now); err != nil {
			failures = append(failures, fmt.Errorf("controller %v date/time: %w", c.ID(), err))
		}
	}

	return errors.Join(failures...)
}

func SynchronizeControllerDateTime(oid schema.OID, now time.Time) error {
	for _, controller := range sys.controllers.AsIControllers() {
		if controller.OID() == oid {
			return sys.interfaces.SetTime(controller, now)
		}
	}

	return fmt.Errorf("controller %v not found", oid)
}

func SynchronizeDoors(withFirstCard bool) error {
	controllers := sys.controllers.AsIControllers()
	if len(controllers) == 0 {
		return fmt.Errorf("no configured controllers")
	}
	var failures []error

	for _, controller := range controllers {
		if err := sys.interfaces.SetInterlock(controller, controller.Interlock()); err != nil {
			failures = append(failures, fmt.Errorf("controller %v interlock: %w", controller.ID(), err))
		}
		if err := sys.interfaces.SetAntiPassback(controller, controller.AntiPassback()); err != nil {
			failures = append(failures, fmt.Errorf("controller %v anti-passback: %w", controller.ID(), err))
		}
		for _, d := range []uint8{1, 2, 3, 4} {
			if oid, ok := controller.Door(d); ok {
				if door, ok := sys.doors.Door(oid); ok {
					if err := sys.interfaces.SetDoor(controller, d, door.Mode(), door.Delay()); err != nil {
						failures = append(failures, fmt.Errorf("controller %v door %v: %w", controller.ID(), d, err))
					}
					if withFirstCard && !door.FirstCard().IsZero() {
						warnf("system", "synchronizing first-card configuration for door %v", door)
						if err := sys.interfaces.SetFirstCard(controller, d, door.FirstCard()); err != nil {
							failures = append(failures, fmt.Errorf("controller %v door %v first-card: %w", controller.ID(), d, err))
						}
					}
				}
			}
		}
	}

	return errors.Join(failures...)
}

func (s *system) Update(oid schema.OID, field schema.Suffix, value any) {
	controllers := s.controllers.AsIControllers()

	switch {
	case oid.HasPrefix(schema.CardsOID):
		if card, ok := value.(uint32); ok && card != 0 {
			for _, c := range controllers {
				controller := c
				go func() {
					if err := s.updateCardPermissions(controller, card); err != nil {
						warnf("ACL", "controller %v credential %v: %v", controller.ID(), card, err)
					}
				}()
			}
		}

	case oid.HasPrefix(schema.GroupsOID):
		list := map[schema.OID]cards.Card{}
		for _, c := range s.cards.List() {
			card := c
			for _, g := range c.Groups() {
				if g == oid {
					list[c.OID] = card
				}
			}
		}

		for _, card := range list {
			cardID := card.CardID
			for _, c := range controllers {
				controller := c
				go func() {
					if err := s.updateCardPermissions(controller, cardID); err != nil {
						warnf("ACL", "controller %v credential %v: %v", controller.ID(), cardID, err)
					}
				}()
			}
		}

	case oid.HasPrefix(schema.ControllersOID) && field == schema.ControllerDateTime:
		for _, c := range controllers {
			if c.OID() == oid {
				controller := c
				go func() {
					s.interfaces.SetTime(controller, value.(time.Time))
				}()
				return
			}
		}

	case oid.HasPrefix(schema.ControllersOID) && field == schema.ControllerInterlock:
		for _, c := range controllers {
			if c.OID() == oid {
				controller := c
				go func() {
					if err := s.interfaces.SetInterlock(controller, value.(lib.Interlock)); err != nil {
						warnf("system", "controller %v interlock: %v", controller.ID(), err)
					}
				}()
				return
			}
		}

	case oid.HasPrefix(schema.ControllersOID) && field == schema.ControllerAntiPassback:
		for _, c := range controllers {
			if c.OID() == oid {
				controller := c
				go func() {
					if err := s.interfaces.SetAntiPassback(controller, value.(lib.AntiPassback)); err != nil {
						warnf("system", "controller %v anti-passback: %v", controller.ID(), err)
					}
				}()
				return
			}
		}

	case oid.HasPrefix(schema.DoorsOID) && field == schema.DoorControl:
		for _, c := range controllers {
			for _, i := range []uint8{1, 2, 3, 4} {
				if d, ok := c.Door(i); ok && d == oid {
					controller := c
					door := i
					go func() {
						s.interfaces.SetDoorControl(controller, door, value.(lib.ControlState))
					}()
					return
				}
			}
		}

	case oid.HasPrefix(schema.DoorsOID) && field == schema.DoorDelay:
		for _, c := range controllers {
			controller := c
			for _, i := range []uint8{1, 2, 3, 4} {
				door := i
				if d, ok := c.Door(i); ok && d == oid {
					go func() {
						s.interfaces.SetDoorDelay(controller, door, value.(uint8))
					}()
					return
				}
			}
		}

	case oid.HasPrefix(schema.DoorsOID) && field == schema.DoorKeypad:
		for _, c := range controllers {
			for _, i := range []uint8{1, 2, 3, 4} {
				if d, ok := c.Door(i); ok && d == oid {
					controller := c
					keypads := map[uint8]bool{
						1: false,
						2: false,
						3: false,
						4: false,
					}

					for _, d := range []uint8{1, 2, 3, 4} {
						if oid, ok := controller.Door(d); !ok {
							continue
						} else if door, ok := s.doors.Door(oid); !ok {
							continue
						} else {
							keypads[d] = door.Keypad()
						}
					}

					go func() {
						s.interfaces.ActivateKeypads(controller, keypads)
					}()

					return
				}
			}
		}

	case oid.HasPrefix(schema.DoorsOID) && field == schema.DoorPasscodes:
		for _, c := range controllers {
			controller := c
			for _, i := range []uint8{1, 2, 3, 4} {
				door := i
				if d, ok := c.Door(i); ok && d == oid {
					go func() {
						s.interfaces.SetDoorPasscodes(controller, door, value.([]uint32)...)
					}()
					return
				}
			}
		}

	case
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardStartTime,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardEndTime,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardActiveMode,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardInactiveMode,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardMonday,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardTuesday,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardWednesday,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardThursday,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardFriday,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardSaturday,
		oid.HasPrefix(schema.DoorsOID) && field == schema.DoorFirstCardSunday:
		for _, controller := range controllers {
			for _, door := range []uint8{1, 2, 3, 4} {
				if did, ok := controller.Door(door); ok && did == oid {

					if d, ok := s.doors.Door(oid); ok {
						firstcard := d.FirstCard()

						if !slices.Contains([]lib.ControlState{lib.Controlled, lib.NormallyOpen, lib.NormallyClosed}, firstcard.Active) {
							warnf("system", "invalid door first-card active mode (%v)", firstcard.Active)
							return
						}

						if !slices.Contains([]lib.ControlState{lib.Controlled, lib.NormallyOpen, lib.NormallyClosed, lib.FirstCardOnly}, firstcard.Inactive) {
							warnf("system", "invalid door first-card inactive mode (%v)", firstcard.Inactive)
							return
						}

						if s.withFirstCard {
							f := func() {
								if err := s.interfaces.SetFirstCard(controller, door, firstcard); err != nil {
									warnf("system", "controller %v door %v first-card: %v", controller.ID(), door, err)
								}
							}

							// NTS: batch update in pending
							// go func() {
							// 	s.interfaces.SetFirstCard(controller, door, firstcard)
							// }()

							s.pending.Store(oid, f)
						}
					}

					return
				}
			}
		}
	}
}

// Executes any deferred updates.
func (s *system) Commit() {
	pending := []schema.OID{}

	s.pending.Range(func(k any, v any) bool {
		if oid, ok := k.(schema.OID); ok {
			pending = append(pending, oid)
		}

		return true
	})

	for _, oid := range pending {
		if f, ok := s.pending.LoadAndDelete(oid); ok {
			if task, ok := f.(func()); ok {
				go func() {
					task()
				}()
			}
		}

	}
}

func (s *system) sweep() {
	cutoff := time.Now().Add(-s.retention)

	infof("system", "sweeping all items invalidated before %v", cutoff.Format("2006-01-02 15:04:05"))

	s.controllers.Sweep(s.retention)
	s.doors.Sweep(s.retention)
	s.cards.Sweep(s.retention)
	s.groups.Sweep(s.retention)
	s.users.Sweep(s.retention)
}

func subsystems() []struct {
	serializable
	tag Tag
} {
	return []struct {
		serializable
		tag Tag
	}{
		{&sys.interfaces, TagInterfaces},
		{&sys.controllers, TagControllers},
		{&sys.doors, TagDoors},
		{&sys.cards, TagCards},
		{&sys.groups, TagGroups},
		{&sys.events, TagEvents},
		{&sys.logs, TagLogs},
		{&sys.users, TagUsers},
		{&sys.history, TagHistory},
	}
}

func unpack(m map[string]any) ([]object, []object, []schema.OID, error) {
	o := struct {
		Created []object     `json:"created"`
		Updated []object     `json:"updated"`
		Deleted []schema.OID `json:"deleted"`
	}{}

	blob, err := json.Marshal(m)
	if err != nil {
		warnf("system", "%v", err)
		return nil, nil, nil, fmt.Errorf("invalid request (%v)", err)
	}

	if sys.debug {
		log.Debugf("UNPACK %s\n", string(blob))
	}

	if err := json.Unmarshal(blob, &o); err != nil {
		warnf("system", "%v", err)
		return nil, nil, nil, fmt.Errorf("invalid request (%v)", err)
	}

	return o.Created, o.Updated, o.Deleted, nil
}

func load(tag Tag, v serializable) error {
	if file, ok := sys.files[tag]; !ok || file == "" {
		return nil
	} else {
		bytes, err := os.ReadFile(file)
		if err != nil {
			if !os.IsNotExist(err) {
				return err
			}

			warnf("system", "%v", err)
			return nil
		}

		blob := map[Tag]json.RawMessage{}
		if err = json.Unmarshal(bytes, &blob); err != nil {
			return err
		}

		return v.Load(blob[tag])
	}
}

func save(tag Tag, v serializable) error {
	var file string
	var ok bool

	if file, ok = sys.files[tag]; !ok || file == "" {
		return nil
	}

	bytes, err := v.Save()
	if err != nil {
		return err
	}

	blob := map[Tag]json.RawMessage{
		tag: bytes,
	}

	b, err := json.MarshalIndent(blob, "", "  ")
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp("", fmt.Sprintf("uhppoted-%v.*", tag))
	if err != nil {
		return err
	}

	defer os.Remove(tmp.Name())

	if _, err := tmp.Write(b); err != nil {
		return err
	}

	if err := tmp.Sync(); err != nil {
		return err
	}

	if err := tmp.Close(); err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(file), 0770); err != nil {
		return err
	}

	return libos.Rename(tmp.Name(), file)
}

func infof(tag string, format string, args ...any) {
	if tag == "" {
		log.Infof("%v", args...)
	} else {
		log.Infof(fmt.Sprintf("%-10v %v", tag, format), args...)
	}
}

func warnf(tag string, format string, args ...any) {
	if tag == "" {
		log.Warnf("%v", args...)
	} else {
		log.Warnf(fmt.Sprintf("%-10v %v", tag, format), args...)
	}
}
