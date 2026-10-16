import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { componentId } from '@forgeax/engine-ecs/internal';
import {
  createStateProjection,
  readComponentMutationEpoch,
  type StateProjection,
} from '@forgeax/engine-ecs/projection';
import { deriveVertexCount, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import {
  type Asset,
  AssetError,
  err,
  type MaterialAsset,
  type MaterialValue,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { validateMeshPayload } from './payload-validate';

/** One shared material parameter, stored and versioned by the World. */
export const RuntimeMaterialValue = defineComponent('RuntimeMaterialValue', {
  asset: 'shared<MaterialAsset>',
  parameter: 'string',
  kind: { type: 'enum', labels: { number: 0, boolean: 1, vector: 2 }, default: 0 },
  value: 'array<f32>',
});

/** One shared mesh's managed numeric buffers; empty indices retain the base topology. */
export const RuntimeMeshVertices = defineComponent('RuntimeMeshVertices', {
  asset: 'shared<MeshAsset>',
  vertices: 'array<f32>',
  indices: 'array<u32>',
});

type ContentRow = { readonly entity: EntityHandle; readonly asset: number } & (
  | { readonly kind: 'material'; readonly parameter: string; readonly value: MaterialValue }
  | {
      readonly kind: 'mesh';
      readonly vertices: Float32Array;
      readonly indices: Uint32Array | undefined;
    }
);
interface RuntimeContentProjection {
  readonly source: StateProjection;
  readonly materialValueComponent: typeof RuntimeMaterialValue;
  readonly meshVerticesComponent: typeof RuntimeMeshVertices;
  readonly rows: Map<number, ContentRow>;
  readonly assets: Map<number, Map<number, ContentRow>>;
  readonly payloads: Map<number, { base: Asset; value: Asset }>;
}
const projections = new WeakMap<World, RuntimeContentProjection>();

function contentProjection(world: World): RuntimeContentProjection {
  let projection = projections.get(world);
  // Public App and plugin entries can be separately bundled. The World catalog
  // owns the component token that crossed that boundary. Resolve again here so
  // a plugin installed after the first asset read can replace the fallback.
  const materialValueComponent =
    (world.components.resolve(RuntimeMaterialValue.name) as
      | typeof RuntimeMaterialValue
      | undefined) ?? RuntimeMaterialValue;
  const meshVerticesComponent =
    (world.components.resolve(RuntimeMeshVertices.name) as
      | typeof RuntimeMeshVertices
      | undefined) ?? RuntimeMeshVertices;
  if (
    projection === undefined ||
    projection.materialValueComponent !== materialValueComponent ||
    projection.meshVerticesComponent !== meshVerticesComponent
  ) {
    projection = {
      source: createStateProjection(world, [materialValueComponent, meshVerticesComponent]),
      materialValueComponent,
      meshVerticesComponent,
      rows: new Map(),
      assets: new Map(),
      payloads: new Map(),
    };
    projections.set(world, projection);
  }
  if (projection.source.isCurrent()) return projection;
  const batch = projection.source.read();
  for (const index of batch.indices) {
    const previous = projection.rows.get(index);
    if (previous !== undefined) {
      const entries = projection.assets.get(previous.asset);
      entries?.delete(index);
      if (entries?.size === 0) projection.assets.delete(previous.asset);
      projection.payloads.delete(previous.asset);
      projection.rows.delete(index);
    }
    const entity = projection.source.entity(index);
    if (entity === undefined) continue;
    const material = world.hasComponent(entity, projection.materialValueComponent)
      ? world.get(entity, projection.materialValueComponent)
      : undefined;
    const mesh = world.hasComponent(entity, projection.meshVerticesComponent)
      ? world.get(entity, projection.meshVerticesComponent)
      : undefined;
    let row: ContentRow;
    if (material?.ok) {
      const data = material.value;
      row = {
        kind: 'material',
        entity,
        asset: Number(data.asset),
        parameter: data.parameter,
        value:
          data.kind === 2
            ? Object.freeze(Array.from(data.value))
            : data.kind === 1
              ? (data.value[0] ?? 0) !== 0
              : (data.value[0] ?? 0),
      };
    } else if (mesh?.ok) {
      row = {
        kind: 'mesh',
        entity,
        asset: Number(mesh.value.asset),
        vertices: mesh.value.vertices.slice(),
        indices: mesh.value.indices.length === 0 ? undefined : mesh.value.indices.slice(),
      };
    } else continue;
    let entries = projection.assets.get(row.asset);
    if (entries === undefined) {
      entries = new Map();
      projection.assets.set(row.asset, entries);
    }
    entries.set(index, row);
    projection.rows.set(index, row);
    projection.payloads.delete(row.asset);
  }
  batch.accept();
  return projection;
}

/** Stable identity and mutation version for runtime values without scanning the World. */
export function runtimeContentRevision(world: World): string {
  const materialValueComponent =
    world.components.resolve(RuntimeMaterialValue.name) ?? RuntimeMaterialValue;
  const meshVerticesComponent =
    world.components.resolve(RuntimeMeshVertices.name) ?? RuntimeMeshVertices;
  return `${componentId(materialValueComponent)}:${readComponentMutationEpoch(world, materialValueComponent)}:${componentId(meshVerticesComponent)}:${readComponentMutationEpoch(world, meshVerticesComponent)}`;
}

function meshContent(base: MeshAsset, row: Extract<ContentRow, { kind: 'mesh' }>): MeshAsset {
  const vertices = row.vertices;
  const layout = deriveVertexLayoutProjection(base.attributes);
  const count = deriveVertexCount(vertices, layout);
  if (count === undefined)
    throw new AssetError({
      code: 'mesh-vertex-stride-mismatch',
      expected: 'complete rows of the source vertex layout',
      hint: 'Write a vertex buffer matching the source mesh layout, then resolve the same asset again.',
    });
  const attributes: Record<string, Float32Array | Uint16Array> = {};
  const bytes = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  for (const attribute of layout.attributes) {
    const integer = attribute.format.startsWith('uint16');
    const width = integer ? 2 : 4;
    const arity = attribute.byteLength / width;
    const values = integer ? new Uint16Array(count * arity) : new Float32Array(count * arity);
    for (let row = 0; row < count; row++)
      for (let lane = 0; lane < arity; lane++) {
        const offset = row * layout.arrayStride + attribute.offset + lane * width;
        values[row * arity + lane] = integer
          ? bytes.getUint16(offset, true)
          : bytes.getFloat32(offset, true);
      }
    attributes[attribute.key] = values;
  }
  const position = attributes.position;
  if (position === undefined)
    throw new AssetError({
      code: 'asset-invalid-value',
      expected: 'runtime mesh position attribute',
      hint: 'Use a source mesh with a position attribute.',
    });
  const { cardLayout: _, distanceField: __, collision: ___, ...geometry } = base;
  return Object.freeze({
    ...geometry,
    vertices,
    ...(row.indices === undefined ? {} : { indices: row.indices }),
    attributes: Object.freeze(attributes) as VertexAttributeMap,
    aabb: box3.fromPositions(box3.create(), position),
  });
}

/** Asset resolution's runtime-value projection; the SharedRefStore remains identity-only. */
export function projectRuntimeAsset<T extends Asset>(
  world: World,
  handle: number,
  base: T,
): Result<T, AssetError> {
  if (base.kind !== 'material' && base.kind !== 'mesh') return ok(base);
  const projection = contentProjection(world);
  const rows = projection.assets.get(handle);
  if (rows === undefined) return ok(base);
  const cached = projection.payloads.get(handle);
  if (cached?.base === base) return ok(cached.value as T);
  let result: Asset = base;
  if (base.kind === 'material') {
    const material = base as MaterialAsset;
    const values: Record<string, MaterialValue | null> = { ...material.values };
    const parameters = new Set<string>();
    for (const row of rows.values())
      if (row.kind === 'material') {
        if (parameters.has(row.parameter))
          return err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: 'one content entity per material parameter',
              hint: 'Remove the duplicate RuntimeMaterialValue or rebind its asset/parameter.',
            }),
          );
        parameters.add(row.parameter);
        values[row.parameter] = row.value;
      }
    result = Object.freeze({ ...material, values: Object.freeze(values) });
  } else {
    try {
      let found = false;
      for (const row of rows.values())
        if (row.kind === 'mesh') {
          if (found)
            return err(
              new AssetError({
                code: 'asset-invalid-value',
                expected: 'one content entity per mesh',
                hint: 'Remove the duplicate RuntimeMeshVertices or rebind its asset.',
              }),
            );
          found = true;
          result = meshContent(base, row);
          const invalid = validateMeshPayload(result);
          if (invalid !== null) return err(invalid);
        }
    } catch (cause) {
      if (cause instanceof AssetError) return err(cause);
      throw cause;
    }
  }
  projection.payloads.set(handle, { base, value: result });
  return ok(result as T);
}
