import type {
  CommandBuffer,
  Result,
  RhiCommandEncoder,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { type Handle, numMipLevels, type ResultOk } from '@forgeax/engine-types';
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

function copyableExtent(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0;
}

type DynamicTextureKey = Handle<'VideoAsset', 'shared'> | object;

interface TransientEntry {
  texture: Texture;
  ready: ResultOk<TextureView>;
  width: number;
  height: number;
  mipLevelCount: number;
  generateMipmaps: boolean;
  flipY?: boolean;
  writes: number;
  version?: number | undefined;
  unsubscribe?: (() => void) | undefined;
}

function matchesCanvasView(
  entry: TransientEntry | undefined,
  view: TextureView,
  width: number,
  height: number,
): boolean {
  return (
    entry?.ready.value === view &&
    entry.width === width &&
    entry.height === height &&
    entry.generateMipmaps
  );
}

/**
 * Transient texture store for video frames and versioned Canvas sources. Independent of
 * GpuResourceStore: it neither imports nor reaches into the static residency
 * cache (AC-08 / D-3).
 */
export class DynamicTextureStore {
  private device: DynamicTextureDevice | undefined = undefined;
  private readonly entries = new Map<DynamicTextureKey, TransientEntry>();
  private generation = 0;
  /** Only successful uploads enter this queue; each token identifies the bytes to acknowledge. */
  private readonly pendingMips = new Map<TransientEntry, number>();

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
    return this.synchronize(
      key,
      source,
      width,
      height,
      options?.version,
      options?.flipY ?? true,
      options?.generateMipmaps ?? false,
      options?.signal,
    );
  }

  /** Canvas pixels have an explicit revision and a full mip chain in every realm. */
  uploadCanvasFrame(
    key: object,
    source: CopyExternalImageSource,
    width: number,
    height: number,
    version: number,
    flipY: boolean,
    signal: AbortSignal,
    boundView?: TextureView,
  ): Result<TextureView, RhiError> | undefined {
    return this.synchronize(key, source, width, height, version, flipY, true, signal, boundView);
  }

  /** A resize or a new device needs a different group even if the source token survived. */
  hasCanvasView(key: object, view: TextureView, width: number, height: number): boolean {
    return matchesCanvasView(this.entries.get(key), view, width, height);
  }

  private synchronize(
    key: DynamicTextureKey,
    source: CopyExternalImageSource,
    width: number,
    height: number,
    version: number | undefined,
    flipY: boolean,
    generateMipmaps: boolean,
    signal?: AbortSignal,
    boundView?: TextureView,
  ): Result<TextureView, RhiError> | undefined {
    const device = this.device;
    if (device === undefined) return undefined;
    const previous = this.entries.get(key);
    if (boundView !== undefined && !matchesCanvasView(previous, boundView, width, height))
      return undefined;
    if (signal?.aborted) {
      this.release(key);
      return undefined;
    }

    // Installed dimensions came from a successful allocation. Both repainting
    // this surface and drawing it again use the same physical entry.
    const generation = this.generation;
    const sameExtent = previous?.width === width && previous.height === height;
    let entry: TransientEntry;
    if (sameExtent && previous.generateMipmaps === generateMipmaps) entry = previous;
    else {
      if (!copyableExtent(width, height)) return undefined;
      const mipLevelCount = generateMipmaps ? numMipLevels({ width, height }) : 1;
      if (sameExtent && previous.mipLevelCount === mipLevelCount) entry = previous;
      else {
        const created = this.createEntry(device, width, height, mipLevelCount, generateMipmaps);
        if (!created.ok) return created;
        entry = created.value;
      }
    }
    if (
      entry === previous &&
      version !== undefined &&
      entry.version === version &&
      entry.flipY === flipY
    ) {
      entry.generateMipmaps = generateMipmaps;
      return entry.ready;
    }
    return this.copyAndPublish(
      device,
      generation,
      key,
      previous,
      entry,
      source,
      version,
      flipY,
      generateMipmaps,
      signal,
    );
  }

  /** Commit only bytes written to the current device and source lifetime. */
  private copyAndPublish(
    device: DynamicTextureDevice,
    generation: number,
    key: DynamicTextureKey,
    previous: TransientEntry | undefined,
    entry: TransientEntry,
    source: CopyExternalImageSource,
    version: number | undefined,
    flipY: boolean,
    generateMipmaps: boolean,
    signal: AbortSignal | undefined,
  ): Result<TextureView, RhiError> | undefined {
    const { width, height, writes } = entry;
    const copied = device.queue.copyExternalImageToTexture(
      { source, flipY },
      { texture: entry.texture },
      { width, height, depthOrArrayLayers: 1 },
    );
    if (!copied.ok) {
      if (entry !== previous) device.destroyTexture(entry.texture);
      return copied;
    }
    // A device hook can retire the source or replace its physical row during a copy.
    if (signal?.aborted || this.generation !== generation || this.entries.get(key) !== previous) {
      if (entry !== previous) device.destroyTexture(entry.texture);
      return undefined;
    }
    // Reentrant writes to this same texture do not establish a unique source revision.
    entry.version = entry.writes === writes ? version : undefined;
    entry.writes++;
    entry.flipY = flipY;
    entry.generateMipmaps = generateMipmaps;
    if (entry.mipLevelCount > 1) {
      this.pendingMips.set(entry, entry.writes);
    }
    if (entry !== previous) {
      this.install(key, entry, signal);
      if (previous !== undefined) {
        this.retire(device, previous);
        if (this.entries.get(key) !== entry) return undefined;
      }
    }
    return entry.ready;
  }

  private install(
    key: DynamicTextureKey,
    entry: TransientEntry,
    signal: AbortSignal | undefined,
  ): void {
    this.entries.set(key, entry);
    if (signal !== undefined) {
      const release = () => this.release(key);
      signal.addEventListener('abort', release, { once: true });
      entry.unsubscribe = () => signal.removeEventListener('abort', release);
    }
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
    const work: { entry: TransientEntry; upload: number; release: () => void }[] = [];
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
    return this.entries.get(key)?.ready.value;
  }

  /** Release one source without disturbing other videos or canvases. */
  release(key: DynamicTextureKey): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.retire(this.device, entry);
  }

  private retire(device: DynamicTextureDevice | undefined, entry: TransientEntry): void {
    this.pendingMips.delete(entry);
    entry.unsubscribe?.();
    device?.destroyTexture(entry.texture);
  }

  /** Renderer teardown or device replacement invalidates all uploaded versions. */
  destroyAll(): void {
    this.generation++;
    for (const key of this.entries.keys()) this.release(key);
  }

  private createEntry(
    device: DynamicTextureDevice,
    width: number,
    height: number,
    mipLevelCount: number,
    generateMipmaps: boolean,
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
      ready: view,
      writes: 0,
      generateMipmaps,
      width,
      height,
      mipLevelCount,
    });
  }
}
