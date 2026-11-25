import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  createStateProjection,
  readComponentMutationEpoch,
  type StateProjection,
} from '@forgeax/engine-ecs/projection';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { unpackSlot } from '@forgeax/engine-types';
import { MESH_DRAW_PARAMETER_FLOATS, MeshDrawParameters } from '../components/mesh-draw-parameters';

export interface PublishedDrawParameters {
  readonly entities: Uint32Array;
  readonly values: Float32Array;
  readonly removed: Uint32Array;
}

/** The publisher owns these three views and relinquishes their common backing on send. */
export class OwnedDrawParameterColumns implements PublishedDrawParameters {
  readonly entities: Uint32Array<ArrayBuffer>;
  readonly values: Float32Array<ArrayBuffer>;
  readonly removed: Uint32Array<ArrayBuffer>;

  constructor(count: number, removed: number) {
    const words = count * MESH_DRAW_PARAMETER_FLOATS;
    const backing = new ArrayBuffer(4 * (count + words + removed));
    this.entities = new Uint32Array(backing, 0, count);
    this.values = new Float32Array(backing, 4 * count, words);
    this.removed = new Uint32Array(backing, 4 * (count + words), removed);
  }
}

type Row = readonly number[];

export function drawParameterComponent(world: World): typeof MeshDrawParameters | undefined {
  const component = world.components.resolve(MeshDrawParameters.name) as
    | typeof MeshDrawParameters
    | undefined;
  if (component === undefined || readComponentMutationEpoch(world, component) === 0)
    return undefined;
  return component;
}

const PARAMETER_FIELDS = ['x', 'y', 'z', 'w', 'extraX', 'extraY', 'extraZ', 'extraW'] as const;

/** A missing first scalar is an ordinary non-owner. Native recording supplies its
 * synchronous destination; an unbound caller receives its own retained value. */
export function readDrawParameters(
  world: World,
  component: typeof MeshDrawParameters,
  entity: EntityHandle,
  into?: number[],
): Row | undefined {
  const read = world[worldRead].getFieldValue;
  const first = read(entity, component, 'x');
  if (first === undefined) return undefined;
  const values = into ?? new Array<number>(MESH_DRAW_PARAMETER_FLOATS);
  if (values.length > MESH_DRAW_PARAMETER_FLOATS) values.length = MESH_DRAW_PARAMETER_FLOATS;
  values[0] = first;
  for (let i = 1; i < PARAMETER_FIELDS.length; i++)
    values[i] = read(entity, component, PARAMETER_FIELDS[i] as string) as number;
  return values;
}

function sameParameterValues(a: Row, b: Row): boolean {
  for (let i = 0; i < MESH_DRAW_PARAMETER_FLOATS; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Capture only this channel's writes. Ordinary renderable templates never observe it. */
export class DrawParameterPublisher {
  private readonly projection: StateProjection;
  private readonly scratch = new Array<number>(MESH_DRAW_PARAMETER_FLOATS);
  private readonly accepted = new Map<number, { entity: number; values: Row }>();

  constructor(
    private readonly world: World,
    private readonly component: typeof MeshDrawParameters,
  ) {
    this.projection = createStateProjection(world, [component]);
  }

  prepare(hasDraw: (entity: number) => boolean, membershipChanges: ReadonlySet<number>) {
    const observation = this.projection.isCurrent() ? undefined : this.projection.read();
    if (observation === undefined && membershipChanges.size === 0) return undefined;
    const indices = new Set(observation?.indices);
    for (const entity of membershipChanges) indices.add(unpackSlot(entity));
    const rows = new Map<number, { entity: number; values: Row } | undefined>();
    let updates = 0;
    let removals = 0;
    for (const index of indices) {
      const before = this.accepted.get(index);
      const entity = this.projection.entity(index);
      const value =
        entity !== undefined && hasDraw(entity)
          ? readDrawParameters(this.world, this.component, entity, this.scratch)
          : undefined;
      if (before !== undefined && (entity !== before.entity || value === undefined)) removals++;
      if (entity === undefined || value === undefined) {
        if (before !== undefined) rows.set(index, undefined);
        continue;
      }
      if (before?.entity === entity && sameParameterValues(value, before.values)) continue;
      if (!value.every(Number.isFinite))
        throw new RangeError('Mesh draw parameters must be finite');
      updates++;
      rows.set(index, { entity, values: value.slice() });
    }
    let packet: OwnedDrawParameterColumns | undefined;
    if (updates + removals > 0) {
      packet = new OwnedDrawParameterColumns(updates, removals);
      let write = 0;
      let remove = 0;
      for (const [index, row] of rows) {
        const prior = this.accepted.get(index);
        if (prior !== undefined && prior.entity !== row?.entity)
          packet.removed[remove++] = prior.entity;
        if (row === undefined) continue;
        packet.entities[write] = row.entity;
        packet.values.set(row.values, write++ * MESH_DRAW_PARAMETER_FLOATS);
      }
    }
    return {
      packet,
      validate: () => observation?.validate(),
      accept: () => {
        observation?.accept();
        for (const [index, row] of rows)
          if (row === undefined) this.accepted.delete(index);
          else this.accepted.set(index, row);
      },
    };
  }
}

/** Detach candidate rows before any accepted state is replaced. */
export function stageDrawParameters(
  packet: PublishedDrawParameters,
  existing: ReadonlyMap<number, Row> | undefined,
  hasDraw: (entity: number) => boolean,
): { apply(target: Map<number, Row>): void } | undefined {
  if (
    packet === null ||
    !(packet.entities instanceof Uint32Array) ||
    !(packet.values instanceof Float32Array) ||
    !(packet.removed instanceof Uint32Array) ||
    packet.values.length !== packet.entities.length * MESH_DRAW_PARAMETER_FLOATS
  )
    return undefined;
  const rows = new Map<number, Row>();
  const removed = new Set<number>();
  for (const entity of packet.removed) {
    if (removed.has(entity) || existing?.has(entity) !== true) return undefined;
    removed.add(entity);
  }
  for (let index = 0; index < packet.entities.length; index++) {
    const entity = packet.entities[index] as number;
    if (rows.has(entity) || removed.has(entity) || !hasDraw(entity)) return undefined;
    const start = index * MESH_DRAW_PARAMETER_FLOATS;
    const values = new Array<number>(MESH_DRAW_PARAMETER_FLOATS);
    for (let field = 0; field < MESH_DRAW_PARAMETER_FLOATS; field++) {
      const value = packet.values[start + field] as number;
      if (!Number.isFinite(value)) return undefined;
      values[field] = value;
    }
    rows.set(entity, values);
  }
  return {
    apply(target) {
      for (const entity of removed) target.delete(entity);
      for (const [entity, row] of rows) target.set(entity, row);
    },
  };
}
