package system

import (
	"fmt"
	"os"
	"path/filepath"

	lib "codeberg.org/uhppoted/uhppoted-core/types"

	"codeberg.org/uhppoted/uhppoted-httpd/auth"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/system/db"
)

func SetDefaultCardStartDate(v string) {
	if date, err := lib.ParseDate(v); err == nil && !date.IsZero() {
		sys.acl.defaultStartDate = date
		infof("cards", "default card start date %v", date)
	}
}

func SetDefaultCardEndDate(v string) {
	if date, err := lib.ParseDate(v); err == nil && !date.IsZero() {
		sys.acl.defaultEndDate = date
		infof("cards", "default card end date   %v", date)
	}
}

func Cards(uid, role string, start int, count int) []schema.Object {
	sys.RLock()
	defer sys.RUnlock()

	auth := auth.NewAuthorizator(uid, role)
	objects := []schema.Object{}
	cards := sys.cards.AsObjects(auth, start, count)

	defaultStartDate := catalog.NewObject2(schema.SystemOID, schema.SystemCardStartDate, "")
	defaultEndDate := catalog.NewObject2(schema.SystemOID, schema.SystemCardEndDate, "")

	if !sys.acl.defaultStartDate.IsZero() {
		defaultStartDate.Value = fmt.Sprintf("%v", sys.acl.defaultStartDate)
	}

	if !sys.acl.defaultEndDate.IsZero() {
		defaultEndDate.Value = fmt.Sprintf("%v", sys.acl.defaultEndDate)
	}

	catalog.Join(&objects, defaultStartDate, defaultEndDate)
	catalog.Join(&objects, cards...)

	return objects
}

func UpdateCards(uid, role string, m map[string]any) (any, error) {
	sys.Lock()

	defer sys.Unlock()

	created, updated, deleted, err := unpack(m)
	if err != nil {
		return nil, err
	}

	auth := auth.NewAuthorizator(uid, role)
	dbc := db.NewDBC(sys.trail)
	shadow := sys.cards.Clone()

	for _, o := range created {
		if objects, err := shadow.Create(auth, o.OID, o.Value, dbc); err != nil {
			return nil, err
		} else {
			dbc.Stash(objects)
		}
	}

	for _, o := range updated {
		if objects, err := shadow.Update(auth, o.OID, o.Value, dbc); err != nil {
			return nil, err
		} else {
			dbc.Stash(objects)
		}
	}

	for _, oid := range deleted {
		if objects, err := shadow.Delete(auth, oid, dbc); err != nil {
			return nil, err
		} else {
			dbc.Stash(objects)
		}
	}

	if err := shadow.Validate(); err != nil {
		return nil, err
	}

	if err := save(TagCards, &shadow); err != nil {
		return nil, err
	}

	dbc.Commit(&sys, func() {
		sys.cards = shadow
	})

	if err := exportCredentialsCSVLocked(); err != nil {
		warnf("credentials", "could not update credentials CSV: %v", err)
	}

	return dbc.Objects(), nil
}

func CredentialsCSV() ([]byte, error) {
	sys.RLock()
	defer sys.RUnlock()
	return sys.cards.CSV()
}

func ExportCredentialsCSV() (string, error) {
	sys.RLock()
	defer sys.RUnlock()
	return credentialsCSVPath(), exportCredentialsCSVLocked()
}

func credentialsCSVPath() string {
	if path := os.Getenv("UHPPOTED_CREDENTIALS_CSV"); path != "" {
		return path
	}
	return "/data/credentials.csv"
}

func exportCredentialsCSVLocked() error {
	data, err := sys.cards.CSV()
	if err != nil {
		return err
	}
	path := credentialsCSVPath()
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".credentials-*.csv")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0640); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
