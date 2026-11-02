import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { basisEncode } from '@forgeax/engine-codec/encode';
import {
  type DeliveryLayout,
  type MipChain,
  ModelingError,
  mipChain,
} from '@forgeax/engine-modeling';
import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { sha256 } from '../compute/sha256';

/**
 * KTX2 delivery encoding of procedural and baked textures: the kernel
 * builds the mip chain in float (`mipChain`: renormalized normals, Toksvig roughness),
 * and Basis UASTC encodes every level as given, with normals as two channels so the
 * Renderer transcodes them to BC5. Node-only: the encoder is build-time WASM.
 */
export interface EncodeKtx2Options {
  readonly layout: DeliveryLayout;
  /** `ormh` only: normal map whose per-level variance widens roughness (Toksvig). */
  readonly roughnessFromNormal?: TextureAsset;
  /** UASTC rate-distortion lambda (R7: <= 0.5 for normals, 0.5 for ORMH); absent: no RDO. */
  readonly rdo?: number;
  /** `mask` only: the material's alpha cutoff whose coverage every level keeps (default 0.5). */
  readonly alphaCutoff?: number;
  /**
   * The upstream identity of the source pixels, normally the bake job's cache key
   * (`BakeResult.report.cacheKey`). Default: the SHA-256 of the source bytes.
   */
  readonly sourceKey?: string;
}

export interface EncodedKtx2 {
  /** An ordinary encoded TextureAsset: KTX2 bytes with their packed mip count. */
  readonly texture: TextureAsset;
  /** The two DDC levels: the source (bake) key and the encode key over it. */
  readonly keys: { readonly source: string; readonly encode: string };
  readonly report: {
    readonly layout: DeliveryLayout;
    readonly policy: string;
    readonly levels: number;
    readonly bytes: number;
    readonly rgba8Bytes: number;
  };
}

let encoderDigest: string | undefined;

/** SHA-256 of the pinned encoder WASM: an encoder change misses every encode key. */
function encoderIdentity(): string {
  if (encoderDigest === undefined) {
    const root = dirname(
      createRequire(import.meta.url).resolve('@forgeax/engine-codec/package.json'),
    );
    encoderDigest = sha256(
      new Uint8Array(readFileSync(join(root, 'pkg/encode/basis_encoder.wasm'))),
    );
  }
  return encoderDigest;
}

/** Pack level 2: BC5 p95 1.4 vs 2.2 deg at the fast tier on baked normals; level 4 adds nothing. */
const BASIS = { mode: 'uastc-ldr', supercompression: 'zstd', packLevel: 2 } as const;

/**
 * The encode key: source key + mip policy + the chain facts the source bytes do not carry
 * (output color space, extent, mask cutoff) + Basis parameters + encoder digest.
 */
export function encodeKey(
  sourceKey: string,
  chain: Pick<MipChain, 'policy' | 'colorSpace' | 'width' | 'height'>,
  alphaCutoff: number | undefined,
  rdo: number | undefined,
): string {
  const text = JSON.stringify({
    sourceKey,
    policy: chain.policy,
    colorSpace: chain.colorSpace,
    extent: [chain.width, chain.height],
    alphaCutoff: alphaCutoff ?? null,
    basis: { ...BASIS, rdo: rdo ?? null },
    encoder: encoderIdentity(),
  });
  return sha256(new TextEncoder().encode(text));
}

/** Encode a texture's delivery mip chain to KTX2 (UASTC, zstd, offline levels). */
export async function encodeKtx2(
  texture: TextureAsset,
  options: EncodeKtx2Options,
): Promise<Result<EncodedKtx2, ModelingError>> {
  if (options.rdo !== undefined && !(options.rdo >= 0.001 && options.rdo <= 10)) {
    return err(
      new ModelingError({
        code: 'model-invalid-argument',
        expected: 'rdo is a UASTC lambda in [0.001, 10]',
        detail: { rdo: options.rdo },
      }),
    );
  }
  const chain = mipChain(texture, {
    layout: options.layout,
    ...(options.roughnessFromNormal === undefined
      ? {}
      : { roughnessFromNormal: options.roughnessFromNormal }),
    ...(options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff }),
  });
  if (!chain.ok) return chain;
  const { levels, width, height, colorSpace, channels, policy } = chain.value;
  const srgb = colorSpace === 'srgb';
  const encoded = await basisEncode(levels[0] as Uint8Array, {
    mode: BASIS.mode,
    width,
    height,
    srgb,
    perceptual: srgb,
    uastcSupercompression: true,
    mipGen: false,
    levels: levels.slice(1),
    channels,
    uastcLevel: BASIS.packLevel,
    ...(options.rdo === undefined ? {} : { uastcRdo: options.rdo }),
  });
  if (!encoded.ok) {
    const { code, detail } = encoded.error;
    return err(
      new ModelingError({
        code:
          code === 'codec-init-failed' ? 'model-capability-unavailable' : 'model-invalid-argument',
        expected: 'the Basis encoder accepts the delivery mip chain',
        detail: { codec: code, ...detail },
      }),
    );
  }
  const source =
    options.sourceKey ??
    sha256(
      options.roughnessFromNormal === undefined
        ? texture.data
        : concatBytes(texture.data, options.roughnessFromNormal.data),
    );
  const rgba8Bytes = levels.reduce((n, l) => n + l.byteLength, 0);
  return ok({
    texture: {
      kind: 'texture',
      format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
      colorSpace,
      shape: { viewDimension: '2d', extent: { width, height } },
      mips: { kind: 'packed', levelCount: levels.length },
      encoding: 'ktx2',
      data: encoded.value,
    },
    keys: {
      source,
      encode: encodeKey(
        source,
        chain.value,
        options.layout === 'mask' ? (options.alphaCutoff ?? 0.5) : undefined,
        options.rdo,
      ),
    },
    report: {
      layout: options.layout,
      policy,
      levels: levels.length,
      bytes: encoded.value.byteLength,
      rgba8Bytes,
    },
  });
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
