import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { attachBrowserInputBackend } from '../browser-backend';
import { createCanvasInputBoundary } from '../canvas-input-boundary';
import { snapshotFromSample } from '../input-snapshot';

describe('browser edge latch (real Chromium)', () => {
  it('publishes a browser acquisition reset without a player release command', async () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const handle = attachBrowserInputBackend(canvas, { pointerLockAllowed: () => false });
    const boundary = createCanvasInputBoundary(handle.backend);
    boundary.grantGame();
    try {
      await userEvent.click(canvas);
      boundary.game.sample();
      await userEvent.keyboard('{e>}');
      const held = snapshotFromSample(boundary.game.sample());
      expect(held.keyboard.downCode('KeyE')).toBe(true);
      // Exercise the actual DOM listener; this is not an OS alt-tab claim.
      window.dispatchEvent(new Event('blur'));
      const raw = boundary.game.sample();
      const reset = snapshotFromSample(raw, undefined, held);
      expect(reset.focused).toBe(raw.focused);
      expect(reset.focusReset).toBe(true);
      expect(reset.keyboard.upCode('KeyE')).toBe(false);
      expect(snapshotFromSample(boundary.game.sample()).focusReset).toBe(false);
      boundary.revokeGame();
      const revoked = snapshotFromSample(boundary.game.sample(), undefined, held);
      expect(revoked.focused).toBe(false);
      expect(revoked.focusReset).toBe(true);
      expect(revoked.keyboard.upCode('KeyE')).toBe(false);
    } finally {
      await userEvent.keyboard('{/e}');
      handle();
      canvas.remove();
    }
  });
  it('reads chord button masks and latches both transitions between browser scans', () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();
    const handle = attachBrowserInputBackend(canvas, { pointerLockAllowed: () => false });
    const dispatch = (type: string, button: number, buttons: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: 'mouse',
          button,
          buttons,
          bubbles: true,
        }),
      );
    try {
      dispatch('pointerdown', 2, 2);
      handle.backend.sample();
      dispatch('pointermove', 0, 3);
      dispatch('pointermove', 0, 2);
      expect(handle.backend.sample()).toMatchObject({
        buttons: [false, false, true],
        pressedButtons: [true, false, false],
        releasedButtons: [true, false, false],
      });
      dispatch('pointerup', 2, 0);
      expect(handle.backend.sample()).toMatchObject({
        buttons: [false, false, false],
        releasedButtons: [false, false, true],
      });
      expect(handle.backend.sample().releasedButtons).toEqual([false, false, false]);
    } finally {
      handle();
      canvas.remove();
    }
  });

  it('keeps trusted low-frequency down/up edges until the next sample', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    canvas.tabIndex = 0;
    document.body.append(canvas);
    const handle = attachBrowserInputBackend(canvas, {
      pointerLockAllowed: () => false,
    });
    try {
      // This is a real Playwright user click. The gate is disabled so the
      // fixture does not request a browser pointer lock as a side effect.
      await userEvent.click(canvas);
      handle.backend.sample();

      // A single user-level key interaction produces both DOM events before
      // the deliberately delayed frame-start sample.
      await userEvent.keyboard('a');
      const sample = handle.backend.sample();
      expect(sample.downKeys.has('a')).toBe(false);
      expect(sample.upKeys.has('a')).toBe(true);
      expect(sample.pressedKeys?.has('a')).toBe(true);
      expect(sample.downCodes?.has('KeyA')).toBe(false);
      expect(sample.upCodes?.has('KeyA')).toBe(true);
      expect(sample.pressedCodes?.has('KeyA')).toBe(true);

      const next = handle.backend.sample();
      expect(next.pressedKeys?.size).toBe(0);
      expect(next.upKeys.size).toBe(0);
      expect(next.pressedCodes?.size).toBe(0);
      expect(next.upCodes?.size).toBe(0);
    } finally {
      handle();
      canvas.remove();
    }
  });
});
