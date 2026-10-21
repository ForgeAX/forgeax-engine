import type { ExternalTexture as NativeExternalTexture, Renderer } from '@forgeax/engine-render';
import type { MaterialTextureValue } from '@forgeax/engine-types';
import {
  ExternalTexture,
  SRGBColorSpace,
  type Texture,
  VideoTexture,
} from 'three/src/Three.Core.js';
import { unsupported } from './errors';

export function isExternalTexture(texture: Texture): texture is ExternalTexture | VideoTexture {
  return texture instanceof ExternalTexture || texture instanceof VideoTexture;
}

/** Async native import owns the device object; this map retains source leases only. */
export class ExternalTextures {
  private readonly entries = new Map<
    Texture,
    {
      input: unknown;
      native: NativeExternalTexture | undefined;
      pending: Promise<void>;
      dispose: () => void;
    }
  >();
  private disposed = false;
  constructor(private readonly renderer: Renderer) {}

  async initialize(texture: ExternalTexture | VideoTexture): Promise<void> {
    const input =
      texture instanceof ExternalTexture
        ? (texture.sourceTexture as GPUTexture | null)
        : texture.image;
    if (input === null)
      return unsupported('ExternalTexture.sourceTexture is required', texture.uuid).unwrap();
    if (
      texture instanceof VideoTexture &&
      (texture.colorSpace !== SRGBColorSpace || !texture.flipY)
    )
      return unsupported(
        'Native video in ordinary material slots requires sRGB and flipY=true',
        texture.uuid,
      ).unwrap();
    const previous = this.entries.get(texture);
    if (previous?.input === input) return previous.pending;
    if (previous !== undefined) this.retire(texture);
    const entry = {
      input,
      native: undefined as NativeExternalTexture | undefined,
      pending: Promise.resolve(),
      dispose: () => this.retire(texture),
    };
    this.entries.set(texture, entry);
    texture.addEventListener('dispose', entry.dispose);
    entry.pending = (async () => {
      const imported = await this.renderer.importTexture(
        texture instanceof ExternalTexture
          ? { kind: 'gpu-texture', texture: input as GPUTexture }
          : { kind: 'video', source: input as HTMLVideoElement },
      );
      if (!imported.ok) throw imported.error;
      const native = imported.value;
      if (this.disposed || this.entries.get(texture) !== entry) {
        const released = native.release();
        if (!released.ok) throw released.error;
      } else entry.native = native;
    })().catch((error: unknown) => {
      if (this.entries.get(texture) === entry) this.retire(texture);
      throw error;
    });
    return entry.pending;
  }

  binding(texture: Texture): MaterialTextureValue {
    const entry = this.entries.get(texture);
    const input = texture instanceof ExternalTexture ? texture.sourceTexture : texture.image;
    if (entry?.native === undefined || entry.input !== input)
      return unsupported(
        'External texture is not admitted; await renderer.initTextureAsync(texture) or renderer.renderAsync(scene, camera)',
        texture.uuid,
      ).unwrap();
    return { source: entry.native.source };
  }

  private retire(texture: Texture): void {
    const entry = this.entries.get(texture);
    if (entry === undefined) return;
    this.entries.delete(texture);
    texture.removeEventListener('dispose', entry.dispose);
    const released = entry.native?.release();
    if (released !== undefined && !released.ok) throw released.error;
  }
  dispose(): void {
    this.disposed = true;
    for (const texture of this.entries.keys()) this.retire(texture);
  }
}
