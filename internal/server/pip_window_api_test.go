package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nospy/albion-openradar/internal/pipwindow"
)

type fakePiPWindowController struct {
	supported bool
	applied   []pipwindow.Config
	err       error
	stopCalls int
	stopErr   error
}

func (f *fakePiPWindowController) Supported() bool {
	return f.supported
}

func (f *fakePiPWindowController) Apply(config pipwindow.Config) error {
	f.applied = append(f.applied, config)
	return f.err
}

func (f *fakePiPWindowController) Stop() error {
	f.stopCalls++
	return f.stopErr
}

func newPiPWindowTestMux(controller pipwindow.Controller) *http.ServeMux {
	mux := http.NewServeMux()
	NewPiPWindowAPI(controller).Register(mux)
	return mux
}

func TestPiPWindowAPIGetReportsSupport(t *testing.T) {
	mux := newPiPWindowTestMux(&fakePiPWindowController{supported: true})
	req := httptest.NewRequest(http.MethodGet, "/api/pip-window", http.NoBody)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
	var body map[string]bool
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body["supported"] {
		t.Error("supported=false, want true")
	}
}

func TestPiPWindowAPIPostAppliesConfig(t *testing.T) {
	controller := &fakePiPWindowController{supported: true}
	mux := newPiPWindowTestMux(controller)
	body := bytes.NewBufferString(`{"opacity":65,"position":"top-right","margin":16}`)
	req := httptest.NewRequest(http.MethodPost, "/api/pip-window", body)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if len(controller.applied) != 1 {
		t.Fatalf("Apply calls=%d, want 1", len(controller.applied))
	}
	if got := controller.applied[0]; got.Opacity != 65 || got.Position != pipwindow.PositionTopRight || got.Margin != 16 {
		t.Errorf("applied config=%+v", got)
	}
}

func TestPiPWindowAPIPostRejectsInvalidConfig(t *testing.T) {
	controller := &fakePiPWindowController{supported: true}
	mux := newPiPWindowTestMux(controller)
	body := bytes.NewBufferString(`{"opacity":5,"position":"somewhere"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/pip-window", body)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	if len(controller.applied) != 0 {
		t.Errorf("Apply called for invalid config: %+v", controller.applied)
	}
}

func TestPiPWindowAPIPostRequiresLoopback(t *testing.T) {
	controller := &fakePiPWindowController{supported: true}
	mux := newPiPWindowTestMux(controller)
	body := bytes.NewBufferString(`{"opacity":80,"position":"current"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/pip-window", body)
	req.RemoteAddr = "192.168.1.42:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestPiPWindowAPIPostReturnsConflictWhileWindowIsMissing(t *testing.T) {
	controller := &fakePiPWindowController{
		supported: true,
		err:       errors.Join(errors.New("enumeration"), pipwindow.ErrWindowNotFound),
	}
	mux := newPiPWindowTestMux(controller)
	body := bytes.NewBufferString(`{"opacity":80,"position":"current"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/pip-window", body)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409", rec.Code)
	}
}

func TestPiPWindowAPIPostReportsUnsupportedPlatform(t *testing.T) {
	controller := &fakePiPWindowController{supported: false}
	mux := newPiPWindowTestMux(controller)
	body := bytes.NewBufferString(`{"opacity":80,"position":"current"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/pip-window", body)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status %d, want 501", rec.Code)
	}
}

func TestPiPWindowAPIDeleteStopsController(t *testing.T) {
	controller := &fakePiPWindowController{supported: true}
	mux := newPiPWindowTestMux(controller)
	req := httptest.NewRequest(http.MethodDelete, "/api/pip-window", http.NoBody)
	req.RemoteAddr = "127.0.0.1:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if controller.stopCalls != 1 {
		t.Fatalf("Stop calls=%d, want 1", controller.stopCalls)
	}
}

func TestPiPWindowAPIDeleteRequiresLoopback(t *testing.T) {
	controller := &fakePiPWindowController{supported: true}
	mux := newPiPWindowTestMux(controller)
	req := httptest.NewRequest(http.MethodDelete, "/api/pip-window", http.NoBody)
	req.RemoteAddr = "192.168.1.42:1234"
	rec := httptest.NewRecorder()

	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
	if controller.stopCalls != 0 {
		t.Fatalf("Stop calls=%d, want 0", controller.stopCalls)
	}
}
