import {
  type CanvasTextureSource,
  CanvasTexture as NativeCanvasTexture,
} from '@forgeax/engine-render';
import {
  CanvasTexture,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
} from 'three/src/Three.Core.js';
import { textureUploadPending, validateTexture } from './texture';

type Canvas = HTMLCanvasElement | OffscreenCanvas;

interface CanvasBinding {
  readonly texture: Texture;
  readonly image: Canvas;
  readonly flipY: boolean;
  readonly native: NativeCanvasTexture;
  readonly invalidate: () => void;
  version: number | undefined;
  seen: number;
  pins: number;
}

function supportsCanvasTexture(texture: Texture): boolean {
  return (
    typeof VideoFrame !== 'undefined' &&
    texture.colorSpace === SRGBColorSpace &&
    texture.format === RGBAFormat &&
    texture.type === UnsignedByteType &&
    !texture.premultiplyAlpha &&
    texture.generateMipmaps &&
    texture.mipmaps.length === 0 &&
    texture.onUpdate === null
  );
}

function canvasImage(texture: Texture): Canvas | undefined {
  const image: unknown = texture.image;
  if (
    (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas)
  )
    return image;
  return undefined;
}

/** Holds only Canvas bindings used by this projection, including retained draws. */
export class CanvasTextures {
  private readonly current = new WeakMap<Texture, CanvasBinding>();
  private readonly sources = new Map<CanvasTextureSource, CanvasBinding>();
  private readonly created: CanvasBinding[] = [];
  private epoch = 0;

  begin(): void {
    this.epoch++;
  }

  prepare(
    texture: Texture,
    hasAcceptedSnapshot: (texture: Texture) => boolean,
  ): CanvasTextureSource | undefined {
    if (!(texture instanceof CanvasTexture)) return;
    const previous = this.current.get(texture);
    const pending = textureUploadPending(texture);
    if (previous !== undefined && (previous.version === texture.version || pending)) {
      validateTexture(texture).unwrap();
      previous.seen = this.epoch;
      return previous.native.source;
    }
    if (pending || !supportsCanvasTexture(texture) || hasAcceptedSnapshot(texture)) return;
    validateTexture(texture).unwrap();
    const image = canvasImage(texture);
    if (image === undefined || image.width === 0 || image.height === 0) return;
    try {
      if (previous?.image === image && previous.flipY === texture.flipY) {
        previous.native.update();
        previous.version = texture.version;
        previous.seen = this.epoch;
        return previous.native.source;
      }
      const native = new NativeCanvasTexture(image, { flipY: texture.flipY, snapshot: true });
      const entry: CanvasBinding = {
        texture,
        image,
        flipY: texture.flipY,
        native,
        invalidate: () => {
          entry.version = undefined;
        },
        version: texture.version,
        seen: this.epoch,
        pins: 0,
      };
      texture.addEventListener('dispose', entry.invalidate);
      this.current.set(texture, entry);
      this.sources.set(native.source, entry);
      this.created.push(entry);
      return native.source;
    } catch (error) {
      if (!(error instanceof DOMException || error instanceof TypeError)) throw error;
      return undefined;
    }
  }

  retain(source: CanvasTextureSource, pin: boolean): (() => void) | undefined {
    const entry = this.sources.get(source);
    if (entry === undefined) return;
    entry.seen = this.epoch;
    if (!pin) return;
    entry.pins++;
    return () => {
      entry.pins--;
    };
  }

  commit(sweep: boolean): void {
    this.created.length = 0;
    if (sweep)
      for (const entry of this.sources.values())
        if (entry.pins === 0 && entry.seen !== this.epoch) this.release(entry);
  }

  abort(): void {
    for (const entry of this.created) this.release(entry);
    this.created.length = 0;
  }

  dispose(): void {
    this.abort();
    for (const entry of this.sources.values()) this.release(entry);
  }

  private release(entry: CanvasBinding): void {
    if (this.current.get(entry.texture) === entry) this.current.delete(entry.texture);
    this.sources.delete(entry.native.source);
    entry.texture.removeEventListener('dispose', entry.invalidate);
    entry.native.dispose();
  }
}
