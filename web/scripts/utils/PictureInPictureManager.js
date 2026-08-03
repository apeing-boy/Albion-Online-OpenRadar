import {CATEGORIES} from '../constants/LoggerConstants.js';
import zonesDatabase from '../data/ZonesDatabase.js';

const INFO_BAR_HEIGHT_RATIO = 0.1;
const INFO_BAR_MIN_HEIGHT = 38;
const INFO_BAR_MAX_HEIGHT = 56;

class PictureInPictureManager {
    constructor() {
        this.overlayWindow = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.overlayCloseTimer = null;
        this.mode = null;
        this.closingOverlay = false;
        this.isActive = false;
        this.canvasManager = null;
        this.radarRenderer = null;
        this.size = 500;
        this.windowControlSupported = false;
        this.lifecycleGeneration = 0;
        this._onCanvasSizeChanged = null;
    }

    initialize(canvasManager, radarRenderer = null) {
        this.canvasManager = canvasManager;
        this.radarRenderer = radarRenderer;

        const canvases = canvasManager.canvases || canvasManager.getAllCanvases();
        const firstCanvas = canvases.mapCanvas || canvases.drawCanvas;
        this.size = firstCanvas?.width || 500;

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

    setupEventListeners() {
        this._onCanvasSizeChanged = (e) => {
            const newSize = e.detail?.size || 500;
            this.size = newSize;
            if (this.overlayCanvas) {
                this.resizeOverlayCanvas(newSize);
                this.compositeFrame();
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

        if (!this.windowControlSupported) {
            window.logger?.error(CATEGORIES.SYSTEM, 'Overlay_NotSupported', {});
            return false;
        }

        return this.startOverlayWindow();
    }

    async startOverlayWindow() {
        // window.open must happen synchronously in the button click call stack or
        // Chromium may treat it as an unsolicited popup.
        const overlay = window.open(
            '',
            'openradar-overlay',
            `popup=yes,width=${this.size},height=${this.size + this.getInfoBarHeight(this.size)},left=40,top=40`
        );
        if (!overlay) {
            window.logger?.error(CATEGORIES.SYSTEM, 'Overlay_StartFailed', {reason: 'popup-blocked'});
            return false;
        }

        try {
            this.lifecycleGeneration++;
            this.overlayWindow = overlay;
            this.createOverlayDocument(overlay);
            this.mode = 'overlay';
            this.isActive = true;
            this.compositeFrame();
            this.watchOverlayClosed();
            this.dispatchStatusEvent('started');
            void this.applyWindowSettings({retry: true});

            return true;
        } catch (error) {
            overlay.close();
            this.overlayWindow = null;
            this.overlayCanvas = null;
            this.overlayCtx = null;
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

        const canvas = doc.createElement('canvas');
        canvas.style.cssText = [
            'display:block',
            'width:100vw',
            'height:100vh',
            'background:#000',
            'pointer-events:none',
            'user-select:none'
        ].join(';');
        doc.body.appendChild(canvas);
        this.overlayCanvas = canvas;
        this.overlayCtx = canvas.getContext('2d');
        this.overlayCtx.imageSmoothingEnabled = true;
        this.overlayCtx.imageSmoothingQuality = 'high';
        this.resizeOverlayCanvas(this.size);

        overlay.addEventListener('beforeunload', () => {
            if (!this.closingOverlay) {
                this.onOverlayClosed();
            }
        }, {once: true});
    }

    resizeOverlayCanvas(size) {
        if (!this.overlayCanvas) return;
        this.overlayCanvas.width = size;
        this.overlayCanvas.height = size + this.getInfoBarHeight(size);
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

    async stop() {
        this.lifecycleGeneration++;
        await this.releaseWindowControls();

        if (this.overlayWindow) {
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
        this.cleanup();
    }

    cleanup() {
        if (this.overlayCloseTimer) {
            clearInterval(this.overlayCloseTimer);
            this.overlayCloseTimer = null;
        }
        this.overlayWindow = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.mode = null;
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
        if (!this.overlayCtx || !this.overlayCanvas || !this.canvasManager) return;

        const canvases = this.canvasManager.canvases || this.canvasManager.getAllCanvases();
        const {mapCanvas, drawCanvas, ourPlayerCanvas, uiCanvas} = canvases;

        const sourceSize = mapCanvas?.width || this.size;
        const infoBarHeight = this.getInfoBarHeight(sourceSize);
        if (this.overlayCanvas.width !== sourceSize || this.overlayCanvas.height !== sourceSize + infoBarHeight) {
            this.resizeOverlayCanvas(sourceSize);
            this.size = sourceSize;
        }

        const ctx = this.overlayCtx;
        ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

        if (mapCanvas) ctx.drawImage(mapCanvas, 0, 0);
        if (drawCanvas) ctx.drawImage(drawCanvas, 0, 0);
        if (ourPlayerCanvas) ctx.drawImage(ourPlayerCanvas, 0, 0);
        if (uiCanvas) ctx.drawImage(uiCanvas, 0, 0);
        this.drawCoordinateBar(ctx, sourceSize, infoBarHeight);
    }

    getInfoBarHeight(sourceSize) {
        return Math.max(
            INFO_BAR_MIN_HEIGHT,
            Math.min(INFO_BAR_MAX_HEIGHT, Math.round(sourceSize * INFO_BAR_HEIGHT_RATIO))
        );
    }

    getCoordinateInfo() {
        const mapId = this.radarRenderer?.map?.id ?? window.currentMapId;
        const x = this.radarRenderer?.lpX ?? window.lpX;
        const y = this.radarRenderer?.lpY ?? window.lpY;
        return {
            bounds: zonesDatabase.getZoneBounds(mapId),
            x: Number.isFinite(x) ? x : null,
            y: Number.isFinite(y) ? y : null
        };
    }

    formatCoordinate(value, decimals = 0) {
        if (!Number.isFinite(value)) return '\u2014';
        return value.toFixed(decimals);
    }

    drawCoordinateBar(ctx, sourceSize, height) {
        const top = sourceSize;
        const {bounds, x, y} = this.getCoordinateInfo();
        const minX = this.formatCoordinate(bounds?.min?.[0]);
        const maxX = this.formatCoordinate(bounds?.max?.[0]);
        const minY = this.formatCoordinate(bounds?.min?.[1]);
        const maxY = this.formatCoordinate(bounds?.max?.[1]);
        const playerX = this.formatCoordinate(x, 1);
        const playerY = this.formatCoordinate(y, 1);

        const scale = Math.max(0.72, Math.min(1, sourceSize / 500));
        const fontSize = Math.max(9, Math.round(12 * scale));
        const firstLineY = top + Math.round(height * 0.32);
        const secondLineY = top + Math.round(height * 0.72);

        ctx.save();
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, top, sourceSize, height);
        ctx.fillStyle = '#334155';
        ctx.fillRect(0, top, sourceSize, 1);
        ctx.font = `600 ${fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`LOCATION   X ${minX}\u2026${maxX}   Y ${minY}\u2026${maxY}`, sourceSize / 2, firstLineY);
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(`PLAYER     X ${playerX}   Y ${playerY}`, sourceSize / 2, secondLineY);
        ctx.restore();
    }

    dispatchStatusEvent(status) {
        document.dispatchEvent(new CustomEvent('pipStatusChange', {
            detail: {status, isActive: this.isActive}
        }));
    }

    destroy() {
        this.lifecycleGeneration++;
        void this.releaseWindowControls();
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

        this.canvasManager = null;
        this.radarRenderer = null;
        this.windowControlSupported = false;
    }

    isSupported() {
        return this.windowControlSupported;
    }
}

const pictureInPictureManager = new PictureInPictureManager();
export default pictureInPictureManager;
