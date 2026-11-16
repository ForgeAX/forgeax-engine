import type { PhysicsSolverClock } from '@forgeax/engine/physics';
import { type Vec3, WaterQueryFlags, type WaterSystem } from '@forgeax/engine/water';
import type { WaterEntryCollision } from '../assets/entry-splash';

/** Surface attachment belongs to the short-lived effect, independently of the retired iron ball. */
export interface WaterEntryAttachment {
  readonly collision: WaterEntryCollision;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly startedAtSeconds: number;
  readonly timeScale: number;
  previousSample?: { readonly timeSeconds: number; readonly heightM: number };
}

export function sampleWaterEntryAttachment(
  water: WaterSystem,
  attachment: WaterEntryAttachment,
  timeSeconds: number,
  clock: PhysicsSolverClock | undefined,
) {
  const { collision } = attachment;
  const normalLength = Math.hypot(...collision.surfaceNormal);
  const normal = collision.surfaceNormal.map((value) => value / Math.max(normalLength, 1e-6));
  const normalSpeed = collision.entryVelocity.reduce(
    (sum, value, axis) => sum + value * (normal[axis] ?? 0),
    0,
  );
  const age = Math.max(0, timeSeconds - attachment.startedAtSeconds) * attachment.timeScale;
  const positionM: Vec3 = [
    (collision.entryPosition[0] ?? 0) +
      ((collision.entryVelocity[0] ?? 0) - (normal[0] ?? 0) * normalSpeed) * 0.08 * age,
    collision.entryPosition[1] ?? 0,
    (collision.entryPosition[2] ?? 0) +
      ((collision.entryVelocity[2] ?? 0) - (normal[2] ?? 0) * normalSpeed) * 0.08 * age,
  ];
  water
    .oceanPatch()
    ?.requestQueryRegion(attachment.bodyGuid, attachment.bodyGeneration, [positionM]);
  const queried = water.queryBody(attachment.bodyGuid, {
    positionM,
    expectedBodyGeneration: attachment.bodyGeneration,
    timeSeconds,
    ...(clock
      ? {
          nativePhysics: {
            completedStep: clock.completedStep,
            timeSeconds: clock.simulationTimeSeconds,
          },
        }
      : {}),
    flags: WaterQueryFlags.ComputeLocation | WaterQueryFlags.IncludeWaves,
  });
  if (!queried.ok || queried.value.excluded || !queried.value.surfaceM) return undefined;
  const heightM = queried.value.surfaceM[1];
  const previous = attachment.previousSample;
  const delta = previous ? (timeSeconds - previous.timeSeconds) * attachment.timeScale : 0;
  const velocity = previous && delta > 0 ? (heightM - previous.heightM) / delta : 0;
  attachment.previousSample = { timeSeconds, heightM };
  return {
    surfaceOffsetM: [0, heightM - positionM[1], 0] as const,
    surfaceVelocityMps: [0, velocity, 0] as const,
  };
}
