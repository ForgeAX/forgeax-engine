/**
 * Basis transcoder glue: lazy-init singleton (D-10) + per-mip KTX2 transcode.
 *
 * `initBasisTranscoder` dynamic-imports the self-built transcoder WASM module on
 * first call and caches it; the second call returns the same instance without
 * re-importing (D-10 main-thread lazy-init -- `Engine.create` does not preload,
 * the first Basis payload triggers this). Each realm that runs transcode tasks
 * holds its own instance (see `textureTranscodeTask`). Both node and browser
 * can `import` this module: the WASM glue is a MODULARIZE factory whose `.mjs`
 * path resolves in both.
 *
 * `transcodeKtx2` opens a parsed KTX2 container's raw bytes as a basis KTX2File,
 * starts transcoding, and transcodes every mip level (mip-major) into the target
 * `GPUTextureFormat`. It returns the block (or pixel) byte arrays per level; it
 * does not upload -- the runtime upload path (M5) consumes these with the block
 * table.
 */

import type { CodecResult } from './errors.js';
import { codecError } from './errors.js';
import { type Ktx2Parsed, ktx2ChannelLanes } from './ktx2.js';
import { transcodeTargetSpecs } from './transcode.js';
import type {
  BasisFile,
  BasisModuleFactory,
  BasisTranscoderModule,
  BasisWasmHost,
} from './wasm/basis-types.js';

/** How the transcoder WASM module is loaded. Overridable in tests. */
type TranscoderImporter = (host?: BasisWasmHost) => Promise<BasisTranscoderModule>;

function traceBasisPhase(phase: string, detail?: Readonly<Record<string, unknown>>): void {
  const sink = (
    globalThis as typeof globalThis & {
      __forgeaxAssetLoadTrace?: (event: {
        readonly phase: string;
        readonly at: number;
        readonly detail?: Readonly<Record<string, unknown>>;
      }) => void;
    }
  ).__forgeaxAssetLoadTrace;
  if (sink === undefined) return;
  try {
    sink({ phase: `codec.${phase}`, at: Date.now(), ...(detail === undefined ? {} : { detail }) });
  } catch {
    // Diagnostics must never change codec behavior.
  }
}

type BasisFactoryModule = {
  readonly default: BasisModuleFactory<BasisTranscoderModule>;
  readonly compileBasisWasm?: () => Promise<WebAssembly.Module | undefined>;
};

let compiled: Promise<WebAssembly.Module | undefined> | undefined;

/**
 * The transcoder WASM compiled once per realm, or `undefined` where the Host
 * loads it another way. Realms that receive the module instantiate it without
 * fetching or compiling again.
 */
export function compileBasisTranscoderWasm(): Promise<WebAssembly.Module | undefined> {
  compiled ??= import('@forgeax/engine-codec/basis-factory')
    .then((factory) => (factory as BasisFactoryModule).compileBasisWasm?.())
    .catch(() => undefined);
  return compiled;
}

/** A Host that instantiates an already compiled transcoder module. */
export function compiledBasisHost(module: WebAssembly.Module): BasisWasmHost {
  return {
    readWasm: () => Promise.reject(new Error('a compiled Basis module carries no bytes')),
    instantiate: async (imports) => ({
      instance: await WebAssembly.instantiate(module, imports as WebAssembly.Imports),
      module,
    }),
  };
}

const defaultImporter: TranscoderImporter = async (host) => {
  traceBasisPhase('basis.glue.import.start');
  const factory = (await import('@forgeax/engine-codec/basis-factory')).default;
  traceBasisPhase('basis.glue.import.complete');
  traceBasisPhase('basis.wasm.factory.start');
  if (host === undefined) {
    const module = await compileBasisTranscoderWasm();
    if (module !== undefined) host = compiledBasisHost(module);
  }
  const mod = host === undefined ? await factory() : await instantiateOnHost(factory, host);
  traceBasisPhase('basis.wasm.factory.complete');
  traceBasisPhase('basis.initialize.start');
  mod.initializeBasis();
  traceBasisPhase('basis.initialize.complete');
  return mod;
};

function instantiateOnHost(
  factory: BasisModuleFactory<BasisTranscoderModule>,
  host: BasisWasmHost,
): Promise<BasisTranscoderModule> {
  // Emscripten's callback accepts success only. Settle the owning promise on
  // asynchronous Host failure, while preserving the entire factory/finalizer.
  return new Promise((resolve, reject) => {
    factory({
      readWasm: () => host.readWasm(),
      instantiateWasm(
        imports: Parameters<BasisWasmHost['instantiate']>[0],
        receiveInstance: (
          instance: { readonly exports: Record<string, unknown> },
          module?: unknown,
        ) => void,
      ) {
        Promise.resolve()
          .then(() => host.instantiate(imports))
          .then(({ instance, module }) => receiveInstance(instance, module))
          .catch(reject);
        return {};
      },
      onAbort(cause: unknown) {
        // The generated default abort constructor uses global WebAssembly.
        // Its documented hook keeps native failure independent of that global.
        throw new Error('Basis runtime aborted', { cause });
      },
    }).then(resolve, reject);
  });
}

let importer: TranscoderImporter = defaultImporter;

/**
 * Lazy-init singleton (D-10): null = never attempted, Promise = init in flight,
 * resolved = ready, rejected = cleared so the next call retries.
 * @internal
 */
let _initPromise: Promise<BasisTranscoderModule> | null = null;

/**
 * Lazy-init the Basis transcoder WASM module (D-10 main-thread singleton).
 * First call dynamic-imports + initializes; subsequent calls return the cache.
 * Native Hosts pass their immutable package instantiator before any transcode;
 * `forgeax-native` selects the generated Emscripten factory for bundling.
 */
export function initBasisTranscoder(host?: BasisWasmHost): Promise<BasisTranscoderModule> {
  if (_initPromise !== null) return _initPromise;
  traceBasisPhase('basis.init.start');
  _initPromise = importer(host).catch((cause: unknown) => {
    _initPromise = null;
    throw new Error('codec-init-failed', { cause });
  });
  return _initPromise;
}

/**
 * Test-only: reset the lazy singleton and optionally override the importer.
 * Call with no argument to restore the real WASM importer.
 * @internal
 */
export function _setBasisTranscoderImporter(next?: TranscoderImporter): void {
  importer = next ?? defaultImporter;
  _initPromise = null;
}

/** One transcoded mip level (mip-major output). */
export interface TranscodedMip {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  /** Transcoded block (compressed) or pixel (uncompressed) bytes for this level. */
  readonly data: Uint8Array;
}

/** Result of transcoding a KTX2 container into a target GPU format. */
export interface TranscodedTexture {
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  /** Mip levels, base (level 0 / largest) first. */
  readonly mips: readonly TranscodedMip[];
}

export interface BasisSourceMeta {
  readonly colorSpace: 'srgb' | 'linear';
}

export interface BasisSourceInspection {
  readonly colorSpace: BasisSourceMeta['colorSpace'];
  readonly profile: 'etc1s' | 'uastc-ldr';
  readonly width: number;
  readonly height: number;
  readonly levelCount: number;
  readonly imageCount: number;
}

/** Inspect a raw Basis source without inferring color from the binary payload. */
export function inspectBasisSource(
  file: BasisFile,
  meta: Partial<BasisSourceMeta>,
  profile: BasisSourceInspection['profile'],
): CodecResult<BasisSourceInspection> {
  if (meta.colorSpace !== 'srgb' && meta.colorSpace !== 'linear') {
    return codecError('ktx2-parse-failed', {
      reason: 'raw Basis source requires Meta.colorSpace=srgb|linear',
    });
  }
  if (file.getNumImages() <= 0 || file.getNumLevels(0) <= 0) {
    return codecError('ktx2-parse-failed', { reason: 'invalid raw Basis source shape' });
  }
  return {
    ok: true,
    value: {
      colorSpace: meta.colorSpace,
      profile,
      width: file.getImageWidth(0, 0),
      height: file.getImageHeight(0, 0),
      levelCount: file.getNumLevels(0),
      imageCount: file.getNumImages(),
    },
  };
}

/** Keep raw Basis and KTX2 output bytes faithful to the selected GPU format; `lanes`
 * names the RGBA decode lane of each source channel. */
function projectChannels(
  data: Uint8Array,
  channels: 1 | 2 | undefined,
  lanes: readonly number[] = [0, 1],
): Uint8Array {
  if (channels === undefined) return data;
  const packed = new Uint8Array((data.length / 4) * channels);
  for (let pixel = 0; pixel < data.length / 4; pixel++) {
    for (let channel = 0; channel < channels; channel++) {
      packed[pixel * channels + channel] = data[pixel * 4 + (lanes[channel] ?? channel)] as number;
    }
  }
  return packed;
}

/** `projectChannels` writing into caller-owned memory. */
function projectChannelsInto(
  data: Uint8Array,
  channels: 1 | 2,
  lanes: readonly number[],
  out: Uint8Array,
): void {
  const pixels = data.length / 4;
  for (let pixel = 0; pixel < pixels; pixel++) {
    for (let channel = 0; channel < channels; channel++) {
      out[pixel * channels + channel] = data[pixel * 4 + (lanes[channel] ?? channel)] as number;
    }
  }
}

/** One level of a packed texture; levels follow each other base first. */
export interface PackedTextureLevel {
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

/** A transcoded texture whose levels share one contiguous buffer. */
export interface PackedTranscodedTexture {
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly levels: readonly PackedTextureLevel[];
  /** Every level, base first, without padding. */
  readonly data: Uint8Array;
}

/** Cooperative checkpoint offered between levels. */
export interface TranscodeCheckpoint {
  readonly aborted: boolean;
  yield(): Promise<void>;
}

function transcodeAborted(): Error {
  const error = new Error('texture transcode cancelled');
  error.name = 'AbortError';
  return error;
}

/** Concatenate per-level output into one buffer. */
export function packTranscodedTexture(texture: TranscodedTexture): PackedTranscodedTexture {
  const length = texture.mips.reduce((total, mip) => total + mip.data.byteLength, 0);
  const data = new Uint8Array(length);
  let offset = 0;
  for (const mip of texture.mips) {
    data.set(mip.data, offset);
    offset += mip.data.byteLength;
  }
  return {
    format: texture.format,
    width: texture.width,
    height: texture.height,
    levels: texture.mips.map((mip) => ({
      width: mip.width,
      height: mip.height,
      byteLength: mip.data.byteLength,
    })),
    data,
  };
}

/**
 * `transcodeKtx2` writing every level straight into one buffer. Between levels
 * it passes `checkpoint`, and stops with an `AbortError` once that is aborted.
 * Output bytes are identical to `transcodeKtx2` concatenated base first.
 */
export async function transcodeKtx2Packed(
  parsed: Ktx2Parsed,
  targetFormat: GPUTextureFormat,
  checkpoint?: TranscodeCheckpoint,
): Promise<CodecResult<PackedTranscodedTexture>> {
  traceBasisPhase('ktx2.transcode.start', { targetFormat });
  let mod: BasisTranscoderModule;
  try {
    mod = await initBasisTranscoder();
  } catch {
    return codecError('codec-init-failed', { stage: 'dynamic-import-basis-transcoder' });
  }

  const target = transcodeTargetSpecs[targetFormat];
  if (target === undefined) {
    return codecError('transcode-failed', {
      sourceFormat: `dfd-model-${parsed.dfd?.colorModel ?? 'unknown'}`,
      targetFormat,
    });
  }

  const targetEnum = mod.transcoder_texture_format[target.basis].value;
  const { lanes } = ktx2ChannelLanes(parsed);
  const channels = target.channels;
  const file = new mod.KTX2File(parsed.rawBytes);
  try {
    traceBasisPhase('ktx2.file.start');
    if (!file.isValid()) {
      return codecError('transcode-failed', {
        sourceFormat: 'invalid-ktx2-file',
        targetFormat,
      });
    }
    if (file.startTranscoding() === 0) {
      return codecError('transcode-failed', {
        sourceFormat: 'start-transcoding-failed',
        targetFormat,
      });
    }

    const count = file.getLevels();
    traceBasisPhase('ktx2.file.ready', { levels: count });
    const levels: PackedTextureLevel[] = [];
    const decoded: number[] = [];
    let length = 0;
    let scratch = 0;
    for (let level = 0; level < count; level++) {
      const info = file.getImageLevelInfo(level, 0, 0);
      const size = file.getImageTranscodedSizeInBytes(level, 0, 0, targetEnum);
      const byteLength = channels === undefined ? size : (size / 4) * channels;
      levels.push({ width: info.origWidth, height: info.origHeight, byteLength });
      decoded.push(size);
      length += byteLength;
      scratch = Math.max(scratch, size);
    }
    const data = new Uint8Array(length);
    const rgba = channels === undefined ? undefined : new Uint8Array(scratch);
    let offset = 0;
    for (let level = 0; level < count; level++) {
      if (level > 0) await checkpoint?.yield();
      if (checkpoint?.aborted) throw transcodeAborted();
      const size = decoded[level] as number;
      const byteLength = (levels[level] as PackedTextureLevel).byteLength;
      const dst =
        rgba === undefined ? data.subarray(offset, offset + size) : rgba.subarray(0, size);
      if (file.transcodeImage(dst, level, 0, 0, targetEnum, 0, -1, -1) === 0) {
        return codecError('transcode-failed', {
          sourceFormat: `dfd-model-${parsed.dfd?.colorModel ?? 'unknown'}-level-${level}`,
          targetFormat,
        });
      }
      if (channels !== undefined)
        projectChannelsInto(dst, channels, lanes, data.subarray(offset, offset + byteLength));
      traceBasisPhase('ktx2.mip.complete', { level });
      offset += byteLength;
    }

    return {
      ok: true,
      value: {
        format: targetFormat,
        width: file.getWidth(),
        height: file.getHeight(),
        levels,
        data,
      },
    };
  } finally {
    file.close();
    file.delete();
  }
}

/**
 * Transcode every mip level of a parsed KTX2 container into `targetFormat`.
 *
 * Uses `parsed.rawBytes` as the basis KTX2File source. Returns one entry per mip
 * level (base first). On any basis-side failure returns a `transcode-failed`
 * CodecError carrying the source DFD color model and the target format.
 */
export async function transcodeKtx2(
  parsed: Ktx2Parsed,
  targetFormat: GPUTextureFormat,
): Promise<CodecResult<TranscodedTexture>> {
  traceBasisPhase('ktx2.transcode.start', { targetFormat });
  let mod: BasisTranscoderModule;
  try {
    mod = await initBasisTranscoder();
  } catch {
    return codecError('codec-init-failed', { stage: 'dynamic-import-basis-transcoder' });
  }

  const target = transcodeTargetSpecs[targetFormat];
  if (target === undefined) {
    return codecError('transcode-failed', {
      sourceFormat: `dfd-model-${parsed.dfd?.colorModel ?? 'unknown'}`,
      targetFormat,
    });
  }

  const targetEnum = mod.transcoder_texture_format[target.basis].value;
  const { lanes } = ktx2ChannelLanes(parsed);
  const file = new mod.KTX2File(parsed.rawBytes);
  try {
    traceBasisPhase('ktx2.file.start');
    if (!file.isValid()) {
      return codecError('transcode-failed', {
        sourceFormat: 'invalid-ktx2-file',
        targetFormat,
      });
    }
    if (file.startTranscoding() === 0) {
      return codecError('transcode-failed', {
        sourceFormat: 'start-transcoding-failed',
        targetFormat,
      });
    }

    const levels = file.getLevels();
    traceBasisPhase('ktx2.file.ready', { levels });
    const mips: TranscodedMip[] = [];
    for (let level = 0; level < levels; level++) {
      const info = file.getImageLevelInfo(level, 0, 0);
      const size = file.getImageTranscodedSizeInBytes(level, 0, 0, targetEnum);
      const dst = new Uint8Array(size);
      const ok = file.transcodeImage(dst, level, 0, 0, targetEnum, 0, -1, -1);
      if (ok === 0) {
        return codecError('transcode-failed', {
          sourceFormat: `dfd-model-${parsed.dfd?.colorModel ?? 'unknown'}-level-${level}`,
          targetFormat,
        });
      }
      traceBasisPhase('ktx2.mip.complete', { level });
      mips.push({
        level,
        width: info.origWidth,
        height: info.origHeight,
        data: projectChannels(dst, target.channels, lanes),
      });
    }

    return {
      ok: true,
      value: {
        format: targetFormat,
        width: file.getWidth(),
        height: file.getHeight(),
        mips,
      },
    };
  } finally {
    file.close();
    file.delete();
  }
}

/** Transcode a raw `.basis` file; source color remains a Meta author fact. */
export async function transcodeBasis(
  bytes: Uint8Array,
  targetFormat: GPUTextureFormat,
): Promise<CodecResult<TranscodedTexture>> {
  let mod: BasisTranscoderModule;
  try {
    mod = await initBasisTranscoder();
  } catch {
    return codecError('codec-init-failed', { stage: 'dynamic-import-basis-transcoder' });
  }
  const target = transcodeTargetSpecs[targetFormat];
  if (target === undefined || mod.BasisFile === undefined) {
    return codecError('transcode-failed', {
      sourceFormat: 'raw-basis',
      targetFormat,
    });
  }
  const targetEnum = mod.transcoder_texture_format[target.basis].value;
  const file = new mod.BasisFile(bytes);
  try {
    if (file.getNumImages() <= 0 || file.getNumLevels(0) <= 0) {
      return codecError('transcode-failed', { sourceFormat: 'invalid-basis-file', targetFormat });
    }
    if (file.startTranscoding() === 0) {
      return codecError('transcode-failed', {
        sourceFormat: 'start-transcoding-failed',
        targetFormat,
      });
    }
    const mips: TranscodedMip[] = [];
    for (let level = 0; level < file.getNumLevels(0); level++) {
      const width = file.getImageWidth(0, level);
      const height = file.getImageHeight(0, level);
      const size = file.getImageTranscodedSizeInBytes(0, level, targetEnum);
      const data = new Uint8Array(size);
      if (file.transcodeImage(data, 0, level, targetEnum, 0) === 0) {
        return codecError('transcode-failed', {
          sourceFormat: `raw-basis-level-${level}`,
          targetFormat,
        });
      }
      mips.push({ level, width, height, data: projectChannels(data, target.channels) });
    }
    return {
      ok: true,
      value: {
        format: targetFormat,
        width: mips[0]?.width ?? 0,
        height: mips[0]?.height ?? 0,
        mips,
      },
    };
  } finally {
    file.close();
    file.delete();
  }
}
