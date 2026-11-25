import {
  defineComponent,
  ENTITY_NULL_RAW,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { createEntityLookup, type EntityLookup } from '@forgeax/engine-ecs/internal';
import { ChildOf } from './child-of';

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

const hierarchyReaders = new WeakMap<World, EntityLookup>();
const MAX_MOBILITY_ANCESTORS = 64;

/** Nearest current declaration, including the entity itself and up to 64 ancestors. */
export function readInheritedMobility(world: World, entity: EntityHandle): MobilityKind {
  return readDeclarations(world, entity, 0);
}

/** Continue the same bounded hierarchy walk from a row whose columns are already located. */
export function mobilityFromRow(
  world: World,
  kind: number | undefined,
  parent: number | undefined,
): MobilityKind {
  if (kind !== undefined) return mobilityKindFromU32(kind);
  return parent === undefined || parent === ENTITY_NULL_RAW
    ? 'movable'
    : readDeclarations(world, parent as EntityHandle, 1);
}

function readDeclarations(world: World, entity: EntityHandle, start: number): MobilityKind {
  let lookup = hierarchyReaders.get(world);
  if (lookup === undefined) {
    lookup = createEntityLookup(
      world,
      [Mobility, ChildOf],
      [
        [0, 'kind'],
        [1, 'parent'],
      ],
    );
    hierarchyReaders.set(world, lookup);
  }
  let current = entity;
  for (let depth = start; depth <= MAX_MOBILITY_ANCESTORS && lookup.get(current); depth++) {
    const { fields } = lookup.columns;
    const kind = fields[0]?.view[lookup.row];
    if (kind !== undefined) return mobilityKindFromU32(kind);
    const parent = fields[1]?.view[lookup.row];
    if (parent === undefined || parent === ENTITY_NULL_RAW) break;
    current = parent as EntityHandle;
  }
  return 'movable';
}
