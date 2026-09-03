package httpd

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"codeberg.org/uhppoted/uhppoted-httpd/system"
	"codeberg.org/uhppoted/uhppoted-httpd/system/catalog/schema"
	"codeberg.org/uhppoted/uhppoted-httpd/types"
)

func (d *dispatcher) api(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.URL.Path == "/api/v1/health" {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, parseHeader(r), map[string]any{
			"ok":      true,
			"service": "uhppote-access-console",
			"time":    time.Now().UTC(),
		})
		return
	}

	uid, role, authenticated := d.authenticated(r, w)
	if !authenticated {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	switch {
	case r.URL.Path == "/api/v1/controllers/import" && r.Method == http.MethodGet:
		if !d.apiAuthorised(w, uid, role, "/controllers", "/doors", "/cards", "/groups") {
			return
		}
		d.exec2(w, r, func() (any, error) {
			return system.ReadControllerImport()
		})

	case r.URL.Path == "/api/v1/controllers/import" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/controllers", "/doors", "/cards", "/groups") {
			return
		}
		d.exec(w, r, func(body map[string]any) (any, error) {
			confirmed, _ := body["confirmed"].(bool)
			if !confirmed {
				return nil, fmt.Errorf("controller import confirmation is required")
			}
			return system.ApplyControllerImport(uid, role)
		})

	case r.URL.Path == "/api/v1/backups" && r.Method == http.MethodGet:
		if !d.apiAuthorised(w, uid, role, "/controllers", "/doors", "/cards", "/groups") {
			return
		}
		d.exec2(w, r, func() (any, error) {
			return system.ListBackups()
		})

	case r.URL.Path == "/api/v1/backups" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/controllers", "/doors", "/cards", "/groups") {
			return
		}
		d.exec(w, r, func(body map[string]any) (any, error) {
			reason, _ := body["reason"].(string)
			backup, err := system.CreateBackup(reason)
			if err != nil {
				return nil, err
			}
			return map[string]any{"ok": true, "backup": backup, "directory": system.BackupDirectory()}, nil
		})

	case r.URL.Path == "/api/v1/backups/download" && r.Method == http.MethodGet:
		if !d.apiAuthorised(w, uid, role, "/controllers", "/doors", "/cards", "/groups") {
			return
		}
		path, err := system.BackupPath(r.URL.Query().Get("name"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, r.URL.Query().Get("name")))
		http.ServeFile(w, r, path)

	case r.URL.Path == "/api/v1/backups/import" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/controllers", "/doors", "/cards", "/groups") {
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 33<<20)
		if err := r.ParseMultipartForm(33 << 20); err != nil {
			http.Error(w, "Invalid or oversized backup upload", http.StatusBadRequest)
			return
		}
		file, _, err := r.FormFile("backup")
		if err != nil {
			http.Error(w, "Backup file is required", http.StatusBadRequest)
			return
		}
		defer file.Close()
		backup, err := system.StoreBackup(io.Reader(file))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, parseHeader(r), map[string]any{"ok": true, "backup": backup})

	case r.URL.Path == "/api/v1/backups/restore" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/controllers", "/doors", "/cards", "/groups") {
			return
		}
		d.exec(w, r, func(body map[string]any) (any, error) {
			name, _ := body["name"].(string)
			if strings.TrimSpace(name) == "" {
				return nil, fmt.Errorf("backup name is required")
			}
			safety, err := system.RestoreBackup(name)
			if err != nil {
				return nil, err
			}
			go func() {
				time.Sleep(750 * time.Millisecond)
				os.Exit(0)
			}()
			return map[string]any{"ok": true, "restartScheduled": true, "safetyBackup": safety}, nil
		})

	case r.URL.Path == "/api/v1/refresh" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/interfaces", "/controllers", "/doors", "/cards", "/groups", "/events", "/logs") {
			return
		}
		d.exec(w, r, func(body map[string]any) (any, error) {
			datetime, ok := body["datetime"].(string)
			if !ok || strings.TrimSpace(datetime) == "" {
				return nil, fmt.Errorf("browser datetime is required")
			}
			now, err := time.ParseInLocation("2006-01-02T15:04:05", datetime, time.Local)
			if err != nil {
				return nil, fmt.Errorf("invalid browser datetime")
			}
			system.Refresh()
			if err := system.SynchronizeDateTimeAt(now); err != nil {
				return nil, err
			}
			return map[string]any{"ok": true, "queued": true, "datetime": datetime}, nil
		})

	case r.URL.Path == "/api/v1/snapshot" && r.Method == http.MethodGet:
		if !d.apiAuthorised(w, uid, role, "/interfaces", "/controllers", "/doors", "/cards", "/groups", "/events", "/logs") {
			return
		}
		d.exec2(w, r, func() (any, error) {
			return map[string]any{
				"interfaces":  system.Interfaces(uid, role),
				"controllers": system.Controllers(uid, role),
				"doors":       system.Doors(uid, role),
				"cards":       system.Cards(uid, role, 0, 10000),
				"groups":      system.Groups(uid, role),
				"events":      system.Events(uid, role, 0, 50),
				"logs":        system.Logs(uid, role, 0, 50),
				"relayStatus": system.RelayStatus(),
			}, nil
		})

	case r.URL.Path == "/api/v1/credentials.csv" && r.Method == http.MethodGet:
		if !d.apiAuthorised(w, uid, role, "/cards") {
			return
		}
		data, err := system.CredentialsCSV()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="credentials.csv"`)
		w.Write(data)

	case r.URL.Path == "/api/v1/credentials/export" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/cards") {
			return
		}
		path, err := system.ExportCredentialsCSV()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, parseHeader(r), map[string]any{"ok": true, "path": path})

	case r.URL.Path == "/api/v1/controllers/time" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/controllers") {
			return
		}
		d.exec(w, r, func(body map[string]any) (any, error) {
			controller, ok := body["controller"].(string)
			if !ok || strings.TrimSpace(controller) == "" {
				return nil, fmt.Errorf("controller is required")
			}
			datetime, ok := body["datetime"].(string)
			if !ok || strings.TrimSpace(datetime) == "" {
				return nil, fmt.Errorf("controller datetime is required")
			}
			now, err := time.ParseInLocation("2006-01-02T15:04:05", datetime, time.Local)
			if err != nil {
				return nil, fmt.Errorf("invalid controller datetime")
			}
			if err := system.SynchronizeControllerDateTime(schema.OID(controller), now); err != nil {
				return nil, err
			}
			return map[string]any{"ok": true, "controller": controller, "datetime": datetime}, nil
		})

	case r.URL.Path == "/api/v1/doors/control" && r.Method == http.MethodPost:
		if d.mode == types.Monitor {
			http.Error(w, "Door control is disabled in monitor-only mode", http.StatusForbidden)
			return
		}
		if !d.apiAuthorised(w, uid, role, "/doors") {
			return
		}
		d.exec(w, r, func(body map[string]any) (any, error) {
			mode, ok := body["mode"].(string)
			if !ok || strings.TrimSpace(mode) == "" {
				return nil, fmt.Errorf("mode is required")
			}

			if controller, ok := body["controller"].(string); ok && strings.TrimSpace(controller) != "" {
				channel, ok := body["channel"].(float64)
				if !ok || channel < 1 || channel > 4 || channel != float64(uint8(channel)) {
					return nil, fmt.Errorf("channel must be an integer from 1 to 4")
				}
				if err := system.ControlControllerDoor(controller, uint8(channel), mode); err != nil {
					return nil, err
				}
				return map[string]any{"ok": true, "controller": controller, "channel": uint8(channel), "mode": mode}, nil
			}

			door, ok := body["door"].(string)
			if !ok || strings.TrimSpace(door) == "" {
				return nil, fmt.Errorf("door or controller and channel are required")
			}
			if err := system.ControlDoor(uid, role, door, mode); err != nil {
				return nil, err
			}
			return map[string]any{"ok": true, "door": door, "mode": mode}, nil
		})

	case strings.HasPrefix(r.URL.Path, "/api/v1/"):
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		} else {
			http.Error(w, "API endpoint not found", http.StatusNotFound)
		}

	default:
		http.NotFound(w, r)
	}
}

func (d *dispatcher) apiAuthorised(w http.ResponseWriter, uid, role string, paths ...string) bool {
	for _, path := range paths {
		if !d.authorised(uid, role, path) {
			http.Error(w, "Not authorised", http.StatusForbidden)
			return false
		}
	}
	return true
}
	
