import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { AssetHandle, TextureAsset } from '@forgeax/engine-types';
import type { Texture } from 'three/src/Three.Core.js';
import type { SharedAssetStorage } from './shared-assets';

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  let offset = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const length = Math.floor(a.byteLength / 4);
    const left = new Uint32Array(a.buffer, a.byteOffset, length);
    const right = new Uint32Array(b.buffer, b.byteOffset, length);
    for (let i = 0; i < length; i++) if (left[i] !== right[i]) return false;
    offset = length * 4;
  }
  for (; offset < a.byteLength; offset++) if (a[offset] !== b[offset]) return false;
  return true;
}

function equalSnapshots(a: TextureAsset, b: TextureAsset): boolean {
  return (
    a === b ||
    (a.shape.viewDimension === '2d' &&
      b.shape.viewDimension === '2d' &&
      a.shape.extent.width === b.shape.extent.width &&
      a.shape.extent.height === b.shape.extent.height &&
      a.format === b.format &&
      a.colorSpace === b.colorSpace &&
      a.encoding === b.encoding &&
      a.skippableMips === b.skippableMips &&
      a.mips.kind === b.mips.kind &&
      (a.mips.kind !== 'packed' ||
        (b.mips.kind === 'packed' && a.mips.levelCount === b.mips.levelCount)) &&
      equalBytes(a.data, b.data))
  );
}

/** Share accepted bytes; each Texture still decides when it accepts a revision. */
export class TextureStorage implements SharedAssetStorage<Texture, TextureAsset> {
  private readonly candidates = new WeakMap<Texture['source'], Set<AssetHandle<'texture'>>>();
  private readonly shared = new WeakSet<TextureAsset>();

  constructor(private readonly assets: AssetRegistry) {}

  find(texture: Texture, payload: TextureAsset, previous: AssetHandle<'texture'> | undefined) {
    const candidates = this.candidates.get(texture.source);
    if (candidates === undefined) return undefined;
    let match: AssetHandle<'texture'> | undefined;
    for (const handle of candidates) {
      const asset = runtimeAssets(this.assets).borrow<TextureAsset>(handle);
      if (!asset.ok) {
        candidates.delete(handle);
        continue;
      }
      if (handle === previous && !this.shared.has(asset.value)) continue;
      if (match === undefined && equalSnapshots(asset.value, payload)) {
        match = handle;
        this.shared.add(asset.value);
      }
    }
    return match;
  }

  canReplace(payload: TextureAsset): boolean {
    return !this.shared.has(payload);
  }

  record(texture: Texture, handle: AssetHandle<'texture'>): void {
    const source = texture.source;
    const handles = this.candidates.get(source);
    if (handles === undefined) this.candidates.set(source, new Set([handle]));
    else handles.add(handle);
  }
}
