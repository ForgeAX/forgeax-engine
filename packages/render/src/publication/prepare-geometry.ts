import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { buildGpuDrivenDraws } from '../extract/gpu-driven';
import type { InstanceProjectionStore } from '../instances';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import type { extractFrames } from '../render-system-extract-tail';
import type { PersistentRenderScene } from '../scene/render-scene';
import { prepareSkinPalette, type SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { RenderPublicationError } from './contract';
import { preparePublishedShadowPasses } from './prepare-shadow';
import type { PreparedRenderPublication } from './receiver';
import { renderAssetByGuid } from './resource-scope';

/** Resolve GPU ownership after source data has crossed the publication boundary. */
export function preparePublicationGeometry(
  input: PreparedRenderPublication,
  scene: PersistentRenderScene,
  palette: SkinPaletteAllocator | null | undefined,
  assets: AssetRegistry,
  instances: InstanceProjectionStore,
  getMaterialShaderArtifact?: NonNullable<
    Parameters<typeof extractFrames>[5]
  >['getMaterialShaderArtifact'],
): PreparedRenderPublication {
  const replacements = new Map<number, RenderableSnapshot>();
  const shadowDispatch = new Map<number, Map<number, DispatchEntry[]>>();
  if (getMaterialShaderArtifact !== undefined) {
    for (const entry of input.frame.dispatch) {
      if (entry.tags.LightMode !== 'ShadowCaster') continue;
      let byMaterial = shadowDispatch.get(entry.renderableIndex);
      if (byMaterial === undefined) {
        byMaterial = new Map();
        shadowDispatch.set(entry.renderableIndex, byMaterial);
      }
      const entries = byMaterial.get(entry.materialHandle) ?? [];
      entries.push(entry);
      byMaterial.set(entry.materialHandle, entries);
    }
  }
  for (const operation of input.operations) {
    if (operation.kind !== 'remove' && operation.snapshot === undefined) continue;
    if (operation.kind === 'remove' || operation.snapshot?.instances === undefined)
      instances.release(input.resources, operation.entityKey);
    const prior = scene.compositionSlot(0, operation.entityKey)?.snapshot.skin;
    const pose = operation.kind === 'remove' ? undefined : operation.snapshot?.skinPose;
    if (prior !== undefined && prior.identity !== pose?.identity)
      palette?.releasePersistentSlice(prior.identity);
  }
  for (const [renderableIndex, row] of input.frame.renderables.entries()) {
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
    const mesh = input.resources.resolveAsset<MeshAsset>(
      row.assetHandle as Handle<'MeshAsset', 'shared'>,
    );
    if (!mesh.ok) throw mesh.error;
    const gpuDrivenDraws =
      row.morph === undefined
        ? buildGpuDrivenDraws({
            mesh: mesh.value,
            materials: row.materials,
            fallbackMaterial: row.material,
            baseSnapshot: snapshot,
            ...(getMaterialShaderArtifact === undefined ? {} : { getMaterialShaderArtifact }),
            ...(row.lods === undefined
              ? {}
              : {
                  lodMeshes: row.lods.map((lod) =>
                    renderAssetByGuid<MeshAsset>(input.resources, assets, lod.mesh),
                  ),
                }),
          })
        : [];
    const prepared = { ...snapshot, gpuDrivenDraws };
    const admittedShadowPasses =
      getMaterialShaderArtifact === undefined
        ? prepared.shadowCasterPasses
        : preparePublishedShadowPasses(
            prepared,
            shadowDispatch.get(renderableIndex),
            getMaterialShaderArtifact,
          );
    const shadowCasterPasses = admittedShadowPasses?.some(
      (pass) => pass.cpuReason !== undefined && pass.gpuDrivenEligible !== false,
    )
      ? admittedShadowPasses.map((pass) =>
          pass.cpuReason === undefined || pass.gpuDrivenEligible === false
            ? pass
            : { ...pass, gpuDrivenEligible: false },
        )
      : admittedShadowPasses;
    replacements.set(
      row.entityKey,
      shadowCasterPasses === undefined || shadowCasterPasses === prepared.shadowCasterPasses
        ? prepared
        : { ...prepared, shadowCasterPasses },
    );
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
