import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import pictureInPictureManager from './PictureInPictureManager.js';
import zonesDatabase from '../data/ZonesDatabase.js';

describe('PictureInPictureManager native window controls', () => {
    beforeEach(() => {
        pictureInPictureManager.isActive = true;
        pictureInPictureManager.windowControlSupported = true;
        pictureInPictureManager.lifecycleGeneration = 0;
        window.settingsSync = {
            getNumber: vi.fn(() => 65),
            get: vi.fn(() => 'top-right'),
            setNumber: vi.fn(),
            set: vi.fn()
        };
        globalThis.fetch = vi.fn(async () => ({ok: true, status: 200}));
    });

    afterEach(() => {
        if (pictureInPictureManager.overlayCloseTimer) {
            clearInterval(pictureInPictureManager.overlayCloseTimer);
        }
        pictureInPictureManager.isActive = false;
        pictureInPictureManager.mode = null;
        pictureInPictureManager.overlayWindow = null;
        pictureInPictureManager.overlayCanvas = null;
        pictureInPictureManager.overlayCtx = null;
        pictureInPictureManager.overlayCloseTimer = null;
        pictureInPictureManager.windowControlSupported = false;
        pictureInPictureManager.radarRenderer = null;
        pictureInPictureManager.canvasManager = null;
        delete window.settingsSync;
        vi.restoreAllMocks();
    });

    test('posts persisted opacity and position to the local backend', async () => {
        const applied = await pictureInPictureManager.applyWindowSettings();

        expect(applied).toBe(true);
        expect(fetch).toHaveBeenCalledWith('/api/pip-window', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({opacity: 65, position: 'top-right', margin: 12})
        });
    });

    test('clamps opacity before saving and applying', async () => {
        const applySpy = vi.spyOn(pictureInPictureManager, 'applyWindowSettings').mockResolvedValue(true);

        await pictureInPictureManager.setWindowOpacity(5);

        expect(window.settingsSync.setNumber).toHaveBeenCalledWith('settingPipOpacity', 20);
        expect(applySpy).toHaveBeenCalledOnce();
    });

    test('does not call the backend when the overlay window is closed', async () => {
        pictureInPictureManager.isActive = false;

        const applied = await pictureInPictureManager.applyWindowSettings();

        expect(applied).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('releases native controls before closing the overlay window', async () => {
        const close = vi.fn();
        pictureInPictureManager.mode = 'overlay';
        pictureInPictureManager.overlayWindow = {close, closed: false};

        await pictureInPictureManager.stop();

        expect(fetch).toHaveBeenCalledWith('/api/pip-window', {method: 'DELETE'});
        expect(close).toHaveBeenCalledOnce();
        expect(fetch.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
        expect(pictureInPictureManager.isActive).toBe(false);
    });

    test('cancels delayed window retries after overlay stops', async () => {
        globalThis.fetch = vi.fn(async () => ({ok: false, status: 409}));
        const applyPromise = pictureInPictureManager.applyWindowSettings({retry: true});
        await Promise.resolve();

        pictureInPictureManager.lifecycleGeneration++;
        pictureInPictureManager.isActive = false;

        expect(await applyPromise).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('reads current player coordinates and location bounds from the renderer', () => {
        pictureInPictureManager.radarRenderer = {
            map: {id: 'test-zone'},
            lpX: 123.456,
            lpY: -78.9
        };
        const boundsSpy = vi.spyOn(zonesDatabase, 'getZoneBounds').mockReturnValue({
            min: [-415, -305],
            max: [415, 295]
        });

        expect(pictureInPictureManager.getCoordinateInfo()).toEqual({
            bounds: {min: [-415, -305], max: [415, 295]},
            x: 123.456,
            y: -78.9
        });
        expect(boundsSpy).toHaveBeenCalledWith('test-zone');
    });

    test('adds a compact information bar below the square radar frame', () => {
        expect(pictureInPictureManager.getInfoBarHeight(300)).toBe(38);
        expect(pictureInPictureManager.getInfoBarHeight(500)).toBe(50);
        expect(pictureInPictureManager.getInfoBarHeight(800)).toBe(56);
    });

    test('composites radar layers directly into the overlay canvas', () => {
        const drawImage = vi.fn();
        const clearRect = vi.fn();
        pictureInPictureManager.overlayCanvas = {width: 500, height: 550};
        pictureInPictureManager.overlayCtx = {clearRect, drawImage};
        pictureInPictureManager.canvasManager = {
            canvases: {
                mapCanvas: {width: 500},
                drawCanvas: {},
                ourPlayerCanvas: {},
                uiCanvas: {}
            }
        };
        const barSpy = vi.spyOn(pictureInPictureManager, 'drawCoordinateBar').mockImplementation(() => {});

        pictureInPictureManager.compositeFrame();

        expect(clearRect).toHaveBeenCalledWith(0, 0, 500, 550);
        expect(drawImage).toHaveBeenCalledTimes(4);
        expect(barSpy).toHaveBeenCalledWith(pictureInPictureManager.overlayCtx, 500, 50);
    });

    test('does not expose browser Picture-in-Picture as a fallback', () => {
        pictureInPictureManager.windowControlSupported = false;
        const originalValue = document.pictureInPictureEnabled;
        Object.defineProperty(document, 'pictureInPictureEnabled', {
            configurable: true,
            value: true
        });

        expect(pictureInPictureManager.isSupported()).toBe(false);

        Object.defineProperty(document, 'pictureInPictureEnabled', {
            configurable: true,
            value: originalValue
        });
    });
});
