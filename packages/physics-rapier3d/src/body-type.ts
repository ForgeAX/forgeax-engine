/**
 * Map a Rapier RigidBodyType enum value to the engine's string union for the
 * `controller-requires-kinematic` error detail.
 */
export function rapierBodyTypeToString(
  rapier: { readonly RigidBodyType: { readonly Dynamic: number; readonly Fixed: number } },
  bodyType: number,
): 'static' | 'dynamic' | 'kinematic' {
  if (bodyType === rapier.RigidBodyType.Dynamic) return 'dynamic';
  if (bodyType === rapier.RigidBodyType.Fixed) return 'static';
  return 'kinematic';
}
