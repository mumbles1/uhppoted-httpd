package system

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const backupPrefix = "access-control-backup-"

type BackupInfo struct {
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	Size      int64     `json:"size"`
}

type backupManifest struct {
	Format    int       `json:"format"`
	CreatedAt time.Time `json:"createdAt"`
	Reason    string    `json:"reason"`
	Files     []string  `json:"files"`
}

var backupTags = []Tag{TagInterfaces, TagControllers, TagDoors, TagCards, TagGroups}

func backupDirectory() string {
	if dir := strings.TrimSpace(os.Getenv("UHPPOTED_BACKUP_DIR")); dir != "" {
		return dir
	}

	return "/data/backups"
}

func BackupDirectory() string {
	return backupDirectory()
}

func backupName(now time.Time) string {
	return backupPrefix + now.UTC().Format("20060102-150405.000Z") + ".zip"
}

func CreateBackup(reason string) (BackupInfo, error) {
	sys.RLock()
	defer sys.RUnlock()

	dir := backupDirectory()
	if err := os.MkdirAll(dir, 0770); err != nil {
		return BackupInfo{}, err
	}

	now := time.Now().UTC()
	name := backupName(now)
	path := filepath.Join(dir, name)
	tmp, err := os.CreateTemp(dir, ".backup-*.tmp")
	if err != nil {
		return BackupInfo{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	zw := zip.NewWriter(tmp)
	manifest := backupManifest{Format: 1, CreatedAt: now, Reason: strings.TrimSpace(reason), Files: []string{}}
	for _, tag := range backupTags {
		file := sys.files[tag]
		if file == "" {
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			_ = zw.Close()
			_ = tmp.Close()
			return BackupInfo{}, err
		}
		entry := "system/" + string(tag) + ".json"
		w, err := zw.Create(entry)
		if err != nil {
			return BackupInfo{}, err
		}
		if _, err := w.Write(data); err != nil {
			return BackupInfo{}, err
		}
		manifest.Files = append(manifest.Files, entry)
	}

	if csvPath := credentialsCSVPath(); csvPath != "" {
		if data, err := os.ReadFile(csvPath); err == nil {
			w, err := zw.Create("credentials.csv")
			if err != nil {
				return BackupInfo{}, err
			}
			if _, err := w.Write(data); err != nil {
				return BackupInfo{}, err
			}
			manifest.Files = append(manifest.Files, "credentials.csv")
		}
	}

	b, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return BackupInfo{}, err
	}
	w, err := zw.Create("manifest.json")
	if err != nil {
		return BackupInfo{}, err
	}
	if _, err := w.Write(b); err != nil {
		return BackupInfo{}, err
	}
	if err := zw.Close(); err != nil {
		return BackupInfo{}, err
	}
	if err := tmp.Sync(); err != nil {
		return BackupInfo{}, err
	}
	if err := tmp.Close(); err != nil {
		return BackupInfo{}, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return BackupInfo{}, err
	}

	info, err := os.Stat(path)
	if err != nil {
		return BackupInfo{}, err
	}
	return BackupInfo{Name: name, CreatedAt: now, Size: info.Size()}, nil
}

func ListBackups() ([]BackupInfo, error) {
	dir := backupDirectory()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []BackupInfo{}, nil
	}
	if err != nil {
		return nil, err
	}

	list := []BackupInfo{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), backupPrefix) || !strings.HasSuffix(entry.Name(), ".zip") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		list = append(list, BackupInfo{Name: entry.Name(), CreatedAt: info.ModTime().UTC(), Size: info.Size()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
	return list, nil
}

func BackupPath(name string) (string, error) {
	if filepath.Base(name) != name || !strings.HasPrefix(name, backupPrefix) || !strings.HasSuffix(name, ".zip") {
		return "", fmt.Errorf("invalid backup name")
	}
	path := filepath.Join(backupDirectory(), name)
	if _, err := os.Stat(path); err != nil {
		return "", err
	}
	return path, nil
}

func StoreBackup(reader io.Reader) (BackupInfo, error) {
	dir := backupDirectory()
	if err := os.MkdirAll(dir, 0770); err != nil {
		return BackupInfo{}, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*.zip")
	if err != nil {
		return BackupInfo{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	limited := io.LimitReader(reader, (32<<20)+1)
	n, err := io.Copy(tmp, limited)
	if err != nil {
		_ = tmp.Close()
		return BackupInfo{}, err
	}
	if n > 32<<20 {
		_ = tmp.Close()
		return BackupInfo{}, fmt.Errorf("backup exceeds 32 MiB limit")
	}
	if err := tmp.Close(); err != nil {
		return BackupInfo{}, err
	}
	if err := validateBackup(tmpName); err != nil {
		return BackupInfo{}, err
	}

	now := time.Now().UTC()
	name := backupPrefix + "imported-" + now.Format("20060102-150405.000Z") + ".zip"
	path := filepath.Join(dir, name)
	if err := os.Rename(tmpName, path); err != nil {
		return BackupInfo{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return BackupInfo{}, err
	}
	return BackupInfo{Name: name, CreatedAt: now, Size: info.Size()}, nil
}

func validateBackup(path string) error {
	r, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("invalid backup archive: %w", err)
	}
	defer r.Close()

	seenManifest := false
	for _, f := range r.File {
		if f.UncompressedSize64 > 16<<20 {
			return fmt.Errorf("backup entry %s is too large", f.Name)
		}
		if f.Name == "manifest.json" {
			seenManifest = true
			rc, err := f.Open()
			if err != nil {
				return err
			}
			var manifest backupManifest
			err = json.NewDecoder(io.LimitReader(rc, 1<<20)).Decode(&manifest)
			_ = rc.Close()
			if err != nil || manifest.Format != 1 || manifest.CreatedAt.IsZero() {
				return fmt.Errorf("invalid backup manifest")
			}
			continue
		}
		if !strings.HasPrefix(f.Name, "system/") || !strings.HasSuffix(f.Name, ".json") {
			if f.Name != "credentials.csv" {
				return fmt.Errorf("unexpected backup entry %s", f.Name)
			}
			continue
		}
		tag := Tag(strings.TrimSuffix(strings.TrimPrefix(f.Name, "system/"), ".json"))
		if !containsBackupTag(tag) {
			return fmt.Errorf("unsupported backup data %s", tag)
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		var wrapper map[Tag]json.RawMessage
		err = json.NewDecoder(io.LimitReader(rc, 16<<20)).Decode(&wrapper)
		_ = rc.Close()
		if err != nil || wrapper[tag] == nil || !json.Valid(wrapper[tag]) {
			return fmt.Errorf("invalid %s data", tag)
		}
	}
	if !seenManifest {
		return fmt.Errorf("backup manifest is missing")
	}
	return nil
}

// RestoreBackup stages validated settings from a backup and replaces the live
// files atomically. The caller must restart the process before serving another
// request so the in-memory catalog cannot diverge from the restored files.
func RestoreBackup(name string) (BackupInfo, error) {
	path, err := BackupPath(name)
	if err != nil {
		return BackupInfo{}, err
	}
	if err := validateBackup(path); err != nil {
		return BackupInfo{}, err
	}

	safety, err := CreateBackup("automatic safety backup before restore of " + name)
	if err != nil {
		return BackupInfo{}, fmt.Errorf("could not create safety backup: %w", err)
	}
	sys.Lock()
	defer sys.Unlock()

	r, err := zip.OpenReader(path)
	if err != nil {
		return BackupInfo{}, err
	}
	defer r.Close()

	for _, f := range r.File {
		if f.Name == "credentials.csv" {
			rc, err := f.Open()
			if err != nil {
				return safety, err
			}
			data, err := io.ReadAll(io.LimitReader(rc, 16<<20))
			_ = rc.Close()
			if err != nil {
				return safety, err
			}
			if err := writeAtomic(credentialsCSVPath(), data); err != nil {
				return safety, fmt.Errorf("restoring credentials CSV: %w", err)
			}
			continue
		}
		if !strings.HasPrefix(f.Name, "system/") || !strings.HasSuffix(f.Name, ".json") {
			continue
		}
		tag := Tag(strings.TrimSuffix(strings.TrimPrefix(f.Name, "system/"), ".json"))
		target := sys.files[tag]
		if target == "" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return safety, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, 16<<20))
		_ = rc.Close()
		if err != nil {
			return safety, err
		}
		if err := writeAtomic(target, data); err != nil {
			return safety, fmt.Errorf("restoring %s: %w", tag, err)
		}
	}

	return safety, nil
}

func writeAtomic(target string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0770); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".restore-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, target)
}

func containsBackupTag(tag Tag) bool {
	for _, candidate := range backupTags {
		if candidate == tag {
			return true
		}
	}
	return false
}
  
