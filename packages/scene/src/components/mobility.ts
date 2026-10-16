import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Author commitment about whether an entity moves.
 *
 * `'static'` promises the Transform never changes after placement,
 * `'stationary'` is legal only on lights (fixed position, changing
 * parameters), and `'movable'` makes no promise. An entity without `Mobility`
 * is movable. `Mobility` is the rendering/baking authority; physics
 * `RigidBodyType` is the simulation authority and neither derives the other.
 */
export type MobilityKind = 'static' | 'stationary' | 'movable';

/** Numeric enum values stored in the `Mobility.kind` column; also its schema labels. */
export const MobilityKindValue = {
  static: 0,
  stationary: 1,
  movable: 2,
} as const satisfies Record<MobilityKind, number>;

/** Narrow a stored `Mobility.kind` column value back to its label. */
export function mobilityKindFromU32(value: number): MobilityKind {
  if (value === MobilityKindValue.static) return 'static';
  if (value === MobilityKindValue.stationary) return 'stationary';
  return 'movable';
}

/**
 * Mobility declaration: `world.spawn({ component: Mobility, data: { kind: MobilityKindValue.static } })`.
 * Absence and the schema default both mean movable.
 */
export const Mobility = defineComponent('Mobility', {
  kind: { type: 'enum', default: MobilityKindValue.movable, labels: MobilityKindValue },
});
