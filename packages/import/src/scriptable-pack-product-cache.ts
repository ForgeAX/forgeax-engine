import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { brotliCompress, brotliDecompress, constants } from 'node:zlib';
import { DdcEntryStore, ddcOutputDigest, semanticDdcKey } from '@forgeax/engine-ddc';
import {
  type CookedMaterialRecord,
  rebindMaterialPublicationGeneration,
  withMaterialPublicationGeneration,
} from '@forgeax/engine-pack/material-cook';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { AssetGuid, isScriptablePackAssetKind, PackageId } from '@forgeax/engine-pack/source';
import { engineProducerVersion } from './engine-version.js';
import type {
  ScriptablePackBuildProduct,
  ScriptablePackBuildProductCache,
  ScriptablePackBuildWorkItem,
} from './scriptable-pack-build-core.js';

// Format 8 stores project-root paths as tokens and pairs with the Pack-relative
// input fingerprint. Earlier formats hold checkout-bound fingerprints that the
// current producer no longer emits, so they are cold misses, not migrations.
const CACHE_SCHEMA = 'scriptable-pack-product/8';
const PRODUCT_ARTIFACT = 'product.v8.br';
const LEGACY_CACHE_SCHEMAS = [] as const;
const KINDS_SCHEMA = 'scriptable-pack-product-kinds/1';
const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

interface CachePayload {
  readonly schemaVersion: typeof CACHE_SCHEMA | (typeof LEGACY_CACHE_SCHEMAS)[number];
  readonly sourcePath: string;
}

interface CookerDependencies {
  readonly kinds: readonly string[];
  readonly nativeFree: boolean;
}

function nativeFreeProduct(product: ScriptablePackBuildProduct): boolean {
  if (product.stagedOutputs.length !== product.product.assets.length) return false;
  const outputs = new Map(product.product.assets.map((asset) => [asset.guid, asset.kind]));
  if (outputs.size !== product.product.assets.length) return false;
  return product.stagedOutputs.every(({ guid, asset }) => {
    if (asset === null || typeof asset !== 'object') return false;
    const output = asset as unknown as Record<string, unknown>;
    // These are the two Native registry branches in the Pack build owner.
    // Any native/custom work keeps the complete registry signature, including
    // dependent cookers its implementation may invoke. Unknown products do too.
    return (
      typeof output.kind === 'string' &&
      isScriptablePackAssetKind(output.kind) &&
      !('execution' in output) &&
      !(output.kind === 'material' && Array.isArray(output.passes)) &&
      outputs.get(AssetGuid.format(guid)) === output.kind
    );
  });
}

/**
 * The same cooked program can appear in several materials and again in each
 * material's artifact map. V8 preserves reference identity, so intern equal
 * immutable POD and byte bodies before encoding the product. This changes
 * representation only; caller-owned publications and non-POD remain intact.
 */
function shareImmutableProductData<T>(
  product: T,
  mapString: (value: string) => string = (value) => value,
): T {
  type Shared = { value: unknown; digest?: string };
  const bytesByDigest = new Map<string, Uint8Array[]>();
  const objectsByDigest = new Map<string, object>();
  const strings = new Map<string, string>();
  const visited = new WeakMap<object, Shared>();
  const share = (input: unknown): Shared => {
    const value = typeof input === 'string' ? mapString(input) : input;
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

/**
 * Location-independent spelling of a source path inside a cache identity.
 * With an identity root, keys and payloads use the root-relative POSIX path,
 * so equal sources in different worktrees share one entry; the product body
 * is relocated separately by {@link createProductRelocation}.
 */
function identityPath(roots: readonly string[], path: string): string {
  const [canonicalRoot] = roots;
  if (canonicalRoot === undefined) return path;
  // A path may be spelled through the canonical root or the configured one
  // (symlinks, Windows short names); prefer whichever contains it. Paths
  // outside the project keep their location relative to the canonical root.
  const contained = roots
    .map((root) => relative(root, path))
    .find((local) => local !== '' && !isAbsolute(local) && !local.startsWith('..'));
  const local = contained ?? relative(canonicalRoot, path);
  return isAbsolute(local) ? path : local.split(sep).join('/');
}

const ROOT_TOKEN_PREFIX = '\u0000forgeax-project-root/';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Products name source files by absolute path (Pack source keys, source
 * dependencies, material closures). Entries store each project-root spelling
 * as a token and a hit restores the reading checkout's root, so a hit publishes
 * the bytes a fresh cook at that location would. Anything still naming a root
 * after tokenization is location-bound and stays out of the cache.
 */
function createProductRelocation(roots: readonly string[]) {
  const tokens = roots.map((root, index) => ({
    root,
    token: `${ROOT_TOKEN_PREFIX}${index}\u0000`,
    pattern: new RegExp(`${escapeRegExp(root)}(?=[\\\\/]|$)`, 'g'),
  }));
  const longestFirst = [...tokens].sort((left, right) => right.root.length - left.root.length);
  const markers = [
    Buffer.from(ROOT_TOKEN_PREFIX, 'latin1'),
    Buffer.from(ROOT_TOKEN_PREFIX, 'utf16le'),
  ];
  const restoreString = (value: string): string => {
    if (!value.includes(ROOT_TOKEN_PREFIX)) return value;
    let restored = value;
    for (const { token, root } of tokens) restored = restored.split(token).join(root);
    return restored;
  };
  const restore = (value: unknown, seen: Set<object>): unknown => {
    if (typeof value === 'string') return restoreString(value);
    if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) value[index] = restore(value[index], seen);
    } else if (Object.getPrototypeOf(value) === Object.prototype) {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const next = restore(record[key], seen);
        if (key === '__proto__')
          Object.defineProperty(record, key, {
            value: next,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        else record[key] = next;
      }
    }
    return value;
  };
  return {
    store(value: string): string {
      let stored = value;
      for (const { pattern, token } of longestFirst) stored = stored.replace(pattern, token);
      return stored;
    },
    /**
     * V8 writes one-byte strings as Latin-1 and others as UTF-16LE. A false
     * positive only keeps one product out of the advisory cache.
     */
    locationBound(bytes: Uint8Array): boolean {
      const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return roots.some(
        (root) =>
          view.includes(Buffer.from(root, 'utf16le')) || view.includes(Buffer.from(root, 'latin1')),
      );
    },
    restore<T>(decoded: Uint8Array, product: T): T {
      const view = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      return markers.some((marker) => view.includes(marker))
        ? (restore(product, new Set()) as T)
        : product;
    },
  };
}

/** Immutable Pack products are optional DDC evidence, never author authority. */
export async function createScriptablePackProductCache(options: {
  readonly root: string;
  readonly outputVersions: Readonly<Record<string, string>>;
  readonly cookers: readonly NativeCooker[];
  /**
   * Project root that source paths are keyed relative to. Without it, keys
   * keep absolute paths and entries are private to one checkout location.
   */
  readonly identityRoot?: string;
}): Promise<ScriptablePackBuildProductCache> {
  // Source closures hold canonical paths, other strings may use the
  // configured spelling. Keep both positions, even when equal: relocation
  // tokens are positional across the writing and reading checkouts.
  const identityRoots =
    options.identityRoot === undefined
      ? []
      : [
          await realpath(options.identityRoot).catch(() => resolve(options.identityRoot as string)),
          resolve(options.identityRoot),
        ];
  const sourceIdentity = (path: string): string => identityPath(identityRoots, path);
  const relocation =
    identityRoots.length === 0 ? undefined : createProductRelocation(identityRoots);
  const store = new DdcEntryStore(join(options.root, 'scriptable-pack-products'));
  const kindStore = new DdcEntryStore(join(options.root, 'scriptable-pack-product-kinds'));
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
  const productKinds = (product: ScriptablePackBuildProduct): readonly string[] =>
    [...new Set(product.product.assets.map((asset) => asset.kind))].sort();
  const cacheable = (product: ScriptablePackBuildProduct): boolean =>
    product.externalEvidence.length === 0 &&
    product.product.assets.every(
      (asset) =>
        !cookerIdentities.has(asset.kind) || cookerIdentities.get(asset.kind) !== undefined,
    );
  // The material record retains a publication fence, but its compiled programs
  // are immutable. Normalize only that fence in the DDC body, then bind the
  // current generation after a verified hit; generation never enters the key.
  // A write validates each record before it is stored; a hit's body passed the
  // DDC integrity digests, so it rebinds the stored records without validating
  // their program sets again.
  const bindGeneration = (
    product: ScriptablePackBuildProduct,
    generation: number,
    rebind: (
      cooked: unknown,
      generation: number,
    ) => ReturnType<typeof withMaterialPublicationGeneration> = withMaterialPublicationGeneration,
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
      const rebound = rebind(payload.cooked, generation);
      if (!rebound.ok) return undefined;
      assets.push({ ...asset, payload: { ...payload, cooked: rebound.value } });
    }
    return { ...product, product: { ...product.product, assets } };
  };
  const identity = (
    subject: ScriptablePackBuildWorkItem,
    schema: string,
    dependencies?: CookerDependencies,
  ): { key: string; guid: string } => {
    const guid = PackageId.format(subject.subjectPackageId ?? subject.definition.packageId);
    return {
      guid,
      key: semanticDdcKey({
        schemaVersion: schema,
        importer: 'scriptable-pack',
        codec: `node-v8/${process.versions.v8}`,
        settings: {
          sourcePath: sourceIdentity(subject.sourcePath),
          packageId: guid,
          values: subject.values ?? null,
          inheritedValues: subject.inheritedValues ?? null,
          outputVersions: options.outputVersions,
          engine: engineProducerVersion(),
          ...(schema === KINDS_SCHEMA
            ? {}
            : {
                cookerIdentity:
                  dependencies?.nativeFree !== true
                    ? cookerIdentity
                    : dependencies.kinds.map((kind) => [kind, cookerIdentities.get(kind) ?? null]),
              }),
        },
        // Closure order follows absolute paths; sort the relative rows so the
        // key does not depend on where the checkout sits beside its externals.
        sourceBytes: (subject.sourceClosure ?? [])
          .map((entry) => `${sourceIdentity(entry.path)}\0${entry.digest}`)
          .sort()
          .map((row) => new TextEncoder().encode(row)),
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
    dependencies?: CookerDependencies,
  ): Promise<{ product?: ScriptablePackBuildProduct; reason: string; key: string }> => {
    const { key, guid } = identity(subject, schema, dependencies);
    try {
      const entry = await store.read(key);
      if (entry === null) return { reason: 'entry-not-found', key };
      const payload = entry?.payload as CachePayload | undefined;
      const body = entry?.artifacts[artifact]?.bytes;
      if (
        entry?.guid === guid &&
        payload?.schemaVersion === schema &&
        payload.sourcePath === sourceIdentity(subject.sourcePath) &&
        body !== undefined
      ) {
        const decoded = await decode(body);
        const stored = deserialize(decoded) as ScriptablePackBuildProduct;
        const product = relocation === undefined ? stored : relocation.restore(decoded, stored);
        if (
          product !== null &&
          typeof product === 'object' &&
          typeof product.inputFingerprint === 'string' &&
          Array.isArray(product.externalEvidence) &&
          Array.isArray(product.product?.assets) &&
          cacheable(product) &&
          (dependencies === undefined ||
            (JSON.stringify(productKinds(product)) === JSON.stringify(dependencies.kinds) &&
              nativeFreeProduct(product) === dependencies.nativeFree))
        ) {
          // Only this producer's format was validated before it was stored.
          const rebound = bindGeneration(
            product,
            subject.publicationGeneration ?? 1,
            schema === CACHE_SCHEMA
              ? (cooked, at) =>
                  rebindMaterialPublicationGeneration(cooked as CookedMaterialRecord, at)
              : withMaterialPublicationGeneration,
          );
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
  // A source generation determines its output kinds before native cooking.
  // This immutable discovery row selects a fully semantic product key; it is
  // never a substitute for checking current source bytes or cooker versions.
  const readDependencies = async (subject: ScriptablePackBuildWorkItem) => {
    const { key, guid } = identity(subject, KINDS_SCHEMA);
    const entry = await kindStore.read(key);
    const payload = entry?.payload as
      | { schemaVersion?: unknown; sourcePath?: unknown; kinds?: unknown; nativeFree?: unknown }
      | undefined;
    const kinds = payload?.kinds;
    return entry?.guid === guid &&
      payload?.schemaVersion === KINDS_SCHEMA &&
      payload.sourcePath === sourceIdentity(subject.sourcePath) &&
      typeof payload.nativeFree === 'boolean' &&
      Array.isArray(kinds) &&
      kinds.every((kind) => typeof kind === 'string') &&
      JSON.stringify(kinds) === JSON.stringify([...new Set(kinds)].sort())
      ? { kinds: kinds as readonly string[], nativeFree: payload.nativeFree }
      : undefined;
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
      const bytes = serialize(shareImmutableProductData(immutable, relocation?.store));
      if (relocation?.locationBound(bytes)) {
        timing('skip', subject.sourcePath, startedAt, { reason: 'location-bound' });
        return;
      }
      const compressed = await compress(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      });
      const dependencies = { kinds: productKinds(product), nativeFree: nativeFreeProduct(product) };
      const { key, guid } = identity(subject, CACHE_SCHEMA, dependencies);
      const entry = {
        key,
        guid,
        payload: { schemaVersion: CACHE_SCHEMA, sourcePath: sourceIdentity(subject.sourcePath) },
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
      const discoveryKey = identity(subject, KINDS_SCHEMA).key;
      const discovery = {
        key: discoveryKey,
        guid,
        payload: {
          schemaVersion: KINDS_SCHEMA,
          sourcePath: sourceIdentity(subject.sourcePath),
          ...dependencies,
        },
        refs: [] as string[],
        artifacts: {},
        receipt: {
          guid,
          key: discoveryKey,
          producer: KINDS_SCHEMA,
          inputFingerprint: discoveryKey,
          outputDigest: '',
        },
      };
      discovery.receipt.outputDigest = ddcOutputDigest(discovery);
      await kindStore.write(discovery);
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
      const dependencies = await readDependencies(subject);
      const current: Awaited<ReturnType<typeof readEntry>> =
        dependencies === undefined
          ? { reason: 'entry-not-found', key: identity(subject, KINDS_SCHEMA).key }
          : await readEntry(subject, CACHE_SCHEMA, PRODUCT_ARTIFACT, decompress, dependencies);
      let legacy: Awaited<ReturnType<typeof readEntry>> | undefined;
      if (current.product === undefined)
        for (const schema of LEGACY_CACHE_SCHEMAS) {
          legacy = await readEntry(subject, schema, PRODUCT_ARTIFACT, decompress);
          if (legacy.product !== undefined) break;
        }
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
