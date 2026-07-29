import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import pictureInPictureManager from './PictureInPictureManager.js';

describe('PictureInPictureManager native window controls', () => {
    beforeEach(() => {
        pictureInPictureManager.isActive = true;
        pictureInPictureManager.windowControlSupported = true;
        window.settingsSync = {
            getNumber: vi.fn(() => 65),
            get: vi.fn(() => 'top-right'),
            setNumber: vi.fn(),
            set: vi.fn()
        };
        globalThis.fetch = vi.fn(async () => ({ok: true, status: 200}));
    });

    afterEach(() => {
        pictureInPictureManager.isActive = false;
        pictureInPictureManager.windowControlSupported = false;
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
});
