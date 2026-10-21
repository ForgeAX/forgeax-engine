import {
  type CodecError,
  parseKtx2,
  selectTranscodeTarget,
  transcodeBasis,
  transcodeKtx2,
} from '@forgeax/engine-codec';
import type { RhiCaps } from '@forgeax/engine-rhi';
import {
  AssetError,
  err,
  ok,
  type Result,
  type TextureAsset,
  validateTextureLayout,
} from '@forgeax/engine-types';
import { type GpuResourceNamespace, ScopedGpuResources } from './scoped-gpu-resources';

type Prepared = Result<TextureAsset, AssetError>;
interface Source {
  readonly revision: number;
  readonly fixed: TextureAsset;
  readonly targets: Map<GPUTextureFormat, { result: Prepared; completed: Promise<void> }>;
  bytes: number;
}
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SOURCES = 256;
const pending: Prepared = err(
  new AssetError({
    code: 'asset-not-ready',
    expected: 'the requested device texture transcode has completed',
    hint: 'retry preparation on the next frame; the source asset remains available',
  }),
);

/** Device derivatives of privately captured source versions. A miss schedules
 * one transcode; steady draws perform one keyed lookup and never touch WASM. */
export class TextureDerivations {
  private readonly sources = new ScopedGpuResources<Source>();
  private bytes = 0;

  prepare(
    key: string | number,
    revision: number,
    asset: TextureAsset,
    caps: RhiCaps | undefined,
    target?: GPUTextureFormat,
    namespace: GpuResourceNamespace = 0,
  ): Prepared {
    if (asset.encoding === undefined) return ok(asset);
    target ??= selectTranscodeTarget(
      {
        model: asset.format === 'rgba16float' ? 'uastc-hdr' : 'uastc-ldr',
        srgb: asset.colorSpace === 'srgb',
        channels: 'rgba',
      },
      {
        bc: caps?.textureCompressionBc ?? false,
        astc: caps?.textureCompressionAstc ?? false,
        etc2: caps?.textureCompressionEtc2 ?? false,
      },
    );
    let source = this.sources.get(key, namespace);
    if (source !== undefined && source.revision !== revision) {
      this.remove(key, Number.POSITIVE_INFINITY, namespace);
      source = undefined;
    }
    if (source === undefined) {
      if (asset.data.byteLength > MAX_BYTES) return this.exceeded();
      // Borrowed World objects can mutate. Async work sees only this private
      // capture; the numeric source revision, not object identity, selects it.
      source = {
        revision,
        fixed: structuredClone(asset),
        targets: new Map(),
        bytes: asset.data.byteLength,
      };
      this.sources.set(key, source, namespace);
      this.bytes += source.bytes;
    }
    const current = source.targets.get(target);
    if (current !== undefined) return current.result;
    const captured = source;
    const state = { result: pending, completed: Promise.resolve() };
    state.completed = this.transcode(captured.fixed, target, String(key), caps).then((result) => {
      if (this.sources.get(key, namespace) !== captured) return;
      if (result.ok && captured.bytes + result.value.data.byteLength > MAX_BYTES)
        result = this.exceeded();
      if (result.ok) {
        captured.bytes += result.value.data.byteLength;
        this.bytes += result.value.data.byteLength;
      }
      state.result = result;
      this.trim(key, namespace);
    });
    source.targets.set(target, state);
    this.trim(key, namespace);
    return pending;
  }

  async settled(key: string | number, namespace: GpuResourceNamespace = 0): Promise<void> {
    await Promise.all(
      [...(this.sources.get(key, namespace)?.targets.values() ?? [])].map((item) => item.completed),
    );
  }
  preparing(key: string | number, namespace: GpuResourceNamespace = 0): boolean {
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
    if (source === undefined || source.revision >= beforeRevision) return;
    this.bytes -= source.bytes;
    this.sources.delete(key, namespace);
  }
  clear(): void {
    this.sources.clear();
    this.bytes = 0;
  }
  private trim(keep: string | number, namespace: GpuResourceNamespace): void {
    for (const [scope, resources] of this.sources.entries()) {
      for (const key of resources.keys()) {
        if (this.sources.size <= MAX_SOURCES && this.bytes <= MAX_BYTES) return;
        if (key !== keep || scope !== namespace) this.remove(key, Number.POSITIVE_INFINITY, scope);
      }
    }
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

  private async transcode(
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
      const parsed = source.encoding === 'ktx2' ? await parseKtx2(source.data) : undefined;
      if (parsed !== undefined && !parsed.ok) return codecFailure(parsed.error);
      const result = parsed?.ok
        ? await transcodeKtx2(parsed.value, target)
        : await transcodeBasis(source.data, target);
      if (!result.ok) return codecFailure(result.error);
      const { width, height, mips } = result.value;
      const count = source.mips.kind === 'packed' ? source.mips.levelCount : 1;
      if (
        width !== source.shape.extent.width ||
        height !== source.shape.extent.height ||
        count !== mips.length
      )
        return fail(
          'encoded texture dimensions and complete mip chain match the asset',
          'replace the complete image source and its shape/mip metadata together',
        );
      const length = mips.reduce((total, level) => total + level.data.byteLength, 0);
      if (length > MAX_BYTES) return this.exceeded();
      const data = new Uint8Array(length);
      let offset = 0;
      for (const mip of mips) {
        data.set(mip.data, offset);
        offset += mip.data.byteLength;
      }
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
