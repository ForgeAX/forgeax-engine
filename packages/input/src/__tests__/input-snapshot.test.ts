import { describe, expect, it } from 'vitest';

import {
  createEmptyInputBackendSample,
  type InputBackendSample,
  snapshotFromSample,
} from '../input-snapshot';

function sample(
  downKeys: string[],
  upKeys: string[] = [],
  downCodes: string[] = [],
  upCodes: string[] = [],
): InputBackendSample {
  return {
    downKeys: new Set(downKeys),
    upKeys: new Set(upKeys),
    downCodes: new Set(downCodes),
    upCodes: new Set(upCodes),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
  };
}

describe('keyboard snapshot edges', () => {
  it('derives justPressed from the previous frozen snapshot', () => {
    const first = snapshotFromSample(sample(['a']));
    const held = snapshotFromSample(sample(['a']), undefined, first);
    const released = snapshotFromSample(sample([], ['a']), undefined, held);

    expect(first.keyboard.down('a')).toBe(true);
    expect(first.keyboard.justPressed('a')).toBe(true);
    expect(held.keyboard.justPressed('a')).toBe(false);
    expect(released.keyboard.down('a')).toBe(false);
    expect(released.keyboard.up('a')).toBe(true);
  });

  it('keeps code-like and logical key strings as independent read points', () => {
    const snap = snapshotFromSample(sample(['?'], [], ['KeyA']));

    expect(snap.keyboard.down('?')).toBe(true);
    expect(snap.keyboard.justPressed('?')).toBe(true);
    expect(snap.keyboard.downCode('KeyA')).toBe(true);
    expect(snap.keyboard.justPressedCode('KeyA')).toBe(true);
  });

  it('uses producer-latched press edges even when held state is already released', () => {
    const snap = snapshotFromSample({
      ...sample([], ['a'], [], ['KeyA']),
      pressedKeys: new Set(['a']),
      pressedCodes: new Set(['KeyA']),
    });

    expect(snap.keyboard.down('a')).toBe(false);
    expect(snap.keyboard.up('a')).toBe(true);
    expect(snap.keyboard.justPressed('a')).toBe(true);
    expect(snap.keyboard.downCode('KeyA')).toBe(false);
    expect(snap.keyboard.upCode('KeyA')).toBe(true);
    expect(snap.keyboard.justPressedCode('KeyA')).toBe(true);

    const next = snapshotFromSample(sample([]), undefined, snap);
    expect(next.keyboard.justPressed('a')).toBe(false);
    expect(next.keyboard.up('a')).toBe(false);
  });
});

describe('empty backend sample ownership', () => {
  it('keeps the neutral sample owner out of the public root', async () => {
    const root = (await import('../index')) as Record<string, unknown>;
    const empty = createEmptyInputBackendSample();

    expect(root).not.toHaveProperty('createEmptyInputBackendSample');
    expect(empty.downKeys.size).toBe(0);
    expect(empty.upKeys.size).toBe(0);
    expect(empty.buttons).toEqual([false, false, false]);
    expect(empty.movementX).toBe(0);
    expect(empty.movementY).toBe(0);
    expect(empty.wheelDelta).toBe(0);
    expect(empty.focused).toBe(true);
    expect(empty.pointerLocked).toBe(false);
  });
});

describe('mouse snapshot edges', () => {
  it('derives primary-button held, press, and release edges from snapshots', () => {
    const first = snapshotFromSample({
      ...sample([]),
      buttons: [true, false, false],
    });
    const held = snapshotFromSample(
      { ...sample([]), buttons: [true, false, false] },
      undefined,
      first,
    );
    const released = snapshotFromSample(
      { ...sample([]), buttons: [false, false, false] },
      undefined,
      held,
    );

    expect(first.mouse.button(0)).toBe(true);
    expect(first.mouse.justPressed(0)).toBe(true);
    expect(first.mouse.justReleased(0)).toBe(false);
    expect(held.mouse.justPressed(0)).toBe(false);
    expect(held.mouse.justReleased(0)).toBe(false);
    expect(released.mouse.button(0)).toBe(false);
    expect(released.mouse.justReleased(0)).toBe(true);
  });

  it('preserves a producer-latched button tap between frame-start scans', () => {
    const tap = snapshotFromSample({
      ...sample([]),
      pressedButtons: [true, false, false],
      releasedButtons: [true, false, false],
    });

    expect(tap.mouse.button(0)).toBe(false);
    expect(tap.mouse.justPressed(0)).toBe(true);
    expect(tap.mouse.justReleased(0)).toBe(true);

    const next = snapshotFromSample(sample([]), undefined, tap);
    expect(next.mouse.justPressed(0)).toBe(false);
    expect(next.mouse.justReleased(0)).toBe(false);
  });
});
