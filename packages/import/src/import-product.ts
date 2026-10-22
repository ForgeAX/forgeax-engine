import {
  ANIMATION_CLIP_SAMPLES_ARTIFACT,
  encodeAnimationClipSamples,
} from '@forgeax/engine-pack/runtime';
import type {
  ArtifactDescriptor,
  AssetRef,
  CookProduct,
  CookReceipt,
  ImportedArtifactBody,
  ImportedAsset,
  ImportProduct,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { projectMaterialPayloadTransport } from './material-pack-transport.js';
import { normaliseForPack } from './pack-value.js';

export interface TerminalImportProduct<P = unknown> extends ImportProduct<P> {
  readonly refs: readonly AssetRef[];
  readonly artifacts: Readonly<Record<string, ImportedArtifactBody>>;
  readonly receipts: readonly CookReceipt[];
  readonly diagnostics: readonly unknown[];
  readonly sourceRevision: string;
  readonly sourceKey?: string;
}

export type ImportAssetProduct<P = unknown> = Pick<
  ImportedAsset<P>,
  'payload' | 'refs' | 'artifacts'
>;

export interface ImportProductContractError {
  readonly code: 'import-product-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string };
}

function invalidProduct(field: string): Result<never, ImportProductContractError> {
  return err({
    code: 'import-product-invalid',
    expected: 'a complete terminal import product with source identity',
    hint: 'preserve refs, artifacts, receipts, diagnostics, and source revision at the product boundary',
    detail: { field },
  });
}

export function createImportProduct<P = unknown>(
  input: TerminalImportProduct<P>,
): Result<TerminalImportProduct<P>, ImportProductContractError> {
  if (!Array.isArray(input.assets)) return invalidProduct('assets');
  if (!Array.isArray(input.sourceDependencies)) return invalidProduct('sourceDependencies');
  if (input.sourceRevision.trim().length === 0) return invalidProduct('sourceRevision');
  if (!Array.isArray(input.refs)) return invalidProduct('refs');
  if (input.artifacts === null || typeof input.artifacts !== 'object') {
    return invalidProduct('artifacts');
  }
  if (!Array.isArray(input.receipts)) return invalidProduct('receipts');
  if (!Array.isArray(input.diagnostics)) return invalidProduct('diagnostics');
  return ok({ ...input });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('Web Crypto API is required for importer digests');
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await subtle.digest('SHA-256', owned.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function artifactDigest(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

function concatBytes(chunks: readonly (Uint8Array | string)[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = chunks.map((chunk) =>
    typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
  );
  const totalLength = encoded.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of encoded) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function productDigest(
  asset: ImportedAsset<unknown>,
  artifacts: Readonly<Record<string, ArtifactDescriptor>>,
): Promise<string> {
  const chunks: (Uint8Array | string)[] = [
    // Digest the same value representation that Pack publishes. Native byte views
    // otherwise stringify as large indexed objects instead of JSON arrays.
    JSON.stringify(normaliseForPack(projectImportedAssetPayload(asset))),
    JSON.stringify(asset.refs.map((ref) => ref.guid)),
    JSON.stringify(artifacts),
  ];
  for (const [key, artifact] of Object.entries(asset.artifacts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    chunks.push(key, artifact.bytes);
  }
  return `sha256:${await sha256Hex(concatBytes(chunks))}`;
}

async function artifactDescriptors(
  artifacts: Readonly<Record<string, ImportedArtifactBody>>,
): Promise<Readonly<Record<string, ArtifactDescriptor>>> {
  const entries: [string, ArtifactDescriptor][] = [];
  for (const [path, artifact] of Object.entries(artifacts)) {
    entries.push([
      path,
      {
        path,
        mediaType: artifact.mediaType,
        byteLength: artifact.bytes.byteLength,
        integrity: { algorithm: 'sha256' as const, digest: await artifactDigest(artifact.bytes) },
        ...(artifact.delivery === undefined ? {} : { delivery: artifact.delivery }),
        ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
      },
    ]);
  }
  return Object.fromEntries(entries);
}

export function projectImportedAssetPayload(
  asset: ImportedAsset<unknown>,
): Record<string, unknown> {
  const payload = asset.payload as Record<string, unknown>;
  if (Object.keys(asset.artifacts).length === 0) return payload;
  if (asset.kind === 'material')
    return projectMaterialPayloadTransport(payload, asset.artifacts) as Record<string, unknown>;
  if (asset.kind === 'mesh' && asset.artifacts.body !== undefined)
    return {
      kind: 'mesh',
      ...(payload.distanceField === undefined ? {} : { distanceField: payload.distanceField }),
    };
  if (
    asset.kind === 'animation-clip' &&
    asset.artifacts[ANIMATION_CLIP_SAMPLES_ARTIFACT] !== undefined
  )
    return encodeAnimationClipSamples(payload)?.payload ?? payload;
  if (
    asset.kind === 'particle-effect' &&
    asset.artifacts['particle-effect/program.json'] !== undefined
  ) {
    const { program: _publishedArtifact, ...summary } = payload;
    return summary;
  }
  if (asset.kind === 'texture' || asset.kind === 'equirect') {
    const { data: _runtimeBytes, ...metadata } = payload;
    return metadata;
  }
  return payload;
}

/** Convert each importer asset into the shared completed producer product. */
export function finalizeImportProducts(
  product: ImportProduct<unknown>,
  inputFingerprint: string,
): Promise<readonly CookProduct[]> {
  return (async () => {
    const products: CookProduct[] = [];
    for (const asset of product.assets) {
      const artifacts = await artifactDescriptors(asset.artifacts);
      const digest = await productDigest(asset, artifacts);
      products.push({
        guid: asset.guid,
        payload: asset.payload,
        refs: asset.refs.map((ref) => ref.guid),
        artifacts,
        digest,
        receipt: {
          guid: asset.guid,
          origin: 'sourceMeta' as const,
          status: 'succeeded' as const,
          inputFingerprint,
          outputDigest: digest,
        },
      });
    }
    return products;
  })();
}
