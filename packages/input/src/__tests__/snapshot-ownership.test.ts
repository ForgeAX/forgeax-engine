import { describe, expect, it } from 'vitest';
import { deriveActionStates } from '../action-state';
import { createEmptyInputBackendSample, snapshotFromSample } from '../input-snapshot';

describe('frame snapshot ownership', () => {
  it('owns device collections, gesture events and action values at construction', () => {
    const pressed = new Set([0]);
    const buttonValues = new Map([[0, 0.75]]);
    const axes: [number, number, number, number] = [0.4, 0, 0, 0];
    const gamepad = {
      index: 0,
      standardMapping: true,
      pressed,
      justPressed: pressed,
      justReleased: new Set<number>(),
      buttonValues,
      axes,
    };
    const pointer = {
      pointerId: 2,
      pointerType: 'touch' as const,
      x: 5,
      y: 6,
      pressure: 1,
      active: true,
      delta: { x: 1, y: 2 },
    };
    const pointerEvent = {
      pointerId: 2,
      pointerType: 'touch' as const,
      phase: 'down' as const,
      x: 5,
      y: 6,
      pressure: 1,
    };
    const pointerIds: [number, number] = [2, 3];
    const gestureEvent = {
      kind: 'pinch-begin' as const,
      pointerIds,
      pointerType: 'touch' as const,
      timestamp: 7,
    };
    const gestures = { pinchScale: 1.5, rotationAngle: 0.2 };
    const virtualAxis = { name: 'move', x: 0.5, y: 0.6 };
    const sample = {
      ...createEmptyInputBackendSample(),
      gamepads: [gamepad],
      pointers: [pointer],
      pointerEvents: [pointerEvent],
      gestureEvents: [gestureEvent],
      gestures,
      capabilities: { gamepad: true, pointer: true },
      virtualAxes: [virtualAxis],
    };
    const states = deriveActionStates(sample, [
      { action: 'move', bindings: [{ type: 'gamepadButton', button: 0 }] },
    ]);
    const snapshot = snapshotFromSample(sample, states);
    const before = snapshot.gamepad(0);
    pressed.clear();
    buttonValues.clear();
    axes.fill(0);
    pointer.x = 99;
    pointer.delta.x = 99;
    sample.pointers.length = 0;
    pointerEvent.x = 99;
    sample.pointerEvents.length = 0;
    pointerIds[0] = 99;
    gestureEvent.timestamp = 99;
    sample.gestureEvents.length = 0;
    gestures.pinchScale = 99;
    virtualAxis.x = 99;
    sample.capabilities.gamepad = false;
    const action = states[0];
    if (action === undefined) throw new Error('expected action');
    Object.assign(action, { pressed: false, strength: 0, raw: 0 });
    states.length = 0;
    expect([before.button(0), snapshot.gamepad(0).button(0)]).toEqual([true, true]);
    expect(snapshot.gamepad(0).buttonValue(0)).toBe(0.75);
    expect(snapshot.gamepad(0).axis(0)).toBe(0.4);
    expect(snapshot.pointer(2)).toMatchObject({ x: 5, delta: { x: 1 } });
    expect(snapshot.pointerEvents).toMatchObject([{ x: 5 }]);
    expect(snapshot.gestureEvents).toMatchObject([{ pointerIds: [2, 3], timestamp: 7 }]);
    expect(snapshot.gesture.pinchScale).toBe(1.5);
    expect(snapshot.virtualAxis('move').x).toBe(0.5);
    expect(snapshot.capabilities.gamepad).toBe(true);
    expect(snapshot.action('move').isPressed()).toBe(true);
    expect(snapshot.getAxis('none', 'move')).toBe(1);
    expect(snapshot.getVector('none', 'move', 'up', 'down').x).toBe(1);
  });
});
