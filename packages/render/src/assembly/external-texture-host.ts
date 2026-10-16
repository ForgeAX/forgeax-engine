import type { DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import { videoSourceExtent } from '@forgeax/engine-graphics-extras';
import type {
  RhiBindingResource,
  RhiDevice,
  RhiError,
  ExternalTexture as RhiExternalTexture,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  ExternalTextureInvalidError,
  type ExternalTextureInvalidReason,
  ExternalTextureStateInvalidError,
  type ExternalTextureStateInvalidReason,
  type RenderError,
} from '../errors/render';
import type { RenderResult } from '../render-contract';
import {
  createExternalTextureSource,
  type ExternalTexture,
  type ExternalTextureBinder,
  type ExternalTextureInput,
  type ExternalTextureKind,
  type ExternalTextureSource,
} from '../textures/external-texture';

/**
 * Formats a material slot samples as filterable float without extra features.
 * Other formats (depth, integer, 32-bit float, compressed) need a dedicated
 * pipeline and are rejected at import.
 */
const MATERIAL_SAMPLEABLE_FORMATS: ReadonlySet<GPUTextureFormat> = new Set<GPUTextureFormat>([
  'r8unorm',
  'rg8unorm',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'bgra8unorm',
  'bgra8unorm-srgb',
  'rgb10a2unorm',
  'rg11b10ufloat',
  'r16float',
  'rg16float',
  'rgba16float',
]);
const TEXTURE_BINDING = 0x04;

export interface ExternalTextureHostOptions {
  readonly getDevice: () => RhiDevice;
  readonly getGeneration: () => number;
  /** Renderer health owns loss; the RHI importer never subscribes to `device.lost`. */
  readonly isDeviceLost: () => boolean;
  readonly getDynamicTextureStore: () => DynamicTextureStore;
  readonly onError: (error: RenderError | RhiError) => void;
}

interface ImportedGpuTexture {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly device: RhiDevice;
}

interface Entry {
  readonly source: ExternalTextureSource;
  input: ExternalTextureInput;
  imported: ImportedGpuTexture | undefined;
  generation: number;
  version: number;
  lifetime: AbortController;
  released: boolean;
  reported: ExternalTextureStateInvalidReason | undefined;
  /** Copy-path keys: ordinary slots flip to UV-up, texture_external slots keep source orientation. */
  readonly copyKeys: { readonly flipped: object; readonly direct: object };
}

export interface ExternalTextureHost extends ExternalTextureBinder {
  importTexture(input: ExternalTextureInput): Promise<RenderResult<ExternalTexture, RenderError>>;
  nativeDevice(): RenderResult<GPUDevice, RenderError>;
  beginFrame(): void;
  /** Called at generation publication: GPU-texture imports become stale; video sources survive. */
  recover(): void;
  dispose(): void;
}

function invalid(
  operation: 'import' | 'replace' | 'native-device',
  kind: ExternalTextureKind,
  reason: ExternalTextureInvalidReason,
  actual: string,
  expected: string,
  hint: string,
): ExternalTextureInvalidError {
  return new ExternalTextureInvalidError({ operation, kind, reason, actual }, expected, hint);
}

function isVideoFrame(source: unknown): source is VideoFrame {
  return typeof VideoFrame !== 'undefined' && source instanceof VideoFrame;
}

function isVideoSource(source: unknown): source is HTMLVideoElement | VideoFrame {
  return (
    isVideoFrame(source) ||
    (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement)
  );
}

function rhiImportReason(error: RhiError): ExternalTextureInvalidReason {
  switch (error.code) {
    case 'rhi-not-available':
      return 'device-mismatch';
    case 'device-lost':
      return 'device-lost';
    case 'feature-not-enabled':
      return 'capability-absent';
    default:
      return 'usage';
  }
}

function validateGpuTextureShape(
  operation: 'import' | 'replace',
  texture: GPUTexture,
): ExternalTextureInvalidError | undefined {
  if (typeof texture !== 'object' || texture === null || typeof texture.createView !== 'function') {
    return invalid(
      operation,
      'gpu-texture',
      'source-unsupported',
      typeof texture,
      'a native GPUTexture',
      'pass the GPUTexture returned by renderer.nativeDevice().createTexture()',
    );
  }
  if (!MATERIAL_SAMPLEABLE_FORMATS.has(texture.format)) {
    return invalid(
      operation,
      'gpu-texture',
      'format',
      texture.format,
      `one of ${[...MATERIAL_SAMPLEABLE_FORMATS].join(', ')}`,
      'create the texture with a filterable color format a material slot can sample',
    );
  }
  if (texture.dimension !== '2d' || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    return invalid(
      operation,
      'gpu-texture',
      'dimension',
      `${texture.dimension} x${texture.depthOrArrayLayers} samples=${texture.sampleCount}`,
      'a single-sampled 2d texture with depthOrArrayLayers === 1',
      'material slots bind one 2d view; resolve MSAA and pick one layer before import',
    );
  }
  if ((texture.usage & TEXTURE_BINDING) === 0) {
    return invalid(
      operation,
      'gpu-texture',
      'usage',
      `0x${texture.usage.toString(16)}`,
      'usage includes GPUTextureUsage.TEXTURE_BINDING',
      'recreate the texture with TEXTURE_BINDING',
    );
  }
  return undefined;
}

export function createExternalTextureHost(
  options: ExternalTextureHostOptions,
): ExternalTextureHost {
  const entries = new WeakMap<ExternalTextureSource, Entry>();
  const live = new Set<Entry>();
  const foreignReported = new WeakSet<ExternalTextureSource>();
  const failedVideoImports = new WeakSet<HTMLVideoElement | VideoFrame>();
  let frameImports = new Map<HTMLVideoElement | VideoFrame, RhiExternalTexture | null>();

  const dropImported = (entry: Entry): void => {
    const imported = entry.imported;
    entry.imported = undefined;
    if (imported === undefined) return;
    // Borrowed RHI textures only release bookkeeping; the native texture is the caller's.
    imported.device.destroyTexture(imported.texture);
  };

  const stateError = (
    entry: Entry,
    operation: 'bind' | 'replace' | 'release',
  ): ExternalTextureStateInvalidError | undefined => {
    if (entry.released) {
      return new ExternalTextureStateInvalidError({
        operation,
        reason: 'released',
        generation: entry.generation,
      });
    }
    if (operation === 'bind' && entry.input.kind === 'gpu-texture') {
      if (entry.generation !== options.getGeneration() || entry.imported === undefined) {
        return new ExternalTextureStateInvalidError({
          operation,
          reason: 'stale-generation',
          generation: entry.generation,
        });
      }
    }
    return undefined;
  };

  const admit = async (
    operation: 'import' | 'replace',
    input: ExternalTextureInput,
  ): Promise<RenderResult<ImportedGpuTexture | undefined, RenderError>> => {
    if (input.kind === 'video') {
      if (!isVideoSource(input.source)) {
        return {
          ok: false,
          error: invalid(
            operation,
            'video',
            'source-unsupported',
            Object.prototype.toString.call(input.source),
            'an HTMLVideoElement or VideoFrame',
            'pass a media element or a VideoFrame; canvases use CanvasTexture',
          ),
        };
      }
      return { ok: true, value: undefined };
    }
    const device = options.getDevice();
    if (!device.caps.textureImport) {
      return {
        ok: false,
        error: invalid(
          operation,
          'gpu-texture',
          'capability-absent',
          `backend=${device.caps.backendKind}`,
          'caps.textureImport === true',
          'GPUTexture import needs the WebGPU backend; upload pixels through a TextureAsset instead',
        ),
      };
    }
    const shape = validateGpuTextureShape(operation, input.texture);
    if (shape !== undefined) return { ok: false, error: shape };
    const lost = () =>
      invalid(
        operation,
        'gpu-texture',
        'device-lost',
        'renderer device lost',
        'the importing device is alive',
        'recover the renderer and import a texture created on its new device',
      );
    if (options.isDeviceLost()) return { ok: false, error: lost() };
    const imported = await device.importTexture(input.texture);
    if (!imported.ok) {
      return {
        ok: false,
        error: invalid(
          operation,
          'gpu-texture',
          rhiImportReason(imported.error),
          imported.error.code,
          imported.error.expected ?? 'an importable texture',
          imported.error.hint ?? 'create the texture on renderer.nativeDevice()',
        ),
      };
    }
    if (options.isDeviceLost()) {
      device.destroyTexture(imported.value);
      return { ok: false, error: lost() };
    }
    if (options.getDevice() !== device) {
      device.destroyTexture(imported.value);
      return {
        ok: false,
        error: invalid(
          operation,
          'gpu-texture',
          'device-lost',
          'device replaced during import',
          'the importing device stays current',
          'create the texture on the recovered renderer.nativeDevice() and import again',
        ),
      };
    }
    const view = device.createTextureView(imported.value, { dimension: '2d' });
    if (!view.ok) {
      device.destroyTexture(imported.value);
      return {
        ok: false,
        error: invalid(
          operation,
          'gpu-texture',
          'usage',
          view.error.code,
          'a 2d view of the imported texture',
          view.error.hint ?? 'recreate the texture with TEXTURE_BINDING',
        ),
      };
    }
    return { ok: true, value: { texture: imported.value, view: view.value, device } };
  };

  const handleFor = (entry: Entry): ExternalTexture => ({
    source: entry.source,
    get kind() {
      return entry.input.kind;
    },
    async replace(input) {
      const blocked = stateError(entry, 'replace');
      if (blocked !== undefined) return { ok: false, error: blocked };
      const admitted = await admit('replace', input);
      if (!admitted.ok) return admitted;
      if (entry.released) {
        if (admitted.value !== undefined)
          admitted.value.device.destroyTexture(admitted.value.texture);
        return {
          ok: false,
          error: new ExternalTextureStateInvalidError({
            operation: 'replace',
            reason: 'released',
            generation: entry.generation,
          }),
        };
      }
      dropImported(entry);
      if (
        entry.input.kind !== input.kind ||
        (input.kind === 'video' && !isVideoFrame(input.source))
      ) {
        entry.lifetime.abort();
        entry.lifetime = new AbortController();
      }
      entry.input = input;
      entry.imported = admitted.value;
      entry.generation = options.getGeneration();
      entry.version += 1;
      entry.reported = undefined;
      return { ok: true, value: undefined };
    },
    release() {
      const blocked = stateError(entry, 'release');
      if (blocked !== undefined) return { ok: false, error: blocked };
      entry.released = true;
      entry.lifetime.abort();
      dropImported(entry);
      live.delete(entry);
      return { ok: true, value: undefined };
    },
  });

  /** `undefined`: capability absent (copy path); `null`: the source failed to import this frame. */
  const importFrame = (
    source: HTMLVideoElement | VideoFrame,
  ): { readonly external: RhiExternalTexture | null; readonly error?: RhiError } | undefined => {
    const device = options.getDevice();
    if (!device.caps.externalTexture) return undefined;
    const memo = frameImports.get(source);
    if (memo !== undefined) return { external: memo };
    const imported = device.importExternalTexture({ source, label: 'forgeax:external-video' });
    frameImports.set(source, imported.ok ? imported.value : null);
    return imported.ok ? { external: imported.value } : { external: null, error: imported.error };
  };

  const importVideoFrame = (
    source: HTMLVideoElement | VideoFrame,
  ): RhiExternalTexture | undefined => {
    const imported = importFrame(source);
    if (imported?.error !== undefined && !failedVideoImports.has(source)) {
      failedVideoImports.add(source);
      options.onError(imported.error);
    } else if (imported?.external) failedVideoImports.delete(source);
    return imported?.external ?? undefined;
  };

  const copyVideo = (
    entry: Entry,
    source: HTMLVideoElement | VideoFrame,
    slotExternal: boolean,
  ): RhiBindingResource | undefined => {
    const store = options.getDynamicTextureStore();
    const key = slotExternal ? entry.copyKeys.direct : entry.copyKeys.flipped;
    const extent = videoSourceExtent(source);
    if (extent === undefined) {
      const lkg = store.getView(key);
      return lkg === undefined ? undefined : { kind: 'textureView', value: lkg };
    }
    const uploaded = store.uploadFrame(key, source, extent.width, extent.height, {
      version: isVideoFrame(source) ? entry.version : undefined,
      signal: entry.lifetime.signal,
      flipY: !slotExternal,
    });
    if (uploaded !== undefined && !uploaded.ok) options.onError(uploaded.error);
    const view = uploaded?.ok ? uploaded.value : store.getView(key);
    return view === undefined ? undefined : { kind: 'textureView', value: view };
  };

  return {
    async importTexture(input) {
      const admitted = await admit('import', input);
      if (!admitted.ok) return admitted;
      const entry: Entry = {
        source: createExternalTextureSource(),
        input,
        imported: admitted.value,
        generation: options.getGeneration(),
        version: 1,
        lifetime: new AbortController(),
        released: false,
        reported: undefined,
        copyKeys: { flipped: {}, direct: {} },
      };
      entries.set(entry.source, entry);
      live.add(entry);
      return { ok: true, value: handleFor(entry) };
    },
    nativeDevice() {
      const native = options.getDevice().nativeDevice();
      if (native.ok) return native;
      return {
        ok: false,
        error: invalid(
          'native-device',
          'gpu-texture',
          'capability-absent',
          native.error.code,
          'a WebGPU-backed renderer',
          'the active backend exposes no GPUDevice; check caps.textureImport before sharing textures',
        ),
      };
    },
    resolve(source, slotExternal) {
      const entry = entries.get(source);
      if (entry === undefined) {
        if (!foreignReported.has(source)) {
          foreignReported.add(source);
          options.onError(
            new ExternalTextureStateInvalidError({
              operation: 'bind',
              reason: 'foreign-renderer',
              generation: options.getGeneration(),
            }),
          );
        }
        return undefined;
      }
      const blocked = stateError(entry, 'bind');
      if (blocked !== undefined) {
        if (entry.reported !== blocked.detail.reason) {
          entry.reported = blocked.detail.reason;
          options.onError(blocked);
        }
        return undefined;
      }
      const input = entry.input;
      if (input.kind === 'gpu-texture') {
        return entry.imported === undefined
          ? undefined
          : { kind: 'textureView', value: entry.imported.view };
      }
      if (slotExternal) {
        const imported = importFrame(input.source);
        if (imported?.external) {
          entry.reported = undefined;
          return { kind: 'externalTexture', value: imported.external };
        }
        if (imported !== undefined) {
          if (entry.reported !== 'source-expired') {
            entry.reported = 'source-expired';
            options.onError(
              new ExternalTextureStateInvalidError({
                operation: 'bind',
                reason: 'source-expired',
                generation: entry.generation,
              }),
            );
          }
          return undefined;
        }
      }
      return copyVideo(entry, input.source, slotExternal);
    },
    importVideoFrame,
    beginFrame() {
      if (frameImports.size > 0) frameImports = new Map();
    },
    recover() {
      frameImports = new Map();
      for (const entry of live) if (entry.input.kind === 'gpu-texture') entry.imported = undefined;
    },
    dispose() {
      frameImports = new Map();
      for (const entry of live) {
        entry.released = true;
        entry.lifetime.abort();
        dropImported(entry);
      }
      live.clear();
    },
  };
}
