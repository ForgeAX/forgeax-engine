import type {
  CommandBuffer,
  Result,
  RhiCommandEncoder,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { type Handle, numMipLevels } from '@forgeax/engine-types';
import { encodeMipmaps } from './mipmap-generator';

/**
 * The host-owned external image the engine copies an image from
 * (HTMLVideoElement / VideoFrame / ImageBitmap / canvas). Mirrors the `source`
 * member of the WebGPU `GPUCopyExternalImageSourceInfo` the RHI
 * `copyExternalImageToTexture` consumes; aliased here so the store does not pull
 * the whole webgpu descriptor type into its surface.
 */
export type CopyExternalImageSource = GPUCopyExternalImageSourceInfo['source'];

/**
 * GPUTextureUsage bits an external-image destination texture needs: COPY_DST (the
 * copyExternalImageToTexture write target), TEXTURE_BINDING (sampled in the
 * material bind group), and RENDER_ATTACHMENT (required by the WebGPU spec for
 * a copyExternalImageToTexture destination). Mirrors the literals
 * gpu-resource-store.ts uses for its upload textures (no shared const exists to
 * import without coupling the two stores — D-3 keeps them independent).
 */
const DYNAMIC_TEXTURE_USAGE = 0x2 | 0x4 | 0x10;

/** rgba8unorm-srgb: Canvas and decoded video color are sRGB; sampling returns linear. */
const DYNAMIC_TEXTURE_FORMAT = 'rgba8unorm-srgb' as const;

/**
 * The minimal RHI device surface DynamicTextureStore needs. Declared structurally
 * (not the full RhiDevice) so unit tests drive it with a small mock and the store
 * stays decoupled from the rest of the device surface (Pipeline Isolation).
 */
export interface DynamicTextureDevice {
  createTexture(desc: {
    readonly size: {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers: number;
    };
    readonly format: typeof DYNAMIC_TEXTURE_FORMAT;
    readonly usage: number;
    readonly mipLevelCount?: number;
    readonly label?: string;
  }): Result<Texture, RhiError>;
  createTextureView(texture: Texture, desc: Record<string, never>): Result<TextureView, RhiError>;
  destroyTexture(texture: Texture): Result<void, RhiError>;
  /** Record prewarmed mips into the Renderer encoder; release scratch after submit/abort. */
  encodeMipmaps?: (
    encoder: RhiCommandEncoder,
    texture: Texture,
    width: number,
    height: number,
  ) => Result<() => void, RhiError>;
  readonly queue: {
    copyExternalImageToTexture(
      source: { readonly source: CopyExternalImageSource; readonly flipY?: boolean },
      destination: { readonly texture: Texture },
      copySize: {
        readonly width: number;
        readonly height: number;
        readonly depthOrArrayLayers: number;
      },
    ): Result<void, RhiError>;
  };
}

/** Adapt the opaque RHI device to the store's intentionally small upload seam. */
export function adaptDynamicTextureDevice(device: RhiDevice): DynamicTextureDevice {
  return {
    createTexture: (descriptor) =>
      device.createTexture({
        ...descriptor,
        mipLevelCount: descriptor.mipLevelCount,
        sampleCount: undefined,
        dimension: undefined,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      }),
    createTextureView: (texture) =>
      device.createTextureView(texture, {
        label: undefined,
        format: undefined,
        dimension: undefined,
        usage: undefined,
        aspect: undefined,
        baseMipLevel: undefined,
        mipLevelCount: undefined,
        baseArrayLayer: undefined,
        arrayLayerCount: undefined,
      }),
    destroyTexture: (texture) => device.destroyTexture(texture),
    encodeMipmaps: (encoder, texture, width, height) =>
      encodeMipmaps(device, encoder, texture, { width, height, format: DYNAMIC_TEXTURE_FORMAT }),
    queue: {
      copyExternalImageToTexture: (source, destination, copySize) =>
        device.queue.copyExternalImageToTexture(
          { source: source.source, origin: [0, 0], flipY: source.flipY ?? false },
          { texture: destination.texture, origin: [0, 0, 0] },
          copySize,
        ),
    },
  };
}

type DynamicTextureKey = Handle<'VideoAsset', 'shared'> | object;

interface TransientEntry {
  texture: Texture;
  view: TextureView;
  width: number;
  height: number;
  mipLevelCount: number;
  version?: number | undefined;
  unsubscribe?: (() => void) | undefined;
}

/**
 * Transient texture store for video frames and versioned Canvas sources. Independent of
 * GpuResourceStore: it neither imports nor reaches into the static residency
 * cache (AC-08 / D-3).
 */
export class DynamicTextureStore {
  private device: DynamicTextureDevice | undefined = undefined;
  private readonly entries = new Map<DynamicTextureKey, TransientEntry>();
  /** Only successful uploads enter this queue; each token identifies the bytes to acknowledge. */
  private readonly pendingMips = new Map<TransientEntry, object>();

  /**
   * Wire the GPU device the store uploads through. Called once after the
   * renderer captures its device (mirrors GpuResourceStore.configureGpuDevice).
   * A replacement device invalidates every cached texture: the handles in the
   * map belong to the old device and cannot be reused after renderer recovery.
   */
  configureGpuDevice(device: DynamicTextureDevice): void {
    if (this.device !== undefined && this.device !== device) {
      this.destroyAll();
    }
    this.device = device;
  }

  /**
   * Upload an image for `key` from the caller-owned source image
   * (HTMLVideoElement / VideoFrame / ImageBitmap / Canvas), (re)allocating the transient
   * texture when its size changes, and return the current-frame view to bind.
   *
   * Returns `undefined` (not an error) when the device is not yet wired or the
   * source has no decodable dimensions yet (metadata pending) — the caller binds
   * the default view that frame. A structured RhiError surfaces only when a wired
   * device rejects the allocation or the copy (charter P3).
   */
  uploadFrame(
    key: DynamicTextureKey,
    source: CopyExternalImageSource,
    width: number,
    height: number,
    options?: {
      readonly version?: number | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly flipY?: boolean;
      readonly generateMipmaps?: boolean;
    },
  ): Result<TextureView, RhiError> | undefined {
    const device = this.device;
    if (device === undefined) return undefined;
    if (options?.signal?.aborted) {
      this.release(key);
      return undefined;
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
      return undefined;

    const previous = this.entries.get(key);
    const mipLevelCount = options?.generateMipmaps ? numMipLevels({ width, height }) : 1;
    const sameSize =
      previous?.width === width &&
      previous.height === height &&
      previous.mipLevelCount === mipLevelCount;
    if (sameSize && options?.version !== undefined && previous.version === options.version)
      return ok(previous.view);
    const ensured = sameSize
      ? ok(previous)
      : this.createEntry(device, width, height, mipLevelCount);
    if (!ensured.ok) return ensured;
    const entry = ensured.value;
    const copied = device.queue.copyExternalImageToTexture(
      { source, flipY: options?.flipY ?? true },
      { texture: entry.texture },
      { width, height, depthOrArrayLayers: 1 },
    );
    if (!copied.ok) {
      if (entry !== previous) device.destroyTexture(entry.texture);
      return copied;
    }
    entry.version = options?.version;
    if (entry !== previous) {
      this.release(key);
      this.entries.set(key, entry);
      const signal = options?.signal;
      if (signal !== undefined) {
        const release = () => this.release(key);
        signal.addEventListener('abort', release, { once: true });
        entry.unsubscribe = () => signal.removeEventListener('abort', release);
      }
    }
    if (mipLevelCount > 1) this.pendingMips.set(entry, {});
    return ok(entry.view);
  }

  /** Record actual uploads after scene recording, then submit their mips before scene commands. */
  prepareMipmaps(
    device: Pick<RhiDevice, 'createCommandEncoder'>,
  ):
    | Result<{ readonly buffer: CommandBuffer; complete(submitted: boolean): void }, RhiError>
    | undefined {
    if (this.pendingMips.size === 0) return undefined;
    const created = device.createCommandEncoder({ label: 'dynamic-texture-mips' });
    if (!created.ok) return created;
    const encoder = created.value;
    const work: { entry: TransientEntry; upload: object; release: () => void }[] = [];
    let finished = false;
    let completed = false;
    const complete = (submitted: boolean) => {
      if (completed) return;
      completed = true;
      for (const { entry, upload, release } of work) {
        if (submitted && this.pendingMips.get(entry) === upload) this.pendingMips.delete(entry);
        release();
      }
    };
    try {
      for (const [entry, upload] of this.pendingMips) {
        const encoded = this.device?.encodeMipmaps?.(
          encoder,
          entry.texture,
          entry.width,
          entry.height,
        );
        if (encoded === undefined || !encoded.ok) {
          complete(false);
          return (
            encoded ??
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'dynamic mipmap encoder is configured',
                hint: 'use adaptDynamicTextureDevice with prewarmed mipmap pipelines',
              }),
            )
          );
        }
        work.push({ entry, upload, release: encoded.value });
      }
      finished = true;
      const result = encoder.finish();
      if (!result.ok) {
        complete(false);
        return result;
      }
      return ok({ buffer: result.value, complete });
    } catch (cause) {
      complete(false);
      throw cause;
    } finally {
      if (!finished) encoder.finish();
    }
  }

  /**
   * The current-frame view for a clip, if one has been uploaded this session,
   * else undefined. The record stage reads this when assembling the bind group
   * (a frame that has not uploaded yet falls back to the default view).
   */
  getView(key: DynamicTextureKey): TextureView | undefined {
    return this.entries.get(key)?.view;
  }

  /** Release one source without disturbing other videos or canvases. */
  release(key: DynamicTextureKey): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.pendingMips.delete(entry);
    entry.unsubscribe?.();
    this.device?.destroyTexture(entry.texture);
    this.entries.delete(key);
  }

  /** Renderer teardown or device replacement invalidates all uploaded versions. */
  destroyAll(): void {
    for (const key of this.entries.keys()) this.release(key);
  }

  private createEntry(
    device: DynamicTextureDevice,
    width: number,
    height: number,
    mipLevelCount: number,
  ): Result<TransientEntry, RhiError> {
    const texture = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: DYNAMIC_TEXTURE_FORMAT,
      usage: DYNAMIC_TEXTURE_USAGE,
      mipLevelCount,
      label: 'dynamic-texture',
    });
    if (!texture.ok) return texture;
    const view = device.createTextureView(texture.value, {});
    if (!view.ok) {
      device.destroyTexture(texture.value);
      return view;
    }
    return ok({
      texture: texture.value,
      view: view.value,
      width,
      height,
      mipLevelCount,
    });
  }
}
