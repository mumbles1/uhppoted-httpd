package httpd

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestExecReturnsJSON(t *testing.T) {
	d := dispatcher{context: context.Background(), timeout: time.Second}
	r := httptest.NewRequest(http.MethodPost, "/doors", strings.NewReader(`{"door":"1"}`))
	r.Header.Set("Content-Type", "application/json; charset=utf-8")
	w := httptest.NewRecorder()

	d.exec(w, r, func(body map[string]any) (any, error) {
		return map[string]any{"door": body["door"], "ok": true}, nil
	})

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("expected JSON content type, got %q", got)
	}
	if got := strings.TrimSpace(w.Body.String()); got != `{"door":"1","ok":true}` {
		t.Fatalf("unexpected response %s", got)
	}
}

func TestExec2ReturnsHandlerError(t *testing.T) {
	d := dispatcher{context: context.Background(), timeout: time.Second}
	r := httptest.NewRequest(http.MethodPost, "/command", nil)
	w := httptest.NewRecorder()

	d.exec2(w, r, func() (any, error) { return nil, errors.New("controller rejected command") })

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "controller rejected command") {
		t.Fatalf("unexpected response %q", w.Body.String())
	}
}

func TestExec2TimesOutWithoutLateWrite(t *testing.T) {
	d := dispatcher{context: context.Background(), timeout: 10 * time.Millisecond}
	r := httptest.NewRequest(http.MethodPost, "/command", nil)
	w := httptest.NewRecorder()
	release := make(chan struct{})

	d.exec2(w, r, func() (any, error) {
		<-release
		return map[string]bool{"ok": true}, nil
	})

	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504, got %d", w.Code)
	}
	before := w.Body.String()
	close(release)
	time.Sleep(10 * time.Millisecond)
	if got := w.Body.String(); got != before {
		t.Fatalf("worker wrote after timeout: before=%q after=%q", before, got)
	}
}

func TestSynchronizeReportsSuccessAndFailure(t *testing.T) {
	d := dispatcher{context: context.Background(), timeout: time.Second}
	r := httptest.NewRequest(http.MethodPost, "/synchronize/doors", nil)

	success := httptest.NewRecorder()
	d.synchronize(success, r, func() error { return nil })
	if success.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", success.Code)
	}

	failure := httptest.NewRecorder()
	d.synchronize(failure, r, func() error { return errors.New("sync failed") })
	if failure.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", failure.Code)
	}
}
