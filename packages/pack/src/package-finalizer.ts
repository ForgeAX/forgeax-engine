import { createHash } from 'node:crypto';
import {
  type ArtifactDescriptor,
  type AssetEnvelopeV2,
  type CookReceipt,
  type ImportedArtifactBody,
  isDeepFrozenJson,
} from '@forgeax/engine-types';
import { encodeMaterialProgramWire } from './material-program-wire.js';
import { compactRasterSourcePackageAssets } from './material-source-transport.js';

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
  /** Emit source-backed raster programs from a paired material cook. */
  readonly materialProgramTransport?: 'raster-source';
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
    | 'invalid-artifact'
    | 'invalid-material-source';
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

// Deep-frozen JSON cannot change, so its ordered copy and JSON text are
// computed once however many assets share it.
const sortedFrozen = new WeakMap<object, unknown>();
const revisionStableFrozen = new WeakMap<object, unknown>();
const jsonTextFrozen = new WeakMap<object, string>();

/** Only deep-frozen JSON enters a cache, so a hit needs no second check. */
function frozenOnce(
  cache: WeakMap<object, unknown>,
  value: unknown,
  derive: (value: unknown) => unknown,
): unknown {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return derive(value);
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const output = derive(value);
  if (!isDeepFrozenJson(value)) return output;
  if (output !== null && typeof output === 'object') Object.freeze(output);
  cache.set(value, output);
  return output;
}

function jsonProjection(
  cache: WeakMap<object, unknown>,
  bytes: (value: Uint8Array) => unknown,
  object: (value: Record<string, unknown>, project: (item: unknown) => unknown) => unknown,
): (item: unknown) => unknown {
  const transform = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return bytes(value);
    // Preserve scalar array backing instead of cloning large mesh payloads.
    if (Array.isArray(value))
      return Object.hasOwn(value, 'toJSON') ||
        value.some((item) => item !== null && typeof item === 'object')
        ? value.map(project)
        : value;
    return value !== null && typeof value === 'object'
      ? object(value as Record<string, unknown>, project)
      : value;
  };
  const project = (item: unknown) => frozenOnce(cache, item, transform);
  return project;
}

const sorted = jsonProjection(
  sortedFrozen,
  (value) => Buffer.from(value).toString('base64'),
  (value, project) => {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) output[key] = project(value[key]);
    return output;
  },
);

const JSON_CHUNK_SIZE = 48 * 1024;

interface JsonWriter {
  pending: string;
  readonly write: (chunk: string) => void;
}

function appendJson(writer: JsonWriter, chunk: string): void {
  writer.pending += chunk;
  if (writer.pending.length >= JSON_CHUNK_SIZE) {
    writer.write(writer.pending);
    writer.pending = '';
  }
}

function writeJsonText(input: string, writer: JsonWriter): void {
  appendJson(writer, '"');
  for (let offset = 0; offset < input.length; ) {
    let end = Math.min(offset + JSON_CHUNK_SIZE, input.length);
    const last = input.charCodeAt(end - 1);
    const next = input.charCodeAt(end);
    // A pair must reach both the native escaper and UTF-8 encoder together.
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++;
    appendJson(writer, JSON.stringify(input.slice(offset, end)).slice(1, -1));
    offset = end;
  }
  appendJson(writer, '"');
}

function scalarJson(input: unknown): string | undefined {
  return typeof input === 'number'
    ? Number.isFinite(input)
      ? String(input)
      : 'null'
    : typeof input === 'function'
      ? undefined
      : JSON.stringify(input);
}

function flushJsonNumbers(writer: JsonWriter, numbers: number[], runStart: number): void {
  appendJson(writer, `${runStart > 0 ? ',' : ''}${JSON.stringify(numbers).slice(1, -1)}`);
  numbers.length = 0;
}

function writeJsonArray(input: readonly unknown[], writer: JsonWriter): void {
  appendJson(writer, '[');
  // Batch native numeric formatting. This scratch belongs only to this traversal.
  const numbers: number[] = [];
  Object.setPrototypeOf(numbers, null);
  let runStart = 0;
  const length = input.length;
  for (let index = 0; index < length; index++) {
    const item = input[index];
    if (typeof item === 'number') {
      if (numbers.length === 0) runStart = index;
      numbers[numbers.length] = item;
      if (numbers.length === 1024) flushJsonNumbers(writer, numbers, runStart);
      continue;
    }
    if (numbers.length > 0) flushJsonNumbers(writer, numbers, runStart);
    if (index > 0) appendJson(writer, ',');
    if (!writeJsonValue(item, String(index), writer)) appendJson(writer, 'null');
  }
  if (numbers.length > 0) flushJsonNumbers(writer, numbers, runStart);
  appendJson(writer, ']');
}

function writeJsonObject(input: object, writer: JsonWriter): void {
  appendJson(writer, '{');
  let first = true;
  // Integer-index enumeration, omission and callback order remain native.
  for (const property of Object.keys(input)) {
    if (
      writeJsonValue(
        (input as Record<string, unknown>)[property],
        property,
        writer,
        `${first ? '' : ','}${JSON.stringify(property)}:`,
      )
    )
      first = false;
  }
  appendJson(writer, '}');
}

function writeJsonValue(input: unknown, key: string, writer: JsonWriter, prefix = ''): boolean {
  if (typeof input === 'string') {
    if (prefix) appendJson(writer, prefix);
    writeJsonText(input, writer);
    return true;
  }
  if (typeof input === 'bigint') {
    const json = JSON.stringify({ [key]: input });
    if (json === '{}') return false;
    if (prefix) appendJson(writer, prefix);
    appendJson(writer, json.slice(JSON.stringify(key).length + 2, -1));
    return true;
  }
  if ((input !== null && typeof input === 'object') || typeof input === 'function') {
    const callback: unknown = (input as { toJSON?: unknown }).toJSON;
    if (typeof callback === 'function') {
      // Keep arbitrary author callbacks on the native route, including their
      // holder key and replacement-object semantics. Ordinary producer data
      // takes the bounded route; the ordering pass above is unchanged.
      // Capture the property once: an inherited accessor must not run again
      // when native JSON calls the author serializer.
      const json = JSON.stringify({
        [key]: { toJSON: () => Reflect.apply(callback, input, [key]) },
      });
      if (json === '{}') return false;
      if (prefix) appendJson(writer, prefix);
      appendJson(writer, json.slice(JSON.stringify(key).length + 2, -1));
      return true;
    }
  }
  if (input === null || typeof input !== 'object') {
    const json = scalarJson(input);
    if (json === undefined) return false;
    if (prefix) appendJson(writer, prefix);
    appendJson(writer, json);
    return true;
  }
  if (prefix) appendJson(writer, prefix);
  const text = frozenJsonText(input);
  if (text !== undefined) appendJson(writer, text);
  else writeJsonContainer(input, writer);
  return true;
}

function writeJsonContainer(input: object, writer: JsonWriter): void {
  if (Array.isArray(input)) writeJsonArray(input, writer);
  else writeJsonObject(input, writer);
}

/** Deep-frozen JSON always writes the same text, so it is written once. */
function frozenJsonText(input: object): string | undefined {
  if (!Object.isFrozen(input)) return undefined;
  const cached = jsonTextFrozen.get(input);
  if (cached !== undefined || !isDeepFrozenJson(input)) return cached;
  const parts: string[] = [];
  const local: JsonWriter = { pending: '', write: (chunk) => parts.push(chunk) };
  writeJsonContainer(input, local);
  parts.push(local.pending);
  const text = parts.join('');
  jsonTextFrozen.set(input, text);
  return text;
}

/** Serialize the already ordered product without one package-sized JS string. */
function writeJson(value: unknown, write: (chunk: string) => void): void {
  const writer: JsonWriter = { pending: '', write };
  if (!writeJsonValue(value, '', writer)) {
    // Match the original hash.update(JSON.stringify(undefined)) failure.
    throw new TypeError('Package JSON must have a serializable root');
  }
  if (writer.pending.length > 0) write(writer.pending);
}

function jsonBytes(value: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  writeJson(value, (text) => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    byteLength += bytes.byteLength;
  });
  // The sink contract owns one complete byte view. Only the bounded UTF-8
  // fragments and that final view coexist, never a package-sized UTF-16 copy.
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function packageUrl(base: string, packagePath: string): string {
  const prefix = base.replace(/\/+$/, '');
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
  const hash = createHash('sha256');
  writeJson(
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
    (chunk) => hash.update(chunk),
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
  if (policy.materialProgramTransport === undefined)
    return finalizeProduct(product, policy, sha256);
  const assets = compactRasterSourcePackageAssets(product.assets);
  if (!assets.ok) return assets;
  return finalizeProduct({ ...product, assets: assets.value }, policy, sha256);
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
    const packageBytes = jsonBytes(sorted(encodeMaterialProgramWire(document)));
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
  let assets = input.assets;
  if (policy.materialProgramTransport !== undefined) {
    const compacted = compactRasterSourcePackageAssets(assets);
    if (!compacted.ok) throw compacted.error;
    assets = compacted.value;
  }
  const sourceRevision = transportRevision({ ...input, assets }, digestBytes);
  const product: PackageProduct = {
    assets,
    receipts:
      input.receipts ??
      assets.map((asset) => ({
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

export function packageTransportRevision(value: unknown): string {
  return transportRevision(value, sha256);
}

function transportRevision(value: unknown, digestBytes: (bytes: Uint8Array) => string): string {
  const hash = createHash('sha256');
  // Deep-frozen JSON holds no bytes, so its cached projection is digest-independent.
  const project = jsonProjection(
    revisionStableFrozen,
    (bytes) => ({ byteLength: bytes.byteLength, digest: digestBytes(bytes) }),
    (record, apply) =>
      Object.fromEntries(
        Object.entries(record)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, apply(item)]),
      ),
  );
  writeJson(project(value), (chunk) => hash.update(chunk));
  return hash.digest('hex');
}
