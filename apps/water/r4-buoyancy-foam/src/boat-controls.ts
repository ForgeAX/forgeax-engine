import type { PhysicsWorld } from '@forgeax/engine/physics';
import { rotateWaterVector } from '@forgeax/engine/water';

/** Demo-authored motor, rudder and offset cargo; the native solver owns all motion. */
export function applyBoatControls(
  physics: PhysicsWorld,
  entity: number,
  input: {
    readonly throttle: number;
    readonly steering: number;
    readonly cargoKg: number;
    readonly cargoPositionM: readonly [number, number, number];
  },
) {
  if ((!input.throttle && !input.steering && !input.cargoKg) || !physics.hasBody(entity)) return;
  const dynamics = physics.getCommittedBodyDynamics?.(entity).unwrap();
  if (!dynamics || !physics.applyBodyForceAtPoint)
    throw new Error('Boat controls require native fixed-step dynamics and point forces');
  const forward = rotateWaterVector(dynamics.rotation, [1, 0, 0]);
  const side = rotateWaterVector(dynamics.rotation, [0, 0, 1]);
  const speed = dynamics.linearVelocityMps.reduce(
    (sum, value, index) => sum + value * (forward[index] ?? 0),
    0,
  );
  const stern = rotateWaterVector(dynamics.rotation, [-1.6, 0, 0]);
  const rudderN = -input.steering * dynamics.massKg * Math.min(3, Math.abs(speed)) * 0.35;
  const motorN = input.throttle * 250;
  const point = stern.map((value, index) => value + (dynamics.positionM[index] ?? 0)) as [
    number,
    number,
    number,
  ];
  const force = forward.map((value, index) => value * motorN + (side[index] ?? 0) * rudderN) as [
    number,
    number,
    number,
  ];
  const fence = { entity, generation: dynamics.generation, fixedStep: dynamics.nextFixedStep };
  if (motorN || rudderN)
    physics.applyBodyForceAtPoint({ ...fence, pointM: point, forceN: force }).unwrap();
  if (input.cargoKg > 0) {
    const offset = rotateWaterVector(dynamics.rotation, input.cargoPositionM);
    const weight = Array.from(physics.getGravity(), (value) => value * input.cargoKg) as [
      number,
      number,
      number,
    ];
    // RigidBody already supplies total weight at its native COM. Move only the
    // cargo's gravity contribution to the visible load, without counting it twice.
    physics
      .applyBodyForceAtPoint({
        ...fence,
        pointM: offset.map((value, index) => value + (dynamics.positionM[index] ?? 0)) as [
          number,
          number,
          number,
        ],
        forceN: weight,
      })
      .unwrap();
    physics
      .applyBodyForceAtPoint({
        ...fence,
        pointM: dynamics.centerOfMassM,
        forceN: weight.map((value) => -value) as [number, number, number],
      })
      .unwrap();
  }
}
