import type { Handle } from '@forgeax/engine-types';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';

/** One asset closure for source publication and receiver admission. */
export function publicationDependencies(
  row: Pick<RenderableSnapshot, 'assetHandle' | 'materials' | 'terrain'>,
): Handle<string, 'shared'>[] {
  const handles = new Set<Handle<string, 'shared'>>([row.assetHandle as Handle<string, 'shared'>]);
  if (row.terrain)
    for (const handle of [
      row.terrain.handle,
      ...row.terrain.grids,
      ...row.terrain.heightTextures,
      ...row.terrain.weightTextures,
    ])
      handles.add(handle as Handle<string, 'shared'>);
  for (const material of row.materials) {
    for (const handle of [
      material.materialHandle,
      material.baseColorTexture,
      material.metallicRoughnessTexture,
      material.normalTexture,
      material.emissiveTexture,
      material.occlusionTexture,
    ]) {
      if (handle) handles.add(handle as Handle<string, 'shared'>);
    }
    for (const handle of material.textureHandles?.values() ?? []) handles.add(handle);
    for (const handle of material.samplerHandles?.values() ?? []) handles.add(handle);
  }
  return [...handles];
}

/** Resources selected once for the frame rather than attached to geometry. */
export function publicationFrameDependencies(
  frame: Pick<
    ExtractedFrame,
    | 'cameras'
    | 'auxiliaryCameras'
    | 'skylight'
    | 'skybox'
    | 'lights'
    | 'volumetricFog'
    | 'projectedDecals'
  >,
): Handle<string, 'shared'>[] {
  const handles = new Set<Handle<string, 'shared'>>();
  const add = (handle: number | undefined) => {
    if (handle) handles.add(handle as Handle<string, 'shared'>);
  };
  for (const decal of frame.projectedDecals ?? []) {
    add(decal.material.materialHandle);
    for (const handle of decal.material.samplerHandles?.values() ?? []) add(handle);
    for (const handle of decal.material.textureHandles?.values() ?? []) add(handle);
  }
  add(frame.skylight?.equirectHandle);
  add(frame.skybox?.equirectHandle);
  for (const camera of [...frame.cameras, ...frame.auxiliaryCameras]) add(camera.output?.colorLut);
  for (const light of frame.lights.spot) {
    add(light.iesProfileHandle);
    add(light.cookieHandle);
    add(light.projectorHandle);
  }
  for (const light of frame.lights.point) add(light.iesProfileHandle);
  for (const light of frame.lights.rect) {
    add(light.iesProfileHandle);
    add(light.sourceTextureHandle);
  }
  const fogs =
    frame.volumetricFog === undefined
      ? []
      : [frame.volumetricFog, ...(frame.volumetricFog.additional ?? [])];
  for (const fog of fogs) {
    add(fog.densityHandle);
    add(fog.projectorHandle);
  }
  return [...handles];
}
