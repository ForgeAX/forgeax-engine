import { mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { meshAttributeChannels } from '../publication/packed-rows-mesh';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import type { MeshFrame } from '../scene/mesh-frame';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { buildRaySurfaceScene, type RaySurfaceInstance } from './attributes';
import { rayReferenceFailure } from './scene';
import type { VisibleSurfaceProjection } from './visible-surface';

/** One frozen query projection of the complete retained scene, including offscreen sources. */
export function projectRayScene(
  slots: FrameList<RenderSceneSlot>,
  worlds: readonly RenderResourceScope[],
  visibleSurface: VisibleSurfaceProjection,
  frame?: { readonly materials: MaterialFrame; readonly meshes: MeshFrame },
) {
  const sources =
    frame === undefined
      ? slots
      : slots.map((slot) => ({ ...slot, snapshot: meshDrawSnapshot(slot.snapshot, frame.meshes) }));
  for (const { snapshot } of sources) {
    if (snapshot.authorVisible !== false && (snapshot.gpuDrivenDraws?.length ?? 0) === 0)
      return rayReferenceFailure(
        'transport contributor has no admitted geometry; missing representation is not a ray miss',
      ).unwrap();
  }
  const surfaces = {
    records: visibleSurface.records.slice(),
    slotBases: new Map(visibleSurface.slotBases),
    entityBases: new Map(visibleSurface.entityBases),
    layout: visibleSurface.layout,
  };
  const instances: RaySurfaceInstance[] = [];
  // These dense material addresses belong only to this snapshot. World handles
  // and retained surface rows remain the source identity; no identity allocator.
  const materials: {
    readonly worldId: number;
    readonly handle: number;
    readonly snapshot: MaterialSnapshot;
  }[] = [];
  const materialIds = new Map<number, Map<number, number>>();
  for (const slot of [...sources].sort((a, b) => a.slot - b.slot)) {
    const base = surfaces.slotBases.get(slot.slot);
    if (base === undefined) continue;
    const source = slot.snapshot;
    if (source.assetHandle === undefined)
      return rayReferenceFailure('retained transport source has no Mesh identity').unwrap();
    const world = worlds[slot.worldId];
    if (world === undefined)
      return rayReferenceFailure('retained transport slot has no matching resource World').unwrap();
    const mesh = world.resolveAsset<MeshAsset>(source.assetHandle).unwrap();
    if (mesh.kind !== 'mesh')
      return rayReferenceFailure('retained transport source must resolve to a MeshAsset').unwrap();
    // Packed-rows meshes rebuild their channels exactly from the rows here.
    const channels = meshAttributeChannels(mesh);
    const read = (key: keyof MeshAsset['attributes']) => {
      const value = channels[key];
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
      const resource = source.materials[draw.materialSlot];
      if (resource === undefined)
        return rayReferenceFailure('transport draw has no published material handle').unwrap();
      const material =
        frame === undefined ? resource.snapshot : frame.materials.get(resource)?.snapshot;
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
