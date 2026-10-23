import type { RigidBodyType } from '@forgeax/engine-types';

/**
 * Map a Rapier RigidBodyType enum value to the engine's string union for the
 * `controller-requires-kinematic` error detail.
 */
export function rapierBodyTypeToString(
  rapier: { readonly RigidBodyType: { readonly Dynamic: number; readonly Fixed: number } },
  bodyType: number,
): RigidBodyType {
  if (bodyType === rapier.RigidBodyType.Dynamic) return 'dynamic';
  if (bodyType === rapier.RigidBodyType.Fixed) return 'static';
  return 'kinematic';
}

/** Map a derived candidate's body type onto the native enum. */
export function rapierBodyTypeFromString(
  rapier: {
    readonly RigidBodyType: {
      readonly Dynamic: number;
      readonly Fixed: number;
      readonly KinematicPositionBased: number;
    };
  },
  bodyType: RigidBodyType,
): number {
  if (bodyType === 'static') return rapier.RigidBodyType.Fixed;
  if (bodyType === 'kinematic') return rapier.RigidBodyType.KinematicPositionBased;
  return rapier.RigidBodyType.Dynamic;
}
