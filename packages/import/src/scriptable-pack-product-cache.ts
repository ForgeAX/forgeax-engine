import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { brotliCompress, brotliDecompress, constants } from 'node:zlib';
import { DdcEntryStore, ddcOutputDigest, semanticDdcKey } from '@forgeax/engine-ddc';
import { withMaterialPublicationGeneration } from '@forgeax/engine-pack/material-cook';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { PackageId } from '@forgeax/engine-pack/source';
import type {
  ScriptablePackBuildProduct,
  ScriptablePackBuildProductCache,
  ScriptablePackBuildWorkItem,
} from './scriptable-pack-build-core.js';

const CACHE_SCHEMA = 'scriptable-pack-product/6';
const PRODUCT_ARTIFACT = 'product.v8.br';
const LEGACY_CACHE_SCHEMA = 'scriptable-pack-product/5';
const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

interface CachePayload {
  readonly schemaVersion: typeof CACHE_SCHEMA | typeof LEGACY_CACHE_SCHEMA;
  readonly sourcePath: string;
}

/**
 * The same cooked program can appear in several materials and again in each
 * material's artifact map. V8 preserves reference identity, so intern equal
 * immutable POD and byte bodies before encoding the product. This changes
 * representation only; caller-owned publications and non-POD remain intact.
 */
function shareImmutableProductData<T>(product: T): T {
  type Shared = { value: unknown; digest?: string };
  const bytesByDigest = new Map<string, Uint8Array[]>();
  const objectsByDigest = new Map<string, object>();
  const strings = new Map<string, string>();
  const visited = new WeakMap<object, Shared>();
  const share = (value: unknown): Shared => {
    if (typeof value === 'string') {
      let digest = strings.get(value);
      if (digest === undefined) {
        digest = createHash('sha256').update(value, 'utf16le').digest('hex');
        strings.set(value, digest);
      }
      return { value, digest: `string:${digest}` };
    }
    if (value === null || typeof value !== 'object') {
      const kind = typeof value;
      return {
        value,
        ...(kind === 'function' || kind === 'symbol'
          ? {}
          : {
              digest: `${kind}:${Object.is(value, -0) ? '-0' : String(value)}`,
            }),
      };
    }
    const prior = visited.get(value);
    if (prior !== undefined) return prior;
    if (value instanceof Uint8Array) {
      const digest = `${value.constructor.name}:${createHash('sha256').update(value).digest('hex')}`;
      const matches = bytesByDigest.get(digest);
      const existing = matches?.find((candidate) => Buffer.compare(candidate, value) === 0);
      const shared = { value: existing ?? value, digest: `bytes:${digest}` };
      if (existing === undefined) {
        if (matches === undefined) bytesByDigest.set(digest, [value]);
        else matches.push(value);
      }
      visited.set(value, shared);
      return shared;
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
      return { value };
    const copy: unknown[] | Record<string, unknown> = Array.isArray(value)
      ? new Array(value.length)
      : {};
    const shared: Shared = { value: copy };
    visited.set(value, shared);
    const hash = createHash('sha256').update(
      Array.isArray(value) ? `array:${value.length};` : 'object;',
    );
    let immutable = true;
    for (const [key, child] of Object.entries(value)) {
      const result = share(child);
      if (key === '__proto__')
        Object.defineProperty(copy, key, {
          value: result.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else (copy as Record<string, unknown>)[key] = result.value;
      if (result.digest === undefined) immutable = false;
      else
        hash
          .update(`${key.length}:`)
          .update(key, 'utf16le')
          .update(`${result.digest.length}:`)
          .update(result.digest);
    }
    // Cycles and non-POD objects preserve their original graph semantics.
    if (immutable) {
      shared.digest = hash.digest('hex');
      const existing = objectsByDigest.get(shared.digest);
      if (existing === undefined) objectsByDigest.set(shared.digest, copy);
      else shared.value = existing;
    }
    return shared;
  };
  return share(product).value as T;
}

async function sourceClosureCurrent(subject: ScriptablePackBuildWorkItem): Promise<boolean> {
  if (subject.sourceClosure === undefined || subject.sourceClosure.length === 0) return false;
  try {
    const checks = await Promise.all(
      subject.sourceClosure.map(async ({ path, digest }) => {
        const actual = `sha256:${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}`;
        return actual === digest;
      }),
    );
    return checks.every(Boolean);
  } catch {
    return false;
  }
}

/** Immutable Pack products are optional DDC evidence, never author authority. */
export async function createScriptablePackProductCache(options: {
  readonly root: string;
  readonly outputVersions: Readonly<Record<string, string>>;
  readonly cookers: readonly NativeCooker[];
}): Promise<ScriptablePackBuildProductCache> {
  const store = new DdcEntryStore(join(options.root, 'scriptable-pack-products'));
  const timing = (
    state: 'hit' | 'miss' | 'write' | 'skip' | 'write-failed',
    sourcePath: string,
    startedAt: number,
    detail: Record<string, unknown> = {},
  ): void => {
    if (process.env.FORGEAX_WORKSPACE_TIMING !== '1') return;
    console.error(
      '[forgeax.pack-ddc.timing]',
      JSON.stringify({
        state,
        sourcePath,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...detail,
      }),
    );
  };
  const cookerIdentities = new Map<string, string | undefined>();
  for (const cooker of options.cookers) {
    try {
      cookerIdentities.set(cooker.key, await cooker.cacheIdentity?.());
    } catch {
      cookerIdentities.set(cooker.key, undefined);
    }
  }
  const cookerIdentity = [...cookerIdentities].sort(([left], [right]) => left.localeCompare(right));
  const cacheable = (product: ScriptablePackBuildProduct): boolean =>
    product.externalEvidence.length === 0 &&
    product.product.assets.every(
      (asset) =>
        !cookerIdentities.has(asset.kind) || cookerIdentities.get(asset.kind) !== undefined,
    );
  // The material record retains a publication fence, but its compiled programs
  // are immutable. Normalize only that fence in the DDC body, then bind the
  // current generation after a verified hit; generation never enters the key.
  const bindGeneration = (
    product: ScriptablePackBuildProduct,
    generation: number,
  ): ScriptablePackBuildProduct | undefined => {
    const assets = [];
    for (const asset of product.product.assets) {
      if (asset.kind !== 'material') {
        assets.push(asset);
        continue;
      }
      const payload = asset.payload;
      if (payload === null || typeof payload !== 'object' || !('cooked' in payload)) {
        assets.push(asset);
        continue;
      }
      const rebound = withMaterialPublicationGeneration(payload.cooked, generation);
      if (!rebound.ok) return undefined;
      assets.push({ ...asset, payload: { ...payload, cooked: rebound.value } });
    }
    return { ...product, product: { ...product.product, assets } };
  };
  const identity = (
    subject: ScriptablePackBuildWorkItem,
    schema: CachePayload['schemaVersion'] = CACHE_SCHEMA,
  ): { key: string; guid: string } => {
    const guid = PackageId.format(subject.subjectPackageId ?? subject.definition.packageId);
    return {
      guid,
      key: semanticDdcKey({
        schemaVersion: schema,
        importer: 'scriptable-pack',
        codec: `node-v8/${process.versions.v8}`,
        settings: {
          sourcePath: subject.sourcePath,
          packageId: guid,
          values: subject.values ?? null,
          inheritedValues: subject.inheritedValues ?? null,
          outputVersions: options.outputVersions,
          cookerIdentity,
        },
        sourceBytes: (subject.sourceClosure ?? []).map((entry) =>
          new TextEncoder().encode(`${entry.path}\0${entry.digest}`),
        ),
        declaredGuids: [guid],
        targetProfile: 'dev',
        producer: schema,
      }),
    };
  };
  const readEntry = async (
    subject: ScriptablePackBuildWorkItem,
    schema: CachePayload['schemaVersion'],
    artifact: string,
    decode: (bytes: Uint8Array) => Promise<Uint8Array>,
  ): Promise<{ product?: ScriptablePackBuildProduct; reason: string; key: string }> => {
    const { key, guid } = identity(subject, schema);
    try {
      const entry = await store.read(key);
      if (entry === null) return { reason: 'entry-not-found', key };
      const payload = entry?.payload as CachePayload | undefined;
      const body = entry?.artifacts[artifact]?.bytes;
      if (
        entry?.guid === guid &&
        payload?.schemaVersion === schema &&
        payload.sourcePath === subject.sourcePath &&
        body !== undefined
      ) {
        const product = deserialize(await decode(body)) as ScriptablePackBuildProduct;
        if (
          product !== null &&
          typeof product === 'object' &&
          typeof product.inputFingerprint === 'string' &&
          Array.isArray(product.externalEvidence) &&
          Array.isArray(product.product?.assets) &&
          cacheable(product)
        ) {
          const rebound = bindGeneration(product, subject.publicationGeneration ?? 1);
          return rebound === undefined
            ? { reason: 'generation-invalid', key }
            : { product: rebound, reason: 'hit', key };
        }
        return { reason: 'product-invalid', key };
      }
      return { reason: 'entry-identity-invalid', key };
    } catch {
      // A damaged optional entry is disposable; try the preceding format or cook.
      return { reason: 'entry-read-invalid', key };
    }
  };
  const write: ScriptablePackBuildProductCache['write'] = async (subject, product) => {
    const startedAt = performance.now();
    if (!cacheable(product)) {
      timing('skip', subject.sourcePath, startedAt, {
        reason: product.externalEvidence.length ? 'external-evidence' : 'unversioned-cooker',
      });
      return;
    }
    if (!(await sourceClosureCurrent(subject))) {
      timing('skip', subject.sourcePath, startedAt, { reason: 'source-changed' });
      return;
    }
    try {
      const immutable = bindGeneration(product, 1);
      if (immutable === undefined) return;
      const bytes = serialize(shareImmutableProductData(immutable));
      const compressed = await compress(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      });
      const { key, guid } = identity(subject);
      const entry = {
        key,
        guid,
        payload: { schemaVersion: CACHE_SCHEMA, sourcePath: subject.sourcePath },
        refs: [] as string[],
        artifacts: {
          [PRODUCT_ARTIFACT]: {
            mediaType: 'application/vnd.node-v8-serialized+br',
            bytes: compressed,
          },
        },
        receipt: {
          guid,
          key,
          producer: CACHE_SCHEMA,
          inputFingerprint: key,
          outputDigest: '',
        },
      };
      entry.receipt.outputDigest = ddcOutputDigest(entry);
      await store.write(entry);
      timing('write', subject.sourcePath, startedAt, {
        key,
        serializedBytes: bytes.byteLength,
        storedBytes: compressed.byteLength,
      });
    } catch {
      // Cache persistence is advisory. Serialization and DDC failures never
      // turn an otherwise valid Pack publication into a failed build.
      timing('write-failed', subject.sourcePath, startedAt);
    }
  };
  return {
    async read(subject) {
      const startedAt = performance.now();
      if (!(await sourceClosureCurrent(subject))) {
        timing('miss', subject.sourcePath, startedAt, { reason: 'source-changed' });
        return undefined;
      }
      const current = await readEntry(subject, CACHE_SCHEMA, PRODUCT_ARTIFACT, decompress);
      const legacy =
        current.product === undefined
          ? await readEntry(subject, LEGACY_CACHE_SCHEMA, PRODUCT_ARTIFACT, decompress)
          : undefined;
      const product = current.product ?? legacy?.product;
      if (product !== undefined && (await sourceClosureCurrent(subject))) {
        // Format migration only republishes a verified immutable product; it
        // never changes source identity or makes an old publication authoritative.
        if (legacy?.product !== undefined) await write(subject, legacy.product);
        timing('hit', subject.sourcePath, startedAt, {
          key: current.product === undefined ? legacy?.key : current.key,
        });
        return product;
      }
      timing('miss', subject.sourcePath, startedAt, {
        key: current.key,
        reason: product === undefined ? current.reason : 'source-changed',
      });
      return undefined;
    },
    write,
  };
}
