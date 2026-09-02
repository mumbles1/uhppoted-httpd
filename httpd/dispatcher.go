package httpd

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"codeberg.org/uhppoted/uhppoted-httpd/auth"
)

func (d *dispatcher) exec(w http.ResponseWriter, r *http.Request, f func(map[string]any) (any, error)) {
	acceptsGzip := strings.Contains(strings.ToLower(r.Header.Get("Accept-Encoding")), "gzip")
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	body := map[string]any{}

	switch contentType {
		case "application/x-www-form-urlencoded":
			if err := r.ParseForm(); err != nil {
				warnf("HTTPD", "%v", err)
				http.Error(w, "Error reading request", http.StatusBadRequest)
				return
			}

			for k, v := range r.Form {
				body[k] = v
			}

		case "application/json":
			blob, err := io.ReadAll(r.Body)
			if err != nil {
				warnf("HTTPD", "%v", err)
				http.Error(w, "Error reading request", http.StatusInternalServerError)
				return
			}

			if err := json.Unmarshal(blob, &body); err != nil {
				warnf("HTTPD", "%v", err)
				http.Error(w, "Invalid request body", http.StatusBadRequest)
				return
			}

		default:
			http.Error(w, fmt.Sprintf("Invalid request content-type (%v)", contentType), http.StatusBadRequest)
			return
	}

	d.respond(w, acceptsGzip, func() (any, error) { return f(body) })
}

func (d *dispatcher) exec2(w http.ResponseWriter, r *http.Request, f func() (any, error)) {
	acceptsGzip := parseHeader(r)
	d.respond(w, acceptsGzip, f)
}

type dispatchResult struct {
	response any
	err      error
}

// respond is the only function that writes to w. Controller operations run in a
// worker and report their result over a buffered channel, so a timed-out worker
// can finish without racing a timeout response or blocking forever.
func (d *dispatcher) respond(w http.ResponseWriter, acceptsGzip bool, f func() (any, error)) {
	ch := make(chan dispatchResult, 1)
	ctx, cancel := context.WithTimeout(d.context, d.timeout)
	defer cancel()

	go func() {
		response, err := f()
		ch <- dispatchResult{response: response, err: err}
	}()

	select {
	case <-ctx.Done():
		warnf("HTTPD", "%v", ctx.Err())
		http.Error(w, "Timeout waiting for response from system", http.StatusGatewayTimeout)

	case result := <-ch:
		if result.err != nil && errors.Is(result.err, auth.ErrUnauthorised) {
			warnf("HTTPD", "%v", result.err)
			http.Error(w, result.err.Error(), http.StatusUnauthorized)
		} else if result.err != nil {
			warnf("HTTPD", "%v", result.err)
			http.Error(w, result.err.Error(), http.StatusBadRequest)
		} else if result.response != nil {
			writeJSON(w, acceptsGzip, result.response)
		}
	}
}

func writeJSON(w http.ResponseWriter, acceptsGzip bool, response any) {
	b, err := json.Marshal(response)
	if err != nil {
		warnf("HTTPD", "%v", err)
		http.Error(w, "Internal error generating response", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if acceptsGzip && len(b) > GZIP_MINIMUM {
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		_, _ = gz.Write(b)
		_ = gz.Close()
		return
	}

	_, _ = w.Write(b)
}
