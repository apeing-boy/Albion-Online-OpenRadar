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
        pictureInPictureManager.overlayVideo = null;
        pictureInPictureManager.overlayCloseTimer = null;
        pictureInPictureManager.windowControlSupported = false;
        pictureInPictureManager.radarRenderer = null;
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

    test('does not call the backend when the PiP window is closed', async () => {
        pictureInPictureManager.isActive = false;

        const applied = await pictureInPictureManager.applyWindowSettings();

        expect(applied).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('releases native controls before closing PiP', async () => {
        const exitPictureInPicture = vi.fn(async () => {});
        Object.defineProperty(document, 'pictureInPictureElement', {
            configurable: true,
            value: {}
        });
        Object.defineProperty(document, 'exitPictureInPicture', {
            configurable: true,
            value: exitPictureInPicture
        });

        await pictureInPictureManager.stop();

        expect(fetch).toHaveBeenCalledWith('/api/pip-window', {method: 'DELETE'});
        expect(exitPictureInPicture).toHaveBeenCalledOnce();
        expect(fetch.mock.invocationCallOrder[0]).toBeLessThan(
            exitPictureInPicture.mock.invocationCallOrder[0]
        );
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

    test('cancels delayed window retries after PiP stops', async () => {
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
});
