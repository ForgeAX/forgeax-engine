import {
  type RetainedBytes,
  type RetentionBudget,
  realmRetention,
} from '@forgeax/engine-assets-runtime/internal';
import type {
  CodecError,
  CodecResult,
  PackedTranscodedTexture,
  TextureTranscodeRequest,
} from '@forgeax/engine-codec';
import {
  ktx2ChannelLanes,
  parseKtx2,
  selectTranscodeTarget,
  type TranscodeChannels,
} from '@forgeax/engine-codec';
import { createTaskPool } from '@forgeax/engine-platform';
import type { RhiCaps } from '@forgeax/engine-rhi';
import {
  AssetError,
  deriveTextureLayout,
  err,
  ok,
  type Result,
  type TaskExecutor,
  type TaskHandle,
  type TextureAsset,
  textureCompressionFeature,
  validateTextureLayout,
} from '@forgeax/engine-types';
import { builtinTaskKinds, TEXTURE_TRANSCODE_TASK } from '../tasks';
import { type GpuResourceNamespace, ScopedGpuResources } from './scoped-gpu-resources';

type Prepared = Result<TextureAsset, AssetError>;
type Transcoded = CodecResult<PackedTranscodedTexture>;
interface Target {
  result: Prepared;
  completed: Promise<void>;
  /** A caller has received the settled result; until then it is owed and pinned. */
  taken: boolean;
  /** The running transcode, until it settles. */
  task?: TaskHandle<Transcoded> | undefined;
  /** Budget held for the expected derivative while the transcode runs. */
  reserved: number;
}
interface Source {
  readonly revision: number;
  readonly fixed: TextureAsset;
  readonly channels: TranscodeChannels;
  readonly targets: Map<GPUTextureFormat, Target>;
  bytes: number;
  /** Budget tick of the last request for this source. */
  used: number;
}
/** Withdraw or discard every transcode still running for an evicted source. */
function cancelTargets(source: Source): void {
  for (const target of source.targets.values()) target.task?.cancel();
}
/** In flight, or settled but not yet delivered: eviction would discard owed work. */
function pinned(source: Source): boolean {
  for (const target of source.targets.values())
    if (target.result === pending || !target.taken) return true;
  return false;
}
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SOURCES = 256;
/** Transcodes running at once; later requests wait without capturing. */
const MAX_TRANSCODES = 8;
const pending: Prepared = err(
  new AssetError({
    code: 'asset-not-ready',
    expected: 'the requested device texture transcode has completed',
    hint: 'retry preparation on the next frame; the source asset remains available',
  }),
);

const FEATURE_CAPS = {
  'texture-compression-bc': 'textureCompressionBc',
  'texture-compression-etc2': 'textureCompressionEtc2',
  'texture-compression-astc': 'textureCompressionAstc',
} as const;

/** Native block-compressed texels reach the device only when it exposes their feature. */
function admitNativeFormat(asset: TextureAsset, caps: RhiCaps | undefined): Prepared {
  const feature = textureCompressionFeature(asset.format);
  if (feature === undefined || caps === undefined || caps[FEATURE_CAPS[feature]]) return ok(asset);
  return err(
    new AssetError({
      code: 'device-unsupported',
      expected: `a device exposing ${feature} for native ${asset.format} texels`,
      hint:
        asset.format === 'bc5-rg-unorm'
          ? 'publish the normal map as a BC5 KTX2 source (encoding ktx2), which derives RG8 on devices without BC, or supply native rg8unorm texels'
          : 'publish a Basis/KTX2 source so the Renderer derives a supported format, or supply uncompressed texels',
      detail: { field: 'format', value: asset.format, reason: `${feature}-unavailable` },
    }),
  );
}

/** Authored bytes of `source` re-laid in `format`; 0 when that layout is invalid. */
function expectedBytes(source: TextureAsset, format: GPUTextureFormat): number {
  const layout = deriveTextureLayout({ shape: source.shape, mips: source.mips, format });
  if (!layout.ok) return 0;
  // Generated levels are not part of the derivative, only its base level.
  return source.mips.kind === 'generate'
    ? (layout.value.levels[0]?.byteLength ?? 0)
    : layout.value.byteLength;
}

/** The device format a source derives to when the caller names none. */
function defaultTarget(
  asset: TextureAsset,
  source: Source,
  caps: RhiCaps | undefined,
): GPUTextureFormat {
  // A BC5 KTX2 has one device-dependent form: its blocks, or their exact
  // RG8 decode where the device lacks BC.
  if (asset.format === 'bc5-rg-unorm')
    return caps?.textureCompressionBc === true ? 'bc5-rg-unorm' : 'rg8unorm';
  return selectTranscodeTarget(
    {
      model: asset.format === 'rgba16float' ? 'uastc-hdr' : 'uastc-ldr',
      srgb: asset.colorSpace === 'srgb',
      channels: source.channels,
    },
    {
      bc: caps?.textureCompressionBc ?? false,
      astc: caps?.textureCompressionAstc ?? false,
      etc2: caps?.textureCompressionEtc2 ?? false,
    },
  );
}

/** Device derivatives of privately captured source versions. A miss schedules
 * one transcode task; steady draws perform one keyed lookup and never touch
 * WASM. Captures and derivatives count against the realm's retention budget;
 * a running transcode holds its expected derivative bytes. The budget
 * releases only delivered derivatives. At most MAX_TRANSCODES run at once,
 * and while owed work fills the budget new work starts nothing; either way
 * the request reports not-ready and the caller's next-frame retry is its
 * place in the queue. With nothing running, one request of any size starts,
 * so a source larger than the budget still completes. */
export class TextureDerivations implements RetainedBytes {
  private readonly sources = new ScopedGpuResources<Source>();
  private bytes = 0;
  private running = 0;
  /** Requests refused for now that start on a later retry. */
  private readonly waiting = new ScopedGpuResources<true>();
  private tasks: TaskExecutor | undefined;

  /** Without an executor, transcodes run inline in this realm, time-sliced. */
  constructor(
    tasks?: TaskExecutor,
    private readonly budget: RetentionBudget = realmRetention(),
  ) {
    this.tasks = tasks;
  }

  prepare(
    key: string | number,
    revision: number,
    asset: TextureAsset,
    caps: RhiCaps | undefined,
    target?: GPUTextureFormat,
    namespace: GpuResourceNamespace = 0,
  ): Prepared {
    if (asset.encoding === undefined)
      return target === undefined ? admitNativeFormat(asset, caps) : ok(asset);
    const source = this.capture(key, revision, asset, namespace);
    if (!('targets' in source)) return source;
    source.used = this.budget.tick();
    const format = target ?? defaultTarget(asset, source, caps);
    const current = source.targets.get(format);
    if (current !== undefined) {
      if (current.result !== pending) current.taken = true;
      return current.result;
    }
    return this.start(key, namespace, source, format, caps);
  }

  /** The private capture of `revision`, admitted into the budget on first use. */
  private capture(
    key: string | number,
    revision: number,
    asset: TextureAsset,
    namespace: GpuResourceNamespace,
  ): Source | Prepared {
    let source = this.sources.get(key, namespace);
    if (source !== undefined && source.revision !== revision) {
      this.remove(key, Number.POSITIVE_INFINITY, namespace);
      source = undefined;
    }
    if (source !== undefined) return source;
    if (asset.data.byteLength > MAX_BYTES) return this.exceeded();
    if (this.running >= MAX_TRANSCODES) return this.wait(key, namespace);
    this.budget.join(this);
    if (!this.admit(asset.data.byteLength)) return this.wait(key, namespace);
    // Borrowed World objects can mutate. Async work sees only this private
    // capture; the numeric source revision, not object identity, selects it.
    const parsed = asset.encoding === 'ktx2' ? parseKtx2(asset.data) : undefined;
    source = {
      revision,
      fixed: structuredClone(asset),
      // The DFD channel ids are the source's only channel authority: an RG
      // normal map selects BC5 / EAC RG11 / RG8 instead of an RGBA format.
      channels: parsed?.ok ? ktx2ChannelLanes(parsed.value).channels : 'rgba',
      targets: new Map(),
      bytes: asset.data.byteLength,
      used: this.budget.tick(),
    };
    this.sources.set(key, source, namespace);
    this.add(source.bytes);
    return source;
  }

  /** Reserve `target`'s expected bytes and submit its transcode. */
  private start(
    key: string | number,
    namespace: GpuResourceNamespace,
    captured: Source,
    target: GPUTextureFormat,
    caps: RhiCaps | undefined,
  ): Prepared {
    const reserved = expectedBytes(captured.fixed, target);
    if (captured.bytes + reserved > MAX_BYTES) {
      const result = this.exceeded();
      captured.targets.set(target, {
        result,
        completed: Promise.resolve(),
        taken: true,
        reserved: 0,
      });
      return result;
    }
    if (this.running >= MAX_TRANSCODES) return this.wait(key, namespace);
    const state: Target = {
      result: pending,
      completed: Promise.resolve(),
      taken: false,
      reserved,
    };
    // Registered first so the release below cannot evict this source.
    captured.targets.set(target, state);
    this.budget.settle(Number.POSITIVE_INFINITY, reserved);
    if (!this.budget.fits(reserved) && this.running > 0) {
      captured.targets.delete(target);
      return this.wait(key, namespace);
    }
    captured.bytes += reserved;
    this.add(reserved);
    this.running++;
    this.waiting.delete(key, namespace);
    const fixed = captured.fixed;
    // The task owns a copy; other targets of this source still read `fixed`.
    const data = fixed.data.slice();
    const task = this.executor().submit<TextureTranscodeRequest, Transcoded>(
      TEXTURE_TRANSCODE_TASK,
      { encoding: fixed.encoding as 'basis' | 'ktx2', data, target },
      { transfer: [data.buffer], debugName: String(key) },
    );
    state.task = task;
    state.completed = this.derive(task.result, fixed, target, String(key), caps).then((result) =>
      this.deliver(key, namespace, captured, target, state, result),
    );
    return pending;
  }

  /** Swap a finished task's reservation for its derivative's actual bytes. */
  private deliver(
    key: string | number,
    namespace: GpuResourceNamespace,
    captured: Source,
    target: GPUTextureFormat,
    state: Target,
    result: Prepared,
  ): void {
    state.task = undefined;
    this.running--;
    // Removal refunded the source, reservation included, and owes nothing.
    if (this.sources.get(key, namespace) !== captured || captured.targets.get(target) !== state)
      return;
    captured.bytes -= state.reserved;
    this.add(-state.reserved);
    state.reserved = 0;
    if (result.ok && captured.bytes + result.value.data.byteLength > MAX_BYTES)
      result = this.exceeded();
    if (result.ok) {
      captured.bytes += result.value.data.byteLength;
      this.add(result.value.data.byteLength);
    }
    state.result = result;
    this.budget.settle();
  }

  private executor(): TaskExecutor {
    this.tasks ??= createTaskPool({ kinds: builtinTaskKinds });
    return this.tasks;
  }

  async settled(key: string | number, namespace: GpuResourceNamespace = 0): Promise<void> {
    await Promise.all(
      [...(this.sources.get(key, namespace)?.targets.values() ?? [])].map((item) => item.completed),
    );
  }
  preparing(key: string | number, namespace: GpuResourceNamespace = 0): boolean {
    if (this.waiting.has(key, namespace)) return true;
    for (const target of this.sources.get(key, namespace)?.targets.values() ?? [])
      if (target.result === pending) return true;
    return false;
  }
  remove(
    key: string | number,
    beforeRevision = Number.POSITIVE_INFINITY,
    namespace: GpuResourceNamespace = 0,
  ): void {
    const source = this.sources.get(key, namespace);
    if (beforeRevision === Number.POSITIVE_INFINITY) this.waiting.delete(key, namespace);
    if (source === undefined || source.revision >= beforeRevision) return;
    this.add(-source.bytes);
    this.sources.delete(key, namespace);
    cancelTargets(source);
  }
  /** The device texture now owns these texels; drop the delivered CPU copies. */
  release(key: string | number, namespace: GpuResourceNamespace = 0): void {
    const source = this.sources.get(key, namespace);
    if (source !== undefined && !pinned(source))
      this.remove(key, Number.POSITIVE_INFINITY, namespace);
  }
  /** Drop every source and leave the budget. */
  removeScope(namespace: GpuResourceNamespace): void {
    for (const [scope, sources] of this.sources.entries())
      if (scope === namespace)
        for (const key of sources.keys()) this.remove(key, Number.POSITIVE_INFINITY, namespace);
  }
  clear(): void {
    const sources = [...this.sources.values()];
    this.sources.clear();
    this.waiting.clear();
    this.add(-this.bytes);
    this.budget.leave(this);
    for (const source of sources) cancelTargets(source);
  }
  oldest(): number | undefined {
    return this.releasable()?.source.used;
  }
  releaseOldest(): void {
    const oldest = this.releasable();
    if (oldest !== undefined) this.remove(oldest.key, Number.POSITIVE_INFINITY, oldest.scope);
  }
  /** The least recently requested delivered source. */
  private releasable():
    | { key: string | number; scope: GpuResourceNamespace; source: Source }
    | undefined {
    let oldest: { key: string | number; scope: GpuResourceNamespace; source: Source } | undefined;
    for (const [scope, resources] of this.sources.entries())
      for (const [key, source] of resources)
        if (!pinned(source) && (oldest === undefined || source.used < oldest.source.used))
          oldest = { key, scope, source };
    return oldest;
  }
  /** Room for one more source of `bytes`, releasing delivered derivatives first. */
  private admit(bytes: number): boolean {
    while (this.sources.size >= MAX_SOURCES && this.oldest() !== undefined) this.releaseOldest();
    this.budget.settle(Number.POSITIVE_INFINITY, bytes);
    return this.sources.size < MAX_SOURCES && (this.budget.fits(bytes) || this.running === 0);
  }
  private wait(key: string | number, namespace: GpuResourceNamespace): Prepared {
    this.waiting.set(key, true, namespace);
    return pending;
  }
  private add(bytes: number): void {
    this.bytes += bytes;
    this.budget.add(bytes);
  }
  private exceeded(): Prepared {
    return err(
      new AssetError({
        code: 'asset-budget-exceeded',
        expected: 'a texture derivative within 256 MiB',
        hint: 'reduce the source image dimensions or mip chain',
      }),
    );
  }

  private async derive(
    transcoded: Promise<Transcoded>,
    source: TextureAsset,
    target: GPUTextureFormat,
    sourcePath: string,
    caps: RhiCaps | undefined,
  ): Promise<Prepared> {
    const codecFailure = (cause: CodecError['error']): Prepared =>
      err(
        new AssetError({
          code: 'asset-parse-failed',
          expected: cause.expected,
          hint: cause.hint,
          detail: {
            sourcePath,
            container: source.encoding as 'basis' | 'ktx2',
            targetFormat: target,
            codecCode: cause.code,
            codecExpected: cause.expected,
            codecHint: cause.hint,
            codecDetail: { ...cause.detail },
            capabilities: {
              bc: caps?.textureCompressionBc ?? false,
              astc: caps?.textureCompressionAstc ?? false,
              etc2: caps?.textureCompressionEtc2 ?? false,
            },
          },
        }),
      );
    const fail = (expected: string, hint: string) =>
      err(new AssetError({ code: 'asset-parse-failed', expected, hint }));
    try {
      const result = await transcoded;
      if (!result.ok) return codecFailure(result.error);
      const { width, height, levels, data } = result.value;
      const count = source.mips.kind === 'packed' ? source.mips.levelCount : 1;
      if (
        width !== source.shape.extent.width ||
        height !== source.shape.extent.height ||
        count !== levels.length
      )
        return fail(
          'encoded texture dimensions and complete mip chain match the asset',
          'replace the complete image source and its shape/mip metadata together',
        );
      if (data.byteLength > MAX_BYTES) return this.exceeded();
      const { encoding: _encoding, ...native } = source;
      const value = { ...native, format: target, data };
      const valid = validateTextureLayout({ ...value, actualByteLength: data.byteLength });
      return valid.ok ? ok(value) : fail(valid.error.expected, valid.error.hint);
    } catch (cause) {
      return fail(
        'a valid device texture transcode',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }
}
