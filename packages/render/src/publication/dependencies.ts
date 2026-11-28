import type {
  ExtractedFrame,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';

/** Asset handles bound by one material, independent of its renderable's geometry. */
export function collectMaterialDependencies(material: MaterialSnapshot, into: Set<number>): void {
  if (material.materialHandle) into.add(material.materialHandle);
  if (material.baseColorTexture) into.add(material.baseColorTexture);
  if (material.metallicRoughnessTexture) into.add(material.metallicRoughnessTexture);
  if (material.normalTexture) into.add(material.normalTexture);
  if (material.emissiveTexture) into.add(material.emissiveTexture);
  if (material.occlusionTexture) into.add(material.occlusionTexture);
  if (material.textureHandles)
    for (const handle of material.textureHandles.values()) into.add(handle);
  if (material.samplerHandles)
    for (const handle of material.samplerHandles.values()) into.add(handle);
}

function collectRowMaterials(
  materials: RenderableSnapshot['materialOverrides'],
  handles: Set<number>,
  exactVersionAvailable?: (handle: number, revision: number) => boolean,
): void {
  if (materials === undefined) return;
  for (const material of materials) {
    if (material === undefined) continue;
    const snapshot = material.snapshot;
    const source = exactVersionAvailable === undefined ? undefined : snapshot.sourceAssets;
    if (source === undefined || exactVersionAvailable === undefined) {
      collectMaterialDependencies(snapshot, handles);
      continue;
    }
    const needed = new Set<number>();
    collectMaterialDependencies(snapshot, needed);
    for (const asset of source.assets) {
      const handle = asset.handle;
      if (needed.has(handle) && exactVersionAvailable(handle, asset.revision))
        needed.delete(handle);
      if (needed.size === 0) break;
    }
    for (const handle of needed) handles.add(handle);
  }
}

type DependencyRow = Pick<
  RenderableSnapshot,
  | 'assetHandle'
  | 'materials'
  | 'materialOverrides'
  | 'terrain'
  | 'glyph'
  | 'tilemap'
  | 'skinBinding'
>;

/** Append to the receiver's or stream's own set across all contributing rows. */
export function collectPublicationDependencies(
  row: DependencyRow,
  handles: Set<number>,
  exactVersionAvailable?: (handle: number, revision: number) => boolean,
): void {
  const special =
    row.glyph !== undefined
      ? row.glyph.font
      : row.tilemap !== undefined
        ? row.tilemap.tileset
        : row.terrain?.handle;
  if (special !== undefined) {
    handles.add(special);
    return;
  }
  if (row.assetHandle !== undefined) handles.add(row.assetHandle);
  if (row.skinBinding !== undefined) handles.add(row.skinBinding.skeleton);
  collectRowMaterials(row.materials, handles, exactVersionAvailable);
  collectRowMaterials(row.materialOverrides, handles, exactVersionAvailable);
}

/** Detached roots for one row at the admission boundary. */
export function publicationDependencies(
  row: DependencyRow,
  exactVersionAvailable?: (handle: number, revision: number) => boolean,
): number[] {
  const handles = new Set<number>();
  collectPublicationDependencies(row, handles, exactVersionAvailable);
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
  forEachLightAsset(frame.lights, add);
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

export function forEachLightAsset(
  roster: ExtractedFrame['lights'],
  add: (handle: number | undefined) => void,
): void {
  for (const light of roster.spot) {
    add(light.iesProfileHandle);
    add(light.cookieHandle);
    add(light.projectorHandle);
  }
  for (const light of roster.point) add(light.iesProfileHandle);
  for (const light of roster.rect) {
    add(light.iesProfileHandle);
    add(light.sourceTextureHandle);
  }
}

/** Binding roots; transitive resource holds belong to the asset owner graph. */
export function renderableAssetRoots(
  row: Pick<
    RenderableSnapshot,
    | 'glyph'
    | 'tilemap'
    | 'terrain'
    | 'assetHandle'
    | 'skinBinding'
    | 'materialOverrides'
    | 'materials'
  >,
): readonly number[] {
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

/** Live publication edges. Both ends advance only when the source publication is accepted. */
export class PublishedAssetConsumers {
  private readonly roots = new Map<number, readonly number[]>();
  private readonly consumers = new Map<number, number | Set<number>>();

  get(entity: number): readonly number[] | undefined {
    return this.roots.get(entity);
  }

  set(entity: number, next: readonly number[]): void {
    const previous = this.roots.get(entity);
    if (
      previous === next ||
      (previous?.length === next.length && previous.every((handle, i) => handle === next[i]))
    )
      return;
    this.roots.set(entity, next);
    if (previous !== undefined) for (const handle of previous) this.unlink(handle, entity);
    for (const handle of next) {
      const owners = this.consumers.get(handle);
      if (owners === undefined) this.consumers.set(handle, entity);
      else if (typeof owners === 'number') this.consumers.set(handle, new Set([owners, entity]));
      else owners.add(entity);
    }
  }

  delete(entity: number): void {
    const previous = this.roots.get(entity);
    if (previous === undefined) return;
    this.roots.delete(entity);
    for (const handle of previous) this.unlink(handle, entity);
  }

  collect(handle: number, into: Set<number>, eligible?: ReadonlySet<number>): void {
    const owners = this.consumers.get(handle);
    if (typeof owners === 'number') {
      if (eligible === undefined || eligible.has(owners)) into.add(owners);
    } else if (owners !== undefined) {
      for (const owner of owners)
        if (eligible === undefined || eligible.has(owner)) into.add(owner);
    }
  }

  clear(): void {
    this.roots.clear();
    this.consumers.clear();
  }

  private unlink(handle: number, entity: number): void {
    const owners = this.consumers.get(handle);
    if (typeof owners === 'number') {
      if (owners === entity) this.consumers.delete(handle);
    } else if (owners?.delete(entity)) {
      if (owners.size === 0) this.consumers.delete(handle);
      else if (owners.size === 1) {
        for (const survivor of owners) this.consumers.set(handle, survivor);
      }
    }
  }
}
