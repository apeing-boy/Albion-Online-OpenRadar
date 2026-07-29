import {CATEGORIES} from '../constants/LoggerConstants.js';

class PictureInPictureManager {
    constructor() {
        this.pipCanvas = null;
        this.pipCtx = null;
        this.videoElement = null;
        this.overlayWindow = null;
        this.overlayVideo = null;
        this.overlayCloseTimer = null;
        this.mode = null;
        this.closingOverlay = false;
        this.stream = null;
        this.isActive = false;
        this.canvasManager = null;
        this.size = 500;
        this.windowControlSupported = false;
        this.lifecycleGeneration = 0;
        this._onCanvasSizeChanged = null;
        this._onLeavePip = null;
    }

    initialize(canvasManager) {
        this.canvasManager = canvasManager;

        const canvases = canvasManager.canvases || canvasManager.getAllCanvases();
        const firstCanvas = canvases.mapCanvas || canvases.drawCanvas;
        this.size = firstCanvas?.width || 500;

        this.createPipCanvas();
        this.createVideoElement();
        this.setupEventListeners();
        void this.detectWindowControlSupport();

        return true;
    }

    async detectWindowControlSupport() {
        try {
            const response = await fetch('/api/pip-window');
            if (response.ok) {
                const result = await response.json();
                this.windowControlSupported = result.supported === true;
            }
        } catch (error) {
            window.logger?.warn(CATEGORIES.SYSTEM, 'PiP_WindowControlDetectionFailed', {
                error: error?.message
            });
        }

        window.pipWindowControlSupported = this.windowControlSupported;
        document.dispatchEvent(new CustomEvent('pipWindowControlSupport', {
            detail: {supported: this.windowControlSupported}
        }));
    }

    createPipCanvas() {
        this.pipCanvas = document.createElement('canvas');
        this.pipCanvas.width = this.size;
        this.pipCanvas.height = this.size;
        this.pipCtx = this.pipCanvas.getContext('2d');
        this.pipCtx.imageSmoothingEnabled = true;
        this.pipCtx.imageSmoothingQuality = 'high';
    }

    createVideoElement() {
        this.videoElement = document.createElement('video');
        this.videoElement.muted = true;
        this.videoElement.playsInline = true;
        this.videoElement.style.cssText = 'position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;';
        document.body.appendChild(this.videoElement);

        this._onLeavePip = () => this.onPipClosed();
        this.videoElement.addEventListener('leavepictureinpicture', this._onLeavePip);
    }

    setupEventListeners() {
        this._onCanvasSizeChanged = (e) => {
            const newSize = e.detail?.size || 500;
            this.size = newSize;
            if (this.pipCanvas) {
                this.pipCanvas.width = newSize;
                this.pipCanvas.height = newSize;
            }
        };
        document.addEventListener('canvasSizeChanged', this._onCanvasSizeChanged);
    }

    async toggle() {
        if (this.isActive) {
            await this.stop();
        } else {
            await this.start();
        }
        return this.isActive;
    }

    async start() {
        if (!this.canvasManager) {
            window.logger?.error(CATEGORIES.SYSTEM, 'PiP_NoCanvasManager', {});
            return false;
        }

        if (!this.windowControlSupported && !document.pictureInPictureEnabled) {
            window.logger?.error(CATEGORIES.SYSTEM, 'PiP_NotSupported', {});
            return false;
        }

        if (this.windowControlSupported) {
            return this.startOverlayWindow();
        }

        return this.startBrowserPictureInPicture();
    }

    async startOverlayWindow() {
        // window.open must happen synchronously in the button click call stack or
        // Chromium may treat it as an unsolicited popup.
        const overlay = window.open(
            '',
            'openradar-overlay',
            `popup=yes,width=${this.size},height=${this.size},left=40,top=40`
        );
        if (!overlay) {
            window.logger?.error(CATEGORIES.SYSTEM, 'Overlay_StartFailed', {reason: 'popup-blocked'});
            return false;
        }

        try {
            this.lifecycleGeneration++;
            this.compositeFrame();
            this.stream = this.pipCanvas.captureStream(30);
            this.overlayWindow = overlay;
            this.createOverlayDocument(overlay);
            this.overlayVideo.srcObject = this.stream;
            await this.overlayVideo.play();

            this.mode = 'overlay';
            this.isActive = true;
            this.watchOverlayClosed();
            this.dispatchStatusEvent('started');
            void this.applyWindowSettings({retry: true});

            return true;
        } catch (error) {
            overlay.close();
            this.overlayWindow = null;
            this.overlayVideo = null;
            this.cleanup();
            window.logger?.error(CATEGORIES.SYSTEM, 'Overlay_StartFailed', {error: error.message});
            return false;
        }
    }

    createOverlayDocument(overlay) {
        const doc = overlay.document;
        doc.title = 'OpenRadar Overlay';
        doc.documentElement.style.cssText = 'width:100%;height:100%;margin:0;background:#000;overflow:hidden;';
        doc.body.style.cssText = 'width:100%;height:100%;margin:0;background:#000;overflow:hidden;';
        doc.body.replaceChildren();

        const video = doc.createElement('video');
        video.muted = true;
        video.autoplay = true;
        video.playsInline = true;
        video.style.cssText = [
            'display:block',
            'width:100vw',
            'height:100vh',
            'object-fit:contain',
            'background:#000',
            'pointer-events:none',
            'user-select:none'
        ].join(';');
        doc.body.appendChild(video);
        this.overlayVideo = video;

        overlay.addEventListener('beforeunload', () => {
            if (!this.closingOverlay) {
                this.onOverlayClosed();
            }
        }, {once: true});
    }

    watchOverlayClosed() {
        if (this.overlayCloseTimer) {
            clearInterval(this.overlayCloseTimer);
        }
        this.overlayCloseTimer = setInterval(() => {
            if (this.mode === 'overlay' && (!this.overlayWindow || this.overlayWindow.closed)) {
                this.onOverlayClosed();
            }
        }, 250);
    }

    onOverlayClosed() {
        if (this.mode !== 'overlay') {
            return;
        }
        this.lifecycleGeneration++;
        void this.releaseWindowControls();
        this.cleanup();
        this.dispatchStatusEvent('stopped');
    }

    async startBrowserPictureInPicture() {
        try {
            this.lifecycleGeneration++;
            this.compositeFrame();
            this.stream = this.pipCanvas.captureStream(30);
            this.videoElement.srcObject = this.stream;

            await new Promise((resolve, reject) => {
                const onCanPlay = () => {
                    this.videoElement.removeEventListener('canplay', onCanPlay);
                    this.videoElement.removeEventListener('error', onError);
                    resolve();
                };
                const onError = (e) => {
                    this.videoElement.removeEventListener('canplay', onCanPlay);
                    this.videoElement.removeEventListener('error', onError);
                    reject(e);
                };
                this.videoElement.addEventListener('canplay', onCanPlay);
                this.videoElement.addEventListener('error', onError);
                setTimeout(resolve, 100);
            });

            await this.videoElement.play();
            await this.videoElement.requestPictureInPicture();

            this.mode = 'pip';
            this.isActive = true;
            this.dispatchStatusEvent('started');
            void this.applyWindowSettings({retry: true});

            return true;
        } catch (error) {
            window.logger?.error(CATEGORIES.SYSTEM, 'PiP_StartFailed', {error: error.message});
            return false;
        }
    }

    async stop() {
        this.lifecycleGeneration++;
        await this.releaseWindowControls();

        if (this.mode === 'overlay') {
            this.closingOverlay = true;
            try {
                this.overlayWindow?.close();
            } finally {
                this.closingOverlay = false;
            }
            this.cleanup();
            this.dispatchStatusEvent('stopped');
            return;
        }

        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            }
        } catch (error) {
            window.logger?.error(CATEGORIES.SYSTEM, 'PiP_ExitFailed', {error: error.message});
        }

        this.cleanup();
    }

    onPipClosed() {
        this.lifecycleGeneration++;
        void this.releaseWindowControls();
        this.cleanup();
        this.dispatchStatusEvent('stopped');
    }

    cleanup() {
        if (this.overlayCloseTimer) {
            clearInterval(this.overlayCloseTimer);
            this.overlayCloseTimer = null;
        }
        this.overlayWindow = null;
        this.overlayVideo = null;
        this.mode = null;

        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.srcObject = null;
        }

        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        this.isActive = false;
    }

    onRadarRendered() {
        if (this.isActive) {
            this.compositeFrame();
        }
    }

    getWindowSettings() {
        const settingsSync = window.settingsSync;
        const rawOpacity = settingsSync?.getNumber('settingPipOpacity', 100) ?? 100;
        const opacity = Math.max(20, Math.min(100, rawOpacity));
        const position = settingsSync?.get('settingPipPosition', 'current') || 'current';

        return {opacity, position, margin: 12};
    }

    async applyWindowSettings({retry = false} = {}) {
        if (!this.isActive || !this.windowControlSupported) {
            return false;
        }

        const generation = this.lifecycleGeneration;
        const attempts = retry ? 8 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (!this.isActive || generation !== this.lifecycleGeneration) {
                return false;
            }
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, 125 * attempt));
                if (!this.isActive || generation !== this.lifecycleGeneration) {
                    return false;
                }
            }

            try {
                const response = await fetch('/api/pip-window', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(this.getWindowSettings())
                });
                if (response.ok) {
                    return true;
                }
                if (response.status !== 409) {
                    window.logger?.warn(CATEGORIES.SYSTEM, 'PiP_WindowSettingsRejected', {
                        status: response.status
                    });
                    return false;
                }
            } catch (error) {
                window.logger?.warn(CATEGORIES.SYSTEM, 'PiP_WindowSettingsFailed', {
                    error: error?.message
                });
                return false;
            }
        }

        window.logger?.warn(CATEGORIES.SYSTEM, 'PiP_WindowNotFound', {});
        return false;
    }

    async releaseWindowControls() {
        if (!this.windowControlSupported) {
            return false;
        }

        try {
            const response = await fetch('/api/pip-window', {method: 'DELETE'});
            return response.ok;
        } catch (error) {
            window.logger?.warn(CATEGORIES.SYSTEM, 'PiP_WindowControlsReleaseFailed', {
                error: error?.message
            });
            return false;
        }
    }

    setWindowOpacity(opacity) {
        const value = Math.max(20, Math.min(100, Number(opacity) || 100));
        window.settingsSync?.setNumber('settingPipOpacity', value);
        return this.applyWindowSettings();
    }

    setWindowPosition(position) {
        const allowed = new Set([
            'current',
            'top-left',
            'top-right',
            'bottom-left',
            'bottom-right',
            'center'
        ]);
        const value = allowed.has(position) ? position : 'current';
        window.settingsSync?.set('settingPipPosition', value);
        return this.applyWindowSettings();
    }

    compositeFrame() {
        if (!this.pipCtx || !this.canvasManager) return;

        const canvases = this.canvasManager.canvases || this.canvasManager.getAllCanvases();
        const {mapCanvas, drawCanvas, ourPlayerCanvas, uiCanvas} = canvases;

        const sourceSize = mapCanvas?.width || this.size;
        if (this.pipCanvas.width !== sourceSize) {
            this.pipCanvas.width = sourceSize;
            this.pipCanvas.height = sourceSize;
            this.size = sourceSize;
        }

        this.pipCtx.clearRect(0, 0, this.size, this.size);

        if (mapCanvas) this.pipCtx.drawImage(mapCanvas, 0, 0);
        if (drawCanvas) this.pipCtx.drawImage(drawCanvas, 0, 0);
        if (ourPlayerCanvas) this.pipCtx.drawImage(ourPlayerCanvas, 0, 0);
        if (uiCanvas) this.pipCtx.drawImage(uiCanvas, 0, 0);
    }

    dispatchStatusEvent(status) {
        document.dispatchEvent(new CustomEvent('pipStatusChange', {
            detail: {status, isActive: this.isActive}
        }));
    }

    destroy() {
        this.lifecycleGeneration++;
        void this.releaseWindowControls();
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch((e) => {
                window.logger?.warn(CATEGORIES.SYSTEM, 'PiP_DestroyExitFailed', {error: e?.message});
            });
        }
        if (this.overlayWindow && !this.overlayWindow.closed) {
            this.closingOverlay = true;
            this.overlayWindow.close();
            this.closingOverlay = false;
        }

        this.cleanup();

        if (this._onCanvasSizeChanged) {
            document.removeEventListener('canvasSizeChanged', this._onCanvasSizeChanged);
            this._onCanvasSizeChanged = null;
        }

        if (this.videoElement) {
            if (this._onLeavePip) {
                this.videoElement.removeEventListener('leavepictureinpicture', this._onLeavePip);
                this._onLeavePip = null;
            }
            if (this.videoElement.parentNode) {
                this.videoElement.parentNode.removeChild(this.videoElement);
            }
            this.videoElement = null;
        }

        this.pipCanvas = null;
        this.pipCtx = null;
        this.canvasManager = null;
        this.windowControlSupported = false;
    }

    isSupported() {
        return this.windowControlSupported || document.pictureInPictureEnabled === true;
    }
}

const pictureInPictureManager = new PictureInPictureManager();
export default pictureInPictureManager;
