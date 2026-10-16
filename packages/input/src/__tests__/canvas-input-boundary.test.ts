import { describe, expect, it } from 'vitest';
import { createCanvasInputBoundary } from '../canvas-input-boundary';
import {
  createEmptyInputBackendSample,
  type InputBackend,
  type InputBackendSample,
} from '../input-snapshot';

function sample(keys: readonly string[] = []): InputBackendSample {
  return {
    downKeys: new Set(keys),
    upKeys: new Set(),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
  };
}

describe('CanvasInputBoundary', () => {
  it('derives inactive consumers from the input empty-sample owner', () => {
    const source: InputBackend = { sample: () => sample(['w']), detach() {} };
    const boundary = createCanvasInputBoundary(source);

    expect(boundary.game.sample()).toEqual(createEmptyInputBackendSample());
  });

  it('routes each browser frame only to the leased consumer', () => {
    const source: InputBackend = { sample: () => sample(['w']), detach() {} };
    const boundary = createCanvasInputBoundary(source);

    expect(boundary.editor.sample().downKeys.has('w')).toBe(true);
    expect(boundary.game.sample().downKeys.has('w')).toBe(false);

    boundary.grantGame();
    expect(boundary.editor.sample().downKeys.has('w')).toBe(false);
    expect(boundary.game.sample().downKeys.has('w')).toBe(true);
  });

  it('clears source state and pointer lock for every revocation', () => {
    let clears = 0;
    const locks: boolean[] = [];
    const source: InputBackend = {
      sample: () => sample(['w']),
      clear: () => {
        clears++;
      },
      setPointerLockAllowed: (allowed) => {
        locks.push(allowed);
      },
      detach() {},
    };
    const boundary = createCanvasInputBoundary(source);
    boundary.grantGame();
    boundary.revokeGame();
    boundary.revokeGame();

    expect(boundary.owner()).toBe('editor');
    expect(clears).toBe(3);
    expect(locks.filter((allowed) => !allowed).length).toBeGreaterThanOrEqual(3);
    expect(boundary.game.sample().downKeys.size).toBe(0);
  });
});
