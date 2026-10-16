import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { attachBrowserInputBackend } from '../browser-backend';

describe('pointer lock recovery (real Chromium)', () => {
  it('keeps pre-lock cursor movement out of the first provider-locked scan', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    document.body.append(canvas);
    let requests = 0;
    const handle = attachBrowserInputBackend(canvas, {
      lockProvider: {
        requestLock: () => {
          requests += 1;
        },
        exitLock: () => {},
      },
    });
    const move = (x: number, y: number) => {
      const event = new PointerEvent('pointermove', {
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
      });
      Object.defineProperties(event, { movementX: { value: x }, movementY: { value: y } });
      canvas.dispatchEvent(event);
    };
    try {
      move(-480, -266);
      await userEvent.click(canvas);
      expect(requests).toBe(1);
      move(8, 2);
      expect(handle.backend.sample()).toMatchObject({
        pointerLocked: true,
        movementX: 8,
        movementY: 2,
      });
    } finally {
      handle();
      canvas.remove();
    }
  });

  it('attempts a trusted click even when hasFocus is false and contains rejection/error events', async () => {
    const canvas = document.createElement('canvas');
    canvas.dataset.testid = 'pointer-lock-target';
    document.body.append(canvas);
    const originalFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    const originalRequest = Object.getOwnPropertyDescriptor(canvas, 'requestPointerLock');
    const errors: Array<{ path: 'w3c' | 'provider'; cause: unknown }> = [];
    const unhandled: unknown[] = [];
    let requestCalls = 0;
    const rejection = new DOMException('Pointer lock denied', 'NotAllowedError');
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(canvas, 'requestPointerLock', {
      configurable: true,
      value: () => {
        requestCalls += 1;
        return Promise.reject(rejection);
      },
    });
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      event.preventDefault();
      unhandled.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    const handle = attachBrowserInputBackend(canvas, {
      onLockError: (detail) => errors.push(detail),
    });
    try {
      // userEvent delegates to Playwright's locator click, preserving the
      // trusted user-activation boundary required by Pointer Lock.
      await userEvent.click(canvas);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requestCalls).toBe(1);
      expect(errors[0]).toMatchObject({ path: 'w3c', cause: rejection });
      expect(unhandled).toEqual([]);

      const browserEvent = new Event('pointerlockerror');
      document.dispatchEvent(browserEvent);
      expect(errors[1]).toMatchObject({ path: 'w3c', cause: browserEvent });
      expect(handle.backend.sample().pointerLocked).toBe(false);
    } finally {
      handle();
      window.removeEventListener('unhandledrejection', onUnhandled);
      if (originalFocus === undefined) delete (document as { hasFocus?: unknown }).hasFocus;
      else Object.defineProperty(document, 'hasFocus', originalFocus);
      if (originalRequest === undefined)
        delete (canvas as { requestPointerLock?: unknown }).requestPointerLock;
      else Object.defineProperty(canvas, 'requestPointerLock', originalRequest);
      canvas.remove();
    }
  });
});
