import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { mat4 } from '@forgeax/engine-math';
import { type MeshAsset, toShared } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { buildRaySurfaceScene, type RaySurfaceInstance } from './attributes';
import { rayReferenceFailure } from './scene';
import { projectVisibleSurfaces } from './visible-surface';

/** One frozen query projection of the complete retained scene, including offscreen sources. */
export function projectRayScene(
  slots: readonly RenderSceneSlot[],
  worlds: readonly RenderResourceScope[],
  maxSurfaceRecords: number,
) {
  for (const { snapshot } of slots) {
    if (snapshot.authorVisible !== false && (snapshot.gpuDrivenDraws?.length ?? 0) === 0)
      return rayReferenceFailure(
        'transport contributor has no admitted geometry; missing representation is not a ray miss',
      ).unwrap();
  }
  const surfaces = projectVisibleSurfaces(slots, maxSurfaceRecords).unwrap();
  const instances: RaySurfaceInstance[] = [];
  // These dense material addresses belong only to this snapshot. World handles
  // and retained surface rows remain the source identity; no identity allocator.
  const materials: {
    readonly worldId: number;
    readonly handle: number;
    readonly snapshot: MaterialSnapshot;
  }[] = [];
  const materialIds = new Map<number, Map<number, number>>();
  for (const slot of [...slots].sort((a, b) => a.slot - b.slot)) {
    const base = surfaces.slotBases.get(slot.slot);
    if (base === undefined) continue;
    const source = slot.snapshot;
    const world = worlds[slot.worldId];
    if (world === undefined)
      return rayReferenceFailure('retained transport slot has no matching resource World').unwrap();
    const mesh = resolveAssetHandle<MeshAsset>(world, toShared(source.assetHandle)).unwrap();
    if (mesh.kind !== 'mesh')
      return rayReferenceFailure('retained transport source must resolve to a MeshAsset').unwrap();
    const read = (key: keyof MeshAsset['attributes']) => {
      const value = mesh.attributes[key];
      if (value === undefined || value instanceof Float32Array) return value;
      if (value instanceof ArrayBuffer && value.byteLength % 4 === 0)
        return new Float32Array(value);
      return rayReferenceFailure(
        `transport attribute ${key} requires float32 source data`,
      ).unwrap();
    };
    const positions = read('position');
    if (positions === undefined)
      return rayReferenceFailure('transport mesh has no positions').unwrap();
    const normals = read('normal'),
      tangents = read('tangent'),
      colors = read('color');
    const uvSets: Float32Array[] = [];
    for (const key of ['uv', 'uv1', 'uv2', 'uv3', 'uv4', 'uv5', 'uv6', 'uv7'] as const) {
      const uv = read(key);
      if (uv !== undefined) {
        // Sparse UVs cannot be collapsed: the material uses the authored set number.
        const index = key === 'uv' ? 0 : Number(key.slice(2));
        if (index !== uvSets.length)
          return rayReferenceFailure('transport source has a gap in its authored UV sets').unwrap();
        uvSets.push(uv);
      }
    }
    const instanceCount = source.instances?.instanceCount ?? 1;
    if (source.instances !== undefined && source.instances.transforms.length !== instanceCount * 16)
      return rayReferenceFailure('retained transport instance transforms are incomplete').unwrap();
    for (const [drawIndex, draw] of (source.gpuDrivenDraws ?? []).entries()) {
      if (draw.count === 0) continue;
      const drawItemIndex = gpuDrivenSourceDrawItemIndex(draw, drawIndex);
      const material = source.materials[draw.materialSlot];
      const handle = material?.materialHandle;
      if (material === undefined || handle === undefined)
        return rayReferenceFailure('transport draw has no published material handle').unwrap();
      let worldMaterials = materialIds.get(slot.worldId);
      if (worldMaterials === undefined) {
        worldMaterials = new Map();
        materialIds.set(slot.worldId, worldMaterials);
      }
      let materialId = worldMaterials.get(handle);
      if (materialId === undefined) {
        materialId = materials.length;
        materials.push({ worldId: slot.worldId, handle, snapshot: material });
        worldMaterials.set(handle, materialId);
      }
      const sourceIndices = draw.kind === 'indexed' ? mesh.indices : undefined;
      if (
        (draw.kind === 'indexed' && sourceIndices === undefined) ||
        draw.first + draw.count > (sourceIndices?.length ?? positions.length / 3)
      )
        return rayReferenceFailure('transport draw exceeds its actual mesh element range').unwrap();
      const indices = new Uint32Array(draw.count);
      for (let element = 0; element < draw.count; element++) {
        const index =
          sourceIndices === undefined
            ? draw.first + element
            : (sourceIndices[draw.first + element] as number) + draw.baseVertex;
        if (index < 0 || index >= positions.length / 3)
          return rayReferenceFailure(
            'transport baseVertex resolves outside mesh positions',
          ).unwrap();
        indices[element] = index;
      }
      for (let ordinal = 0; ordinal < instanceCount; ordinal++) {
        const transform = mat4.clone(source.transform.world);
        if (source.instances !== undefined)
          mat4.multiply(
            transform,
            transform,
            source.instances.transforms.subarray(ordinal * 16, (ordinal + 1) * 16),
          );
        instances.push({
          instanceId: base + drawItemIndex * instanceCount + ordinal,
          geometryId: drawItemIndex,
          materialId,
          mask: 255,
          transform,
          positions,
          indices,
          uvSets,
          ...(normals === undefined ? {} : { normals }),
          ...(tangents === undefined ? {} : { tangents }),
          ...(colors === undefined ? {} : { colors }),
        });
      }
    }
  }
  // The builder owns the copied world-space triangles and attributes. Later
  // source edits cannot mutate a graph's already accepted transport snapshot.
  return { surfaces, materials, scene: buildRaySurfaceScene(instances).unwrap() };
}
