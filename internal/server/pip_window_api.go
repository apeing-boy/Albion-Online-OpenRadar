package server

import (
	"errors"
	"net/http"

	"github.com/segmentio/encoding/json"

	"github.com/nospy/albion-openradar/internal/pipwindow"
)

type PiPWindowAPI struct {
	controller pipwindow.Controller
}

func NewPiPWindowAPI(controller pipwindow.Controller) *PiPWindowAPI {
	return &PiPWindowAPI{controller: controller}
}

func (a *PiPWindowAPI) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/pip-window", a.handleGet)
	mux.HandleFunc("POST /api/pip-window", a.handlePost)
}

func (a *PiPWindowAPI) handleGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{
		"supported": isLoopback(r.RemoteAddr) && a.controller != nil && a.controller.Supported(),
	})
}

func (a *PiPWindowAPI) handlePost(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r.RemoteAddr) {
		http.Error(w, "Picture-in-Picture window controls can only be changed from the host PC", http.StatusForbidden)
		return
	}
	if a.controller == nil || !a.controller.Supported() {
		http.Error(w, pipwindow.ErrNotSupported.Error(), http.StatusNotImplemented)
		return
	}

	var config pipwindow.Config
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := config.Validate(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := a.controller.Apply(config); err != nil {
		if errors.Is(err, pipwindow.ErrWindowNotFound) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, "apply Picture-in-Picture window settings: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
