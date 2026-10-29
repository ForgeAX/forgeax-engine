import {
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { SceneSdfUnavailableError } from '../errors/scene-sdf';
import type { RenderFeatureSceneSdfDescriptor } from '../features/scene-sdf';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { SdfMeshInstance } from '../raytracing/sdf-query';
import type { MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { MeshFrame } from '../scene/mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from '../scene/mesh-materials';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { type ProjectedRows, type ReadAsset, RowProjection } from '../scene/row-projection';
import { standardDisplacementRadius } from '../standard-displacement-bounds';

type Reason = SceneSdfUnavailableError['detail']['reason'];
type AttachedField = NonNullable<MeshAsset['distanceField']>;

/** One World row's collision contribution, or the first reason it cannot contribute. */
type CollisionRow =
  | {
      readonly kind: 'field';
      readonly entity: number;
      readonly field: AttachedField;
      /** The geometric field's local error bound. */
      readonly errorBound: number;
      /** Instance transforms; `undefined` when the instance roster is malformed. */
      readonly transforms: readonly Float32Array[] | undefined;
    }
  | { readonly kind: 'failure'; readonly reason: Reason; readonly entity: number };

function admitCollisionRow(
  slot: RenderSceneSlot,
  rows: ProjectedRows,
  scope: RenderResourceScope,
  world: number,
  read: ReadAsset,
): CollisionRow | undefined {
  if (slot.worldId !== world || slot.snapshot.authorVisible === false) return undefined;
  const source = slot.snapshot;
  if (source.glyph !== undefined) return undefined;
  const failure = (reason: Reason): CollisionRow => ({
    kind: 'failure',
    reason,
    entity: slot.entityKey,
  });
  if (source.assetHandle === undefined) return failure('missing-source');
  if (
    source.skinBinding !== undefined ||
    source.morph !== undefined ||
    source.spriteInstances !== undefined ||
    source.pointsLines !== undefined
  )
    return failure('unsupported-geometry');
  read(scope, source.assetHandle);
  const resolved = scope.resolveAsset<MeshAsset>(source.assetHandle);
  if (!resolved.ok || resolved.value.kind !== 'mesh') return failure('missing-source');
  const mesh = resolved.value;
  const geometry = rows.meshes.get(slot.worldId, source.assetHandle);
  const bindings =
    geometry === undefined
      ? source
      : effectiveMeshMaterials(source, geometry, meshMaterialGeometry(source));
  const materials: MaterialSnapshot[] = [];
  for (const resource of bindings.materials) {
    const accepted = rows.materials.get(resource);
    if (accepted === undefined) return failure('missing-source');
    materials.push(accepted.snapshot);
  }
  const field = mesh.distanceField;
  if (field === undefined) return failure('missing-field');
  if (
    field.policy.kind === 'sampled-visibility' ||
    !validateMeshDistanceField(field).ok ||
    field.artifact?.integrity.algorithm !== 'sha256' ||
    !/^sha256:[0-9a-f]{64}$/.test(field.artifact.integrity.digest) ||
    field.artifact.assetCodec.name !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.name ||
    field.artifact.assetCodec.version !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.version ||
    field.artifact.assetCodec.profile !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.profile
  )
    return failure('invalid-field');
  if (
    mesh.morphTargets !== undefined ||
    mesh.morphWeights !== undefined ||
    standardDisplacementRadius(materials) !== 0 ||
    materials.some(
      (m) =>
        m.paramSnapshot?.clippingControl !== undefined &&
        (m.paramSnapshot.clippingControl as readonly number[])[0] !== 0,
    )
  )
    return failure('unsupported-geometry');
  const count = source.instances?.instanceCount ?? 1;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    (source.instances !== undefined && source.instances.transforms.length !== count * 16)
  )
    return {
      kind: 'field',
      entity: slot.entityKey,
      field,
      errorBound: field.policy.errorBound,
      transforms: undefined,
    };
  const transforms: Float32Array[] = [];
  for (let i = 0; i < count; i++)
    transforms.push(
      source.instances === undefined
        ? Float32Array.from(source.transform.world)
        : mat4.multiply(
            mat4.create(),
            source.transform.world as never,
            source.instances.transforms.subarray(i * 16, (i + 1) * 16) as never,
          ),
    );
  return {
    kind: 'field',
    entity: slot.entityKey,
    field,
    errorBound: field.policy.errorBound,
    transforms,
  };
}

/**
 * One World's collision rows kept current from retained row change evidence.
 * Only that World's changed rows are re-admitted, and {@link revision} moves
 * only when a contribution changed, so unrelated edits never recompose a field.
 */
export class CollisionSceneRows {
  readonly #rows: RowProjection<CollisionRow>;

  constructor(
    readonly scope: RenderResourceScope,
    private readonly world: number,
  ) {
    this.#rows = new RowProjection((slot, rows, read) =>
      admitCollisionRow(slot, rows, scope, world, read),
    );
  }

  get visits(): number {
    return this.#rows.visits;
  }

  /** Bring the rows to `rows`; the returned revision names the admitted roster. */
  sync(rows: ProjectedRows): number {
    this.#rows.sync(rows);
    return this.#rows.revision;
  }

  /** O(contributing rows): fail on the first row in slot order, as a complete projection would. */
  project(descriptor: RenderFeatureSceneSdfDescriptor) {
    const world = this.world;
    function fail(reason: Reason, entity?: number): never {
      throw new SceneSdfUnavailableError({
        reason,
        world,
        ...(entity === undefined ? {} : { entity }),
      });
    }
    if (
      !Number.isSafeInteger(descriptor.maxInstances) ||
      descriptor.maxInstances < 1 ||
      descriptor.maxInstances > 1024 ||
      !Number.isSafeInteger(descriptor.maxFieldBytes) ||
      descriptor.maxFieldBytes < 1 ||
      descriptor.maxFieldBytes > 16 * 1024 * 1024
    )
      fail('budget');
    const instances: SdfMeshInstance[] = [];
    const fields = new Map<object, number>();
    let fieldBytes = 0;
    let errorBound = 0;
    for (const [, row] of [...this.#rows.entries()].sort(([a], [b]) => a - b)) {
      if (row.kind === 'failure') fail(row.reason, row.entity);
      const entity = row.entity;
      const field = row.field;
      if (!fields.has(field)) {
        fields.set(field, fields.size);
        fieldBytes += field.values.byteLength + field.bricks.byteLength;
        if (fieldBytes > descriptor.maxFieldBytes) fail('budget', entity);
      }
      const transforms = row.transforms;
      if (
        transforms === undefined ||
        transforms.length > descriptor.maxInstances - instances.length
      )
        fail('budget', entity);
      for (const transform of transforms) {
        const scale = Math.max(
          ...[0, 4, 8].map((a) =>
            Math.hypot(transform[a] ?? NaN, transform[a + 1] ?? NaN, transform[a + 2] ?? NaN),
          ),
        );
        errorBound = Math.max(errorBound, row.errorBound * scale);
        instances.push({
          instanceId: instances.length,
          geometryId: fields.get(field) ?? 0,
          mask: 255,
          transform,
          field,
        });
      }
    }
    return { instances, errorBound };
  }
}

/** Reads the Renderer projection, never queries or retains a second World table.
 * Visibility fields cannot supply a geometric collision error bound. */
export function projectCollisionScene(
  slots: FrameList<RenderSceneSlot>,
  scopes: readonly RenderResourceScope[],
  world: number,
  descriptor: RenderFeatureSceneSdfDescriptor,
  frame: { readonly materials: MaterialFrame; readonly meshes: MeshFrame },
) {
  const scope = scopes[world];
  if (scope === undefined) throw new SceneSdfUnavailableError({ reason: 'missing-source', world });
  const rows = new CollisionSceneRows(scope, world);
  rows.sync({ identity: {}, slots, ...frame });
  return rows.project(descriptor);
}
