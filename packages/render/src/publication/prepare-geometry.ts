import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import { buildGpuDrivenDraws } from '../extract/gpu-driven';
import type { InstanceProjectionStore } from '../instances';
import type { RenderableSnapshot } from '../render-system-extract';
import type { extractFrames } from '../render-system-extract-tail';
import type { PersistentRenderScene } from '../scene/render-scene';
import { prepareSkinPalette, type SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { RenderPublicationError } from './contract';
import type { PreparedRenderPublication } from './receiver';
import { renderAsset } from './resource-scope';

/** Resolve GPU ownership after source data has crossed the publication boundary. */
export function preparePublicationGeometry(
  input: PreparedRenderPublication,
  scene: PersistentRenderScene,
  palette: SkinPaletteAllocator | null | undefined,
  _assets: AssetRegistry,
  instances: InstanceProjectionStore,
  getMaterialShaderArtifact?: NonNullable<
    Parameters<typeof extractFrames>[5]
  >['getMaterialShaderArtifact'],
): PreparedRenderPublication {
  if (input.resources.revision !== input.packet.revision)
    throw new RenderPublicationError({
      reason: 'revision',
      subject: 'stale prepared geometry input',
    });
  const replacements = new Map<number, RenderableSnapshot>();
  for (const operation of input.operations) {
    if (operation.kind !== 'remove' && operation.snapshot === undefined) continue;
    if (operation.kind === 'remove' || operation.snapshot?.instances === undefined)
      instances.release(input.resources, operation.entityKey);
    const prior = scene.compositionSlot(0, operation.entityKey)?.snapshot.skin;
    const pose = operation.kind === 'remove' ? undefined : operation.snapshot?.skinPose;
    if (prior !== undefined && prior.identity !== pose?.identity)
      palette?.releasePersistentSlice(prior.identity);
  }
  for (const row of input.frame.renderables) {
    const { skinPose } = row;
    let skin = row.skin;
    if (skinPose !== undefined) {
      if (palette == null)
        throw new RenderPublicationError({
          reason: 'unsupported',
          subject: 'skin palette allocator',
        });
      skin = prepareSkinPalette(skinPose, palette);
    }
    const projected =
      row.instances === undefined
        ? undefined
        : instances.project(input.resources, row.entityKey, row.instances.transforms);
    if (projected instanceof Error) throw projected;
    const snapshot: RenderableSnapshot = {
      ...row,
      ...(skin === undefined ? {} : { skin }),
      ...(projected === undefined || row.instances === undefined
        ? {}
        : { instances: { ...row.instances, ...projected, archVersion: 0 } }),
    };
    if (projected !== undefined) instances.accept(input.resources, row.entityKey, projected);
    if (row.assetHandle === undefined) {
      replacements.set(row.entityKey, snapshot);
      continue;
    }
    const mesh = input.resources.resolveAsset<MeshAsset>(row.assetHandle as AssetHandle<'mesh'>);
    if (!mesh.ok) throw mesh.error;
    const gpuDrivenDraws =
      row.morph === undefined
        ? buildGpuDrivenDraws({
            mesh: mesh.value,
            materials: row.materials.map((material) => material.snapshot),
            fallbackMaterial: row.material.snapshot,
            deformation: snapshot.skin === undefined ? 'rigid' : 'skin',
            ...(getMaterialShaderArtifact === undefined ? {} : { getMaterialShaderArtifact }),
            ...(row.lods === undefined
              ? {}
              : {
                  lodMeshes: row.lods.map((lod) =>
                    renderAsset<MeshAsset>(input.resources, lod.mesh),
                  ),
                }),
          })
        : [];
    const prepared = { ...snapshot, gpuDrivenDraws };
    replacements.set(row.entityKey, prepared);
  }
  return {
    ...input,
    frame: { ...input.frame, renderables: [...replacements.values()] },
    operations: input.operations.map((operation) =>
      operation.kind !== 'remove' && operation.snapshot !== undefined
        ? { ...operation, snapshot: replacements.get(operation.entityKey) as RenderableSnapshot }
        : operation,
    ),
  };
}
