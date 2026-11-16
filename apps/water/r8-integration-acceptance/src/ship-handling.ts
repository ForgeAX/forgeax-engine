export interface ShipHandling {
  thrustAccelerationMps2: number;
  reverseRatio: number;
  boostMultiplier: number;
  throttleResponseSeconds: number;
  rudderResponseSeconds: number;
  turnAccelerationRadps2: number;
  rudderReferenceSpeedMps: number;
  lateralResistancePerSecond: number;
}

export const DEFAULT_SHIP_HANDLING: ShipHandling = {
  thrustAccelerationMps2: 1.2,
  reverseRatio: 0.45,
  boostMultiplier: 1.8,
  throttleResponseSeconds: 1.8,
  rudderResponseSeconds: 0.7,
  turnAccelerationRadps2: 0.16,
  rudderReferenceSpeedMps: 4,
  lateralResistancePerSecond: 0.6,
};

/** Native integration owns velocity and pose; this controller only requests acceleration. */
export function stepShipHelm(
  state: { throttle: number; rudder: number },
  input: { throttle: number; rudder: number; boost: boolean },
  deltaSeconds: number,
  forwardSpeedMps: number,
  handling: ShipHandling,
) {
  const blend = (seconds: number) => 1 - Math.exp(-deltaSeconds / Math.max(0.01, seconds));
  state.throttle += (input.throttle - state.throttle) * blend(handling.throttleResponseSeconds);
  state.rudder += (input.rudder - state.rudder) * blend(handling.rudderResponseSeconds);
  const thrust =
    state.throttle *
    handling.thrustAccelerationMps2 *
    (state.throttle < 0 ? handling.reverseRatio : 1) *
    (input.boost ? handling.boostMultiplier : 1);
  const authority = Math.min(
    1,
    Math.abs(forwardSpeedMps) / Math.max(0.1, handling.rudderReferenceSpeedMps),
  );
  return {
    thrustAccelerationMps2: thrust,
    yawAccelerationRadps2:
      state.rudder *
      handling.turnAccelerationRadps2 *
      authority *
      (forwardSpeedMps < -0.1 ? -1 : 1),
  };
}

const HELM_CODES = [
  'KeyW',
  'ArrowUp',
  'KeyS',
  'ArrowDown',
  'KeyA',
  'ArrowLeft',
  'KeyD',
  'ArrowRight',
  'Space',
] as const;

/** Releasing focus requires a new key edge; held browser keys cannot resume the helm. */
export function readShipHelmInput(
  keyboard: { downCode(code: string): boolean; justPressedCode(code: string): boolean },
  focused: boolean,
  released: Set<string>,
) {
  for (const code of HELM_CODES) {
    if (!focused && keyboard.downCode(code)) released.add(code);
    if (!keyboard.downCode(code) || (focused && keyboard.justPressedCode(code)))
      released.delete(code);
  }
  const held = (code: string) => focused && !released.has(code) && keyboard.downCode(code);
  return {
    throttle: Number(held('KeyW') || held('ArrowUp')) - Number(held('KeyS') || held('ArrowDown')),
    rudder: Number(held('KeyA') || held('ArrowLeft')) - Number(held('KeyD') || held('ArrowRight')),
    boost: held('Space'),
  };
}
