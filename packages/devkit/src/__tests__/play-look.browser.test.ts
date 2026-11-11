import { afterEach, expect, it } from 'vitest';
// The input backend source, so the test reads movement the way a game does.
import { attachBrowserInputBackend } from '../../../input/src/browser-backend';
import { lookInPage } from '../play-look';

afterEach(() => {
  Reflect.deleteProperty(document, 'pointerLockElement');
  document.body.replaceChildren();
});

it('delivers a pointer-locked look delta as the movement the game reads', () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const handle = attachBrowserInputBackend(canvas);
  try {
    expect(lookInPage({ dx: 100, dy: 0 })).toBe(false);
    expect(handle.backend.sample()).toMatchObject({ movementX: 0, movementY: 0 });
    // Headless Chromium grants no real lock; the locked element is all the helper reads.
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, value: canvas });
    expect(lookInPage({ dx: 100, dy: 0 })).toBe(true);
    expect(handle.backend.sample()).toMatchObject({ movementX: 100, movementY: 0 });
    expect(lookInPage({ dx: -12.5, dy: 7 })).toBe(true);
    expect(handle.backend.sample()).toMatchObject({ movementX: -12.5, movementY: 7 });
  } finally {
    handle();
  }
});
