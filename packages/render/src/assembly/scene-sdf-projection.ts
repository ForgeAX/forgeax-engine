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
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { MeshFrame } from '../scene/mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from '../scene/mesh-materials';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { standardDisplacementRadius } from '../standard-displacement-bounds';

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
  function fail(reason: SceneSdfUnavailableError['detail']['reason'], entity?: number): never {
    throw new SceneSdfUnavailableError({
      reason,
      world,
      ...(entity === undefined ? {} : { entity }),
    });
  }
  if (scope === undefined) fail('missing-source');
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
  for (const slot of slots) {
    if (slot.worldId !== world || slot.snapshot.authorVisible === false) continue;
    const source = slot.snapshot;
    if (source.glyph !== undefined) continue;
    if (source.assetHandle === undefined) fail('missing-source', slot.entityKey);
    if (
      source.skinBinding !== undefined ||
      source.morph !== undefined ||
      source.spriteInstances !== undefined ||
      source.pointsLines !== undefined
    )
      fail('unsupported-geometry', slot.entityKey);
    const resolved = scope.resolveAsset<MeshAsset>(source.assetHandle);
    if (!resolved.ok || resolved.value.kind !== 'mesh') fail('missing-source', slot.entityKey);
    const mesh = resolved.unwrap();
    const geometry = frame.meshes.get(slot.worldId, source.assetHandle);
    const bindings =
      geometry === undefined
        ? source
        : effectiveMeshMaterials(source, geometry, meshMaterialGeometry(source));
    const materials = bindings.materials.map((resource) => {
      const accepted = frame.materials.get(resource);
      if (accepted === undefined) fail('missing-source', slot.entityKey);
      return accepted.snapshot;
    });
    const field = mesh.distanceField;
    if (field === undefined) fail('missing-field', slot.entityKey);
    if (
      field.policy.kind === 'sampled-visibility' ||
      !validateMeshDistanceField(field).ok ||
      field.artifact?.integrity.algorithm !== 'sha256' ||
      !/^sha256:[0-9a-f]{64}$/.test(field.artifact.integrity.digest) ||
      field.artifact.assetCodec.name !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.name ||
      field.artifact.assetCodec.version !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.version ||
      field.artifact.assetCodec.profile !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.profile
    )
      fail('invalid-field', slot.entityKey);
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
      fail('unsupported-geometry', slot.entityKey);
    if (!fields.has(field)) {
      fields.set(field, fields.size);
      fieldBytes += field.values.byteLength + field.bricks.byteLength;
      if (fieldBytes > descriptor.maxFieldBytes) fail('budget', slot.entityKey);
    }
    const count = source.instances?.instanceCount ?? 1;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > descriptor.maxInstances - instances.length ||
      (source.instances !== undefined && source.instances.transforms.length !== count * 16)
    )
      fail('budget', slot.entityKey);
    for (let i = 0; i < count; i++) {
      const transform =
        source.instances === undefined
          ? Float32Array.from(source.transform.world)
          : mat4.multiply(
              mat4.create(),
              source.transform.world as never,
              source.instances.transforms.subarray(i * 16, (i + 1) * 16) as never,
            );
      const scale = Math.max(
        ...[0, 4, 8].map((a) =>
          Math.hypot(transform[a] ?? NaN, transform[a + 1] ?? NaN, transform[a + 2] ?? NaN),
        ),
      );
      errorBound = Math.max(errorBound, field.policy.errorBound * scale);
      instances.push({
        instanceId: instances.length,
        geometryId: fields.get(field) ?? 0,
        mask: 255,
        transform,
        field: field,
      });
    }
  }
  return { instances, errorBound };
}
