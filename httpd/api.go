package httpd

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"codeberg.org/uhppoted/uhppoted-httpd/system"
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
	case r.URL.Path == "/api/v1/refresh" && r.Method == http.MethodPost:
		if !d.apiAuthorised(w, uid, role, "/interfaces", "/controllers", "/doors", "/cards", "/groups", "/events", "/logs") {
			return
		}
		system.Refresh()
		writeJSON(w, parseHeader(r), map[string]any{"ok": true, "queued": true})

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
			}, nil
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
