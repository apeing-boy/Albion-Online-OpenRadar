package server

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestExternalMapsFS(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "game"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "coords.json"), []byte(`{"clusters":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := externalMapsFS(dir); err != nil {
		t.Fatalf("valid external maps directory rejected: %v", err)
	}
}

func TestExternalMapsFSMissingData(t *testing.T) {
	dir := t.TempDir()
	if _, err := externalMapsFS(dir); err == nil {
		t.Fatal("missing game directory must fail")
	}
	if err := os.Mkdir(filepath.Join(dir, "game"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := externalMapsFS(dir); err == nil {
		t.Fatal("missing coords.json must fail")
	}
}

func TestExternalMapsHandlerServesFilesWithoutBinaryETag(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "game"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "game", "zone.webp"), []byte("map"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &HTTPServer{}
	req := httptest.NewRequest("GET", "/images/Maps/game/zone.webp", nil)
	rec := httptest.NewRecorder()
	s.externalFSHandler("/images/Maps/", os.DirFS(dir)).ServeHTTP(rec, req)

	if rec.Code != 200 || rec.Body.String() != "map" {
		t.Fatalf("unexpected map response: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}
	if got := rec.Header().Get("Etag"); got != "" {
		t.Fatalf("external maps must not inherit the binary ETag, got %q", got)
	}
}
