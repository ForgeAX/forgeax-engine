import { type InputBackendSample, snapshotFromSample } from '@forgeax/engine-input';
import { describe, expect, it } from 'vitest';

describe('Host to Engine input boundary', () => {
  it('reconstructs the existing InputSnapshot from one structured-cloneable sample', () => {
    const sample: InputBackendSample = {
      downKeys: new Set(['w']),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 4,
      movementY: -2,
      wheelDelta: 1,
      focused: true,
      pointerLocked: true,
    };
    const clone = structuredClone(sample);
    const snapshot = snapshotFromSample(clone);
    expect(snapshot.keyboard.down('w')).toBe(true);
    expect(snapshot.mouse.movementDelta).toEqual({ x: 4, y: -2 });
    expect(clone).not.toHaveProperty('window');
    expect(clone).not.toHaveProperty('document');
  });
});
