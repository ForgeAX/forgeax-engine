import { createHash } from 'node:crypto';
import type {
  ArtifactDescriptor,
  AssetEnvelopeV2,
  CookReceipt,
  ImportedArtifactBody,
} from '@forgeax/engine-types';
import { encodeMaterialProgramWire } from './material-program-wire.js';

export type PackageArtifactBody = ImportedArtifactBody;

export interface PackageProductAsset
  extends Omit<AssetEnvelopeV2<Readonly<Record<string, unknown>>>, 'artifacts'> {
  readonly artifacts: Readonly<Record<string, PackageArtifactBody>>;
}

export interface PackageProduct {
  readonly assets: readonly PackageProductAsset[];
  readonly receipts: readonly CookReceipt[];
  readonly diagnostics: readonly unknown[];
  readonly sourceRevision: string;
  readonly sourceKey?: string;
}

export interface PackageDocumentArtifact extends ArtifactDescriptor {
  readonly byteLength: number;
  readonly integrity: { readonly algorithm: 'sha256'; readonly digest: string };
}

export interface PackageDocumentAsset extends Omit<PackageProductAsset, 'payload' | 'artifacts'> {
  readonly payload: Record<string, unknown>;
  readonly artifacts: Readonly<Record<string, PackageDocumentArtifact>>;
}

export interface PackageDocument {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly assets: readonly PackageDocumentAsset[];
}

export interface PackageFinalizePolicy {
  readonly base: string;
  readonly packagePath: string;
  readonly artifactPath: (guid: string, localKey: string) => string;
  readonly sink?: (path: string, bytes: Uint8Array) => void | Promise<void>;
}

export interface FinalizedPackageProduct extends Omit<PackageProduct, 'assets'> {
  readonly pack: PackageDocument;
  readonly packageUrl: string;
  readonly digest: string;
}

type PackageTransportSource = Pick<PackageProduct, 'assets'> &
  Partial<Pick<PackageProduct, 'receipts' | 'diagnostics' | 'sourceKey'>>;

export interface PackageFinalizerError {
  readonly code:
    | 'duplicate-guid'
    | 'missing-source-revision'
    | 'missing-receipt'
    | 'invalid-artifact';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly guid?: string; readonly key?: string };
}

export type PackageFinalizeResult =
  | { readonly ok: true; readonly value: FinalizedPackageProduct }
  | { readonly ok: false; readonly error: PackageFinalizerError };

function failure(
  code: PackageFinalizerError['code'],
  expected: string,
  hint: string,
  detail: PackageFinalizerError['detail'],
): PackageFinalizeResult {
  return { ok: false, error: { code, expected, hint, detail } };
}

function sorted(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) {
    // Portable scalar arrays already have canonical order. Keep the original
    // backing store instead of cloning large mesh payloads for serialization.
    return Object.hasOwn(value, 'toJSON') ||
      value.some((item) => item !== null && typeof item === 'object')
      ? value.map(sorted)
      : value;
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = sorted((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

function packageUrl(base: string, packagePath: string): string {
  const prefix = base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`;
  return `${prefix}/${packagePath.replace(/^\/+/, '')}`;
}

function safePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').includes('..')
  );
}

function digest(assets: readonly PackageProductAsset[]): string {
  const pack = { schemaVersion: '2.0.0', kind: 'internal-text-package', assets } as const;
  const hash = createHash('sha256').update(
    JSON.stringify(
      sorted({
        ...pack,
        assets: pack.assets.map((asset) => ({
          ...asset,
          artifacts: Object.fromEntries(
            Object.entries(asset.artifacts).map(([key, artifact]) => [
              key,
              {
                mediaType: artifact.mediaType,
                ...(artifact.delivery === undefined ? {} : { delivery: artifact.delivery }),
                ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
                byteLength: artifact.bytes.byteLength,
              },
            ]),
          ),
        })),
      }),
    ),
  );
  for (const [key, artifact] of assets
    .flatMap((asset) =>
      Object.entries(asset.artifacts).map(
        ([localKey, body]) => [`${asset.guid}/${localKey}`, body] as const,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(key).update(artifact.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function packageDocument(
  assets: readonly PackageProductAsset[],
  artifactPath: (guid: string, localKey: string) => string,
  digestBytes: (bytes: Uint8Array) => string,
): PackageDocument {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      payload: asset.payload,
      refs: asset.refs,
      artifacts: Object.fromEntries(
        Object.entries(asset.artifacts).map(([key, artifact]) => [
          key,
          {
            path: artifactPath(asset.guid, key),
            mediaType: artifact.mediaType,
            ...(artifact.delivery === undefined ? {} : { delivery: artifact.delivery }),
            ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
            contentEncoding: 'identity' as const,
            byteLength: artifact.bytes.byteLength,
            integrity: {
              algorithm: 'sha256' as const,
              digest: `sha256:${digestBytes(artifact.bytes)}`,
            },
          },
        ]),
      ),
    })),
  };
}

function transportArtifacts(
  assets: readonly PackageProductAsset[],
  artifactPath: PackageFinalizePolicy['artifactPath'],
) {
  return assets.flatMap((asset) =>
    Object.entries(asset.artifacts).flatMap(([localKey, artifact]) => [
      {
        guid: asset.guid,
        localKey,
        path: artifactPath(asset.guid, localKey),
        mediaType: artifact.mediaType,
        ...(artifact.delivery === undefined ? {} : { delivery: artifact.delivery }),
        ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
        bytes: artifact.bytes,
      },
    ]),
  );
}

/** Finalize a complete producer product without owning producer-specific policy. */
export async function finalizePackageProduct(
  product: PackageProduct,
  policy: PackageFinalizePolicy,
): Promise<PackageFinalizeResult> {
  return finalizeProduct(product, policy, sha256);
}

async function finalizeProduct(
  product: PackageProduct,
  policy: PackageFinalizePolicy,
  digestBytes: (bytes: Uint8Array) => string,
): Promise<PackageFinalizeResult> {
  if (product.sourceRevision.trim().length === 0) {
    return failure(
      'missing-source-revision',
      'a non-empty source revision',
      'rebuild the inventory and provide the producer source revision',
      {},
    );
  }
  const seen = new Set<string>();
  for (const asset of product.assets) {
    const guid = asset.guid.toLowerCase();
    if (seen.has(guid)) {
      return failure(
        'duplicate-guid',
        'one terminal product row per GUID',
        'repair the inventory or producer output before finalization',
        { guid },
      );
    }
    seen.add(guid);
    for (const [key, artifact] of Object.entries(asset.artifacts)) {
      if (!safePath(key) || !(artifact.bytes instanceof Uint8Array)) {
        return failure(
          'invalid-artifact',
          'asset-local artifact keys and byte bodies',
          'repair the producer artifact before finalization',
          { guid, key },
        );
      }
    }
  }
  for (const guid of seen) {
    if (!product.receipts.some((receipt) => receipt.guid.toLowerCase() === guid)) {
      return failure(
        'missing-receipt',
        'one receipt for every terminal product GUID',
        'preserve the producer receipt when handing the product to engine-pack',
        { guid },
      );
    }
  }
  const assets = [...product.assets].sort((left, right) => left.guid.localeCompare(right.guid));
  const document = packageDocument(assets, policy.artifactPath, digestBytes);
  if (policy.sink !== undefined) {
    const packageBytes = new TextEncoder().encode(
      JSON.stringify(sorted(encodeMaterialProgramWire(document))),
    );
    for (const asset of assets) {
      for (const [key, artifact] of Object.entries(asset.artifacts)) {
        const path = policy.artifactPath(asset.guid, key);
        if (!safePath(path)) {
          return failure(
            'invalid-artifact',
            'package-relative artifact output paths',
            'repair the finalizer artifact path policy',
            { guid: asset.guid, key },
          );
        }
        await policy.sink(path, artifact.bytes);
      }
    }
    if (!safePath(policy.packagePath)) {
      return failure(
        'invalid-artifact',
        'a package-relative package path',
        'repair the finalizer package path policy',
        { key: policy.packagePath },
      );
    }
    await policy.sink(policy.packagePath, packageBytes);
  }
  return {
    ok: true,
    value: {
      pack: document,
      packageUrl: packageUrl(policy.base, policy.packagePath),
      digest: digest(product.assets),
      receipts: product.receipts,
      diagnostics: product.diagnostics,
      sourceRevision: product.sourceRevision,
      ...(product.sourceKey === undefined ? {} : { sourceKey: product.sourceKey }),
    },
  };
}

/** Finalize a product-shaped source with the deterministic transport revision. */
export async function finalizePackageTransportSource(
  input: PackageTransportSource,
  policy: PackageFinalizePolicy,
) {
  // Revision and descriptor integrity describe the same input bytes. This scope
  // ends with one finalization; subsequent calls must observe caller mutations.
  const digests = new WeakMap<Uint8Array, string>();
  const digestBytes = (bytes: Uint8Array): string => {
    let value = digests.get(bytes);
    if (value === undefined) {
      value = sha256(bytes);
      digests.set(bytes, value);
    }
    return value;
  };
  const sourceRevision = transportRevision(input, digestBytes);
  const product: PackageProduct = {
    assets: input.assets,
    receipts:
      input.receipts ??
      input.assets.map((asset) => ({
        guid: asset.guid,
        origin: 'sourceMeta' as const,
        status: 'succeeded' as const,
        inputFingerprint: sourceRevision,
      })),
    diagnostics: input.diagnostics ?? [],
    sourceRevision,
    ...(input.sourceKey === undefined ? {} : { sourceKey: input.sourceKey }),
  };
  const finalized = await finalizeProduct(product, policy, digestBytes);
  if (!finalized.ok) throw finalized.error;
  return {
    pack: finalized.value.pack,
    packageUrl: finalized.value.packageUrl,
    artifacts: transportArtifacts(product.assets, policy.artifactPath),
    digest: finalized.value.digest,
    receipts: finalized.value.receipts,
    sourceRevision,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function revisionStable(value: unknown, digestBytes: (bytes: Uint8Array) => string): unknown {
  if (value instanceof Uint8Array) {
    return {
      byteLength: value.byteLength,
      digest: digestBytes(value),
    };
  }
  if (Array.isArray(value)) {
    return Object.hasOwn(value, 'toJSON') ||
      value.some((item) => item !== null && typeof item === 'object')
      ? value.map((item) => revisionStable(item, digestBytes))
      : value;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, revisionStable(item, digestBytes)]),
    );
  }
  return value;
}

export function packageTransportRevision(value: unknown): string {
  return transportRevision(value, sha256);
}

function transportRevision(value: unknown, digestBytes: (bytes: Uint8Array) => string): string {
  return createHash('sha256')
    .update(JSON.stringify(revisionStable(value, digestBytes)))
    .digest('hex');
}
