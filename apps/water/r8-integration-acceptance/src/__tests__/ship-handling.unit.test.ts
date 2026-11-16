import { describe, expect, it } from 'vitest';
import { shipPontoonLayout } from '../quality-presets';
import { DEFAULT_SHIP_HANDLING, readShipHelmInput, stepShipHelm } from '../ship-handling';

describe('native ship helm commands', () => {
  it('builds thrust gradually, releases toward zero and preserves a speed-dependent reversible rudder', () => {
    const state = { throttle: 0, rudder: 0 };
    const command = stepShipHelm(
      state,
      { throttle: 1, rudder: 1, boost: false },
      1 / 60,
      0,
      DEFAULT_SHIP_HANDLING,
    );
    expect(command.thrustAccelerationMps2).toBeGreaterThan(0);
    expect(command.thrustAccelerationMps2).toBeLessThan(0.02);
    expect(command.yawAccelerationRadps2).toBe(0);
    for (let index = 0; index < 300; index++)
      stepShipHelm(
        state,
        { throttle: 1, rudder: 1, boost: false },
        1 / 60,
        4,
        DEFAULT_SHIP_HANDLING,
      );
    const forward = stepShipHelm(
      { ...state },
      { throttle: 1, rudder: 1, boost: false },
      1 / 60,
      4,
      DEFAULT_SHIP_HANDLING,
    );
    const reverse = stepShipHelm(
      { ...state },
      { throttle: 1, rudder: 1, boost: false },
      1 / 60,
      -4,
      DEFAULT_SHIP_HANDLING,
    );
    expect(reverse.yawAccelerationRadps2).toBeCloseTo(-forward.yawAccelerationRadps2);
    const boosted = stepShipHelm(
      { ...state },
      { throttle: 1, rudder: 1, boost: true },
      1 / 60,
      4,
      DEFAULT_SHIP_HANDLING,
    );
    expect(boosted.thrustAccelerationMps2).toBeCloseTo(
      forward.thrustAccelerationMps2 * DEFAULT_SHIP_HANDLING.boostMultiplier,
    );
    const released = stepShipHelm(
      state,
      { throttle: 0, rudder: 0, boost: false },
      1 / 60,
      4,
      DEFAULT_SHIP_HANDLING,
    );
    expect(released.thrustAccelerationMps2).toBeGreaterThan(0);
    expect(released.thrustAccelerationMps2).toBeLessThan(forward.thrustAccelerationMps2);
  });
  it.each([
    4, 8, 16, 32,
  ])('retains the calibrated support radius for %i weighted hull probes', (count) => {
    const layout = shipPontoonLayout(count);
    expect(layout.radiiM).toEqual(Array(count).fill(1.5));
    expect(layout.anchorsM).toHaveLength(count * 3);
    expect(layout.velocityPontoonIndex).toBeLessThan(count);
  });
  it.each([0, 3, 33, 64, 4.5])('rejects unsupported probe counts %i', (count) => {
    expect(() => shipPontoonLayout(count)).toThrow();
  });
});

describe('helm focus release', () => {
  it('does not resume a held thrust/boost after UI focus until a new press', () => {
    const held = new Set(['KeyW', 'Space']);
    let pressed = false;
    const keyboard = { downCode: (code: string) => held.has(code), justPressedCode: () => pressed };
    const released = new Set<string>();
    expect(readShipHelmInput(keyboard, true, released)).toMatchObject({ throttle: 1, boost: true });
    expect(readShipHelmInput(keyboard, false, released)).toMatchObject({
      throttle: 0,
      boost: false,
    });
    expect(readShipHelmInput(keyboard, true, released)).toMatchObject({
      throttle: 0,
      boost: false,
    });
    pressed = true;
    expect(readShipHelmInput(keyboard, true, released)).toMatchObject({ throttle: 1, boost: true });
  });
});
