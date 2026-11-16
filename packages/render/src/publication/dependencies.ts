import type {
  ExtractedFrame,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';

/** Asset handles bound by one material, independent of its renderable's geometry. */
export function materialSnapshotDependencies(material: MaterialSnapshot): number[] {
  const handles = new Set<number>();
  for (const handle of [
    material.materialHandle,
    material.baseColorTexture,
    material.metallicRoughnessTexture,
    material.normalTexture,
    material.emissiveTexture,
    material.occlusionTexture,
  ])
    if (handle) handles.add(handle);
  for (const handle of material.textureHandles?.values() ?? []) handles.add(handle);
  for (const handle of material.samplerHandles?.values() ?? []) handles.add(handle);
  return [...handles];
}

/** One asset closure for source publication and receiver admission. */
export function publicationDependencies(
  row: Pick<
    RenderableSnapshot,
    | 'assetHandle'
    | 'materials'
    | 'materialOverrides'
    | 'terrain'
    | 'glyph'
    | 'tilemap'
    | 'skinBinding'
  >,
  exactVersionAvailable?: (handle: number, revision: number) => boolean,
): number[] {
  if (row.glyph !== undefined) return [row.glyph.font];
  if (row.tilemap !== undefined) return [row.tilemap.tileset];
  if (row.terrain !== undefined) return [row.terrain.handle];
  const handles = new Set<number>(row.assetHandle === undefined ? [] : [row.assetHandle]);
  if (row.skinBinding !== undefined) handles.add(row.skinBinding.skeleton);
  for (const material of [...row.materials, ...(row.materialOverrides ?? [])]) {
    if (material === undefined) continue;
    for (const handle of materialSnapshotDependencies(material.snapshot)) {
      const fixed = material.snapshot.sourceAssets?.assets.find((asset) => asset.handle === handle);
      if (fixed === undefined || exactVersionAvailable?.(handle, fixed.revision) !== true)
        handles.add(handle);
    }
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
    | 'cloudLayer'
  >,
): number[] {
  const handles = new Set<number>();
  const add = (handle: number | undefined) => {
    if (handle) handles.add(handle as number);
  };
  for (const decal of frame.projectedDecals ?? []) {
    add(decal.material.materialHandle);
    for (const handle of decal.material.samplerHandles?.values() ?? []) add(handle);
    for (const handle of decal.material.textureHandles?.values() ?? []) add(handle);
  }
  if (frame.cloudLayer?.status === 'sampled')
    for (const texture of frame.cloudLayer.textures) add(texture.handle);
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

/** Binding roots; transitive resource holds belong to the asset owner graph. */
export function renderableAssetRoots(row: RenderableSnapshot): readonly number[] {
  if (row.glyph !== undefined) return [row.glyph.font];
  if (row.tilemap !== undefined) return [row.tilemap.tileset];
  if (row.terrain !== undefined) return [row.terrain.handle];
  const handles = new Set<number>(row.assetHandle === undefined ? [] : [row.assetHandle]);
  if (row.skinBinding !== undefined) handles.add(row.skinBinding.skeleton);
  for (const override of row.materialOverrides ?? [])
    if (override?.snapshot.materialHandle) handles.add(override.snapshot.materialHandle);
  for (const material of row.materials) handles.add(material.snapshot.materialHandle ?? 0);
  handles.delete(0);
  return [...handles];
}
