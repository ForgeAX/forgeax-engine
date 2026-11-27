import { isShaderEntryPointReads, isShaderReflection, ShaderSource } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';

// Publication owns source readers for both template and fragment-backed rows.
// Keeping this leaf independent of template admission also permits native Node
// to read source publications without loading a compiler or a bundler resolver.
const boundSourceReaders = new WeakMap<
  object,
  { read: () => ShaderSource; prepared?: () => boolean }
>();

export function bindManifestShaderSource(
  row: object,
  read: () => ShaderSource,
  prepared?: () => boolean,
): void {
  boundSourceReaders.set(row, prepared === undefined ? { read } : { read, prepared });
}

export function manifestShaderSourcePrepared(row: object): boolean {
  return boundSourceReaders.get(row)?.prepared?.() ?? true;
}

export function boundManifestShaderSource(row: object): ShaderSource | undefined {
  return boundSourceReaders.get(row)?.read();
}

const digestPattern = /^[a-f0-9]{64}$/;
export const SHADER_MANIFEST_PUBLICATION_VERSION = '6.0.0' as const;

const sourceDomain = Uint8Array.from('forgeax.shader.source.v4\0', (char) => char.charCodeAt(0));

/** A source identity commits to ordered, individually verified UTF-8 fragments. */
export function shaderSourceDigestInput(
  fragmentDigests: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  if (
    fragmentDigests.length > 0xffff_ffff ||
    fragmentDigests.some((digest) => digest.length !== 32)
  ) {
    throw new Error('Invalid shader fragment digest sequence');
  }
  const input = new Uint8Array(sourceDomain.length + 4 + 32 * fragmentDigests.length);
  input.set(sourceDomain);
  new DataView(input.buffer).setUint32(sourceDomain.length, fragmentDigests.length);
  fragmentDigests.forEach((digest, index) => {
    input.set(digest, sourceDomain.length + 4 + index * 32);
  });
  return input;
}

export async function digestShaderBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  return subtle === undefined
    ? sha256(bytes)
    : new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/** One immutable table and compact indices; expand references only for a selected source. */
interface PublishedSource {
  readonly pool: readonly string[];
  readonly indices: Uint32Array;
  readonly digest: string;
}
const selectedSources = new WeakMap<PublishedSource, ShaderSource>();
const selectedSourcesByRow = new WeakMap<object, PublishedSource>();
const deferredReflectionRows = new WeakSet<object>();
/** True while a row's reflection is validated on first read instead of at admission. */
export function hasDeferredReflection(row: object): boolean {
  return deferredReflectionRows.has(row);
}

function sourceBlocks(source: PublishedSource): string[] {
  return Array.from(source.indices, (index) => source.pool[index] as string);
}

function selectSource(source: PublishedSource): ShaderSource {
  let selected = selectedSources.get(source);
  if (selected === undefined) {
    selected = new ShaderSource(sourceBlocks(source), source.digest);
    selectedSources.set(source, selected);
  }
  return selected;
}

/** Bound to one source owner, never the publication's maps or unused source bodies. */
function readSourceText(this: PublishedSource): string {
  return selectSource(this).read();
}

/** Utility rows use the same admitted source owner as material variants. */
export function manifestShaderSource(row: { readonly wgsl: string }): ShaderSource {
  const templateSource = boundManifestShaderSource(row);
  if (templateSource !== undefined) return templateSource;
  const fragments = selectedSourcesByRow.get(row);
  return fragments === undefined ? new ShaderSource([row.wgsl]) : selectSource(fragments);
}

/** Read the verified fragment owner without retaining its expanded body. */
export function materialShaderSource(row: { readonly composedWgsl: string }): ShaderSource {
  const templateSource = boundManifestShaderSource(row);
  if (templateSource !== undefined) return templateSource;
  const fragments = selectedSourcesByRow.get(row);
  return fragments === undefined ? new ShaderSource([row.composedWgsl]) : selectSource(fragments);
}

/** Exact source matching for boot-module aliases and selected material variants. */
export function materialShaderSourceEquals(
  row: { readonly composedWgsl: string },
  source: string,
): boolean {
  const fragments = selectedSourcesByRow.get(row);
  if (fragments === undefined) return row.composedWgsl === source;
  let offset = 0;
  for (const index of fragments.indices) {
    const fragment = fragments.pool[index] as string;
    if (!source.startsWith(fragment, offset)) return false;
    offset += fragment.length;
  }
  return offset === source.length;
}

/** Inspect complete source without retaining an unselected composed string. */
export function materialShaderSourceMatches(
  row: { readonly composedWgsl: string },
  pattern: RegExp,
): boolean {
  const fragments = selectedSourcesByRow.get(row);
  return pattern.test(
    fragments === undefined ? row.composedWgsl : sourceBlocks(fragments).join(''),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeTree(child);
}

type PublicationReferences = {
  readonly sources: Set<string>;
  readonly receipts: Set<number>;
  readonly entryPoints: Set<number>;
  readonly reflections: Set<number>;
};

type PublicationRows = {
  readonly entries: Record<string, unknown>[];
  readonly materials: Array<{
    readonly row: Record<string, unknown>;
    readonly variants: Record<string, unknown>[];
  }>;
};

type PublicationSources = {
  readonly owners: Map<string, PublishedSource>;
  readonly fragments: ReadonlyMap<string, readonly string[]>;
  readonly indices: ReadonlyMap<string, readonly number[]>;
};

function checkReferenceIndex(
  row: Record<string, unknown>,
  field: string,
  length: number,
  referenced: Set<number>,
  message: string,
): void {
  if (!Object.hasOwn(row, field)) return;
  const index = row[field];
  if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= length) {
    throw new Error(message);
  }
  referenced.add(index as number);
}

function checkPublicationRow(
  candidate: unknown,
  tables: {
    readonly receipts: readonly unknown[];
    readonly entryPoints: readonly unknown[];
    readonly reflections: readonly unknown[];
  },
  referenced: PublicationReferences,
): Record<string, unknown> {
  if (
    !isRecord(candidate) ||
    typeof candidate.sourceDigest !== 'string' ||
    !digestPattern.test(candidate.sourceDigest) ||
    [
      'wgsl',
      'composedWgsl',
      'composedWgslUrl',
      'composedWgslSha256',
      'receipt',
      'entryPoints',
      'reflection',
    ].some((key) => Object.hasOwn(candidate, key))
  ) {
    throw new Error('Shader row requires one source digest');
  }
  referenced.sources.add(candidate.sourceDigest);
  checkReferenceIndex(
    candidate,
    'receiptIndex',
    tables.receipts.length,
    referenced.receipts,
    'Invalid shader receipt reference',
  );
  checkReferenceIndex(
    candidate,
    'entryPointsIndex',
    tables.entryPoints.length,
    referenced.entryPoints,
    'Invalid shader entry points reference',
  );
  checkReferenceIndex(
    candidate,
    'reflectionIndex',
    tables.reflections.length,
    referenced.reflections,
    'Invalid shader reflection reference',
  );
  return candidate;
}

function collectPublicationRows(
  entries: readonly unknown[],
  materialShaders: readonly unknown[],
  tables: {
    readonly receipts: readonly unknown[];
    readonly entryPoints: readonly unknown[];
    readonly reflections: readonly unknown[];
  },
  referenced: PublicationReferences,
): PublicationRows {
  const check = (candidate: unknown) => checkPublicationRow(candidate, tables, referenced);
  return {
    entries: entries.map(check),
    materials: materialShaders.map((candidate) => {
      const row = check(candidate);
      if (!Array.isArray(row.variants)) throw new Error('Material variants must be an array');
      return { row, variants: row.variants.map(check) as Record<string, unknown>[] };
    }),
  };
}

function assertPublicationReferences(
  referenced: PublicationReferences,
  sources: Record<string, unknown>,
  receipts: readonly unknown[],
  entryPoints: readonly unknown[],
  reflections: readonly unknown[],
): void {
  if (Object.keys(sources).length !== referenced.sources.size) {
    throw new Error('Shader source table has missing or unused entries');
  }
  if (referenced.receipts.size !== receipts.length) {
    throw new Error('Shader receipt table has unused entries');
  }
  if (referenced.entryPoints.size !== entryPoints.length) {
    throw new Error('Shader entry points table has unused entries');
  }
  if (referenced.reflections.size !== reflections.length) {
    throw new Error('Shader reflection table has unused entries');
  }
}

function resolvePublicationSources(
  referenced: Set<string>,
  sources: Record<string, unknown>,
  fragments: readonly string[],
): PublicationSources {
  const owners = new Map<string, PublishedSource>();
  const usedFragments = new Set<number>();
  const pool = fragments;
  for (const digest of referenced) {
    const indices = Object.hasOwn(sources, digest) ? sources[digest] : undefined;
    if (
      !Array.isArray(indices) ||
      indices.length === 0 ||
      !indices.every((index) => Number.isSafeInteger(index) && index >= 0 && index < pool.length)
    ) {
      throw new Error(`Invalid shader source fragments: ${digest}`);
    }
    const ownedIndices = Uint32Array.from(indices);
    for (const index of ownedIndices) usedFragments.add(index);
    if (!ownedIndices.some((index) => (pool[index] as string).length > 0)) {
      throw new Error(`Shader source is empty: ${digest}`);
    }
    owners.set(digest, { pool, indices: ownedIndices, digest });
  }
  if (usedFragments.size !== pool.length)
    throw new Error('Shader fragment table has unused entries');
  // These public diagnostic projections are snapshots, not retained runtime storage.
  return {
    owners,
    get fragments() {
      return new Map([...owners].map(([digest, source]) => [digest, sourceBlocks(source)]));
    },
    get indices() {
      return new Map([...owners].map(([digest, source]) => [digest, Array.from(source.indices)]));
    },
  };
}

function deferredReflectionReader(reflections: readonly unknown[]): (index: number) => unknown {
  const admittedReflections = new Map<number, unknown>();
  // First read of a deferred reflection snapshots, freezes and validates that
  // one table entry; the result is shared by every row that references it.
  return (index: number): unknown => {
    if (admittedReflections.has(index)) return admittedReflections.get(index);
    // The owned table already shares immutable compiler facts. Validate only the
    // selected row; no clone or retained interning pool is needed here.
    const snapshot = reflections[index];
    freezeTree(snapshot);
    if (!isShaderReflection(snapshot)) throw new Error('Invalid shader manifest publication');
    admittedReflections.set(index, snapshot);
    return snapshot;
  };
}

function attachDeferredReflection(
  row: object,
  index: number,
  read: (index: number) => unknown,
): void {
  // This getter owns only its reflection reader and index, never the source
  // expansion's maps or the rows awaiting admission.
  Object.defineProperty(row, 'reflection', { enumerable: true, get: () => read(index) });
  deferredReflectionRows.add(row);
}

function expandPublicationRows(
  rows: PublicationRows,
  sources: PublicationSources,
  receipts: readonly unknown[],
  entryPoints: readonly unknown[],
  reflections: readonly unknown[],
  deferReflections = false,
): Record<string, unknown> {
  const selected = new Map<string, () => string>();
  const admitReflection = deferredReflectionReader(reflections);
  const expand = (row: Record<string, unknown>, field: string) => {
    const { sourceDigest, receiptIndex, entryPointsIndex, reflectionIndex, ...metadata } = row;
    const digest = sourceDigest as string;
    const result = {
      ...metadata,
      sourceDigest: digest,
      ...(receiptIndex === undefined ? {} : { receipt: receipts[receiptIndex as number] }),
      ...(entryPointsIndex === undefined
        ? {}
        : { entryPoints: entryPoints[entryPointsIndex as number] }),
      ...(reflectionIndex === undefined || deferReflections
        ? reflectionIndex === undefined
          ? {}
          : {}
        : { reflection: reflections[reflectionIndex as number] }),
    };
    if (deferReflections && reflectionIndex !== undefined) {
      attachDeferredReflection(result, reflectionIndex as number, admitReflection);
    }
    const fragments = sources.owners.get(digest) as PublishedSource;
    let getter = selected.get(digest);
    if (getter === undefined) {
      getter = readSourceText.bind(fragments);
      selected.set(digest, getter);
    }
    selectedSourcesByRow.set(result, fragments);
    Object.defineProperty(result, field, { enumerable: true, get: getter });
    return result;
  };
  return {
    entries: rows.entries.map((row) => expand(row, 'wgsl')),
    materialShaders: rows.materials.map(({ row, variants }) =>
      Object.assign(expand(row, 'composedWgsl'), {
        variants: variants.map((variant) => expand(variant, 'composedWgsl')),
      }),
    ),
  };
}

interface PublicationShape extends Record<string, unknown> {
  readonly entries: unknown[];
  readonly materialShaders: unknown[];
  readonly fragments: string[];
  readonly sources: Record<string, unknown>;
  readonly receipts: Record<string, unknown>[];
  readonly entryPoints: unknown[];
  readonly reflections?: unknown[];
}

function assertPublicationShape(
  value: Record<string, unknown>,
  options: { readonly deferReflections?: boolean },
): asserts value is PublicationShape {
  if (
    !Array.isArray(value.entries) ||
    !Array.isArray(value.materialShaders) ||
    !Array.isArray(value.fragments) ||
    !value.fragments.every((fragment) => typeof fragment === 'string') ||
    !isRecord(value.sources) ||
    !Array.isArray(value.receipts) ||
    !value.receipts.every(isRecord) ||
    !Array.isArray(value.entryPoints) ||
    !value.entryPoints.every(isShaderEntryPointReads) ||
    (value.reflections !== undefined &&
      (!Array.isArray(value.reflections) ||
        (value.schemaVersion === '5.0.0' &&
          options.deferReflections !== true &&
          !value.reflections.every(isShaderReflection))))
  ) {
    throw new Error('Invalid shader manifest publication');
  }
}

/** Resolve transport references without duplicating shared compiler ABI objects. */
function expandReflectionFacts(
  value: PublicationShape,
  entryPoints: readonly unknown[],
  referencedReads: Set<number>,
  owned: boolean,
): unknown[] {
  if (!Array.isArray(value.reflectionBindings))
    throw new Error('Invalid shader reflection bindings table');
  const snapshot = owned
    ? value
    : structuredClone({
        reflections: value.reflections ?? [],
        reflectionBindings: value.reflectionBindings,
      });
  const bindings = sharePublicationFacts(snapshot.reflectionBindings as unknown[]);
  const used = new Set<number>();
  const rows = (snapshot.reflections ?? []).map((row: unknown) => {
    if (
      !isRecord(row) ||
      !Array.isArray(row.bindingIndices) ||
      Object.hasOwn(row, 'boundGlobals') ||
      Object.hasOwn(row, 'entryPoints')
    )
      throw new Error('Invalid shader reflection fact references');
    const { bindingIndices, entryPointsIndex, ...metadata } = row;
    const globals = bindingIndices.map((index: unknown) => {
      if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= bindings.length)
        throw new Error('Invalid shader reflection binding reference');
      used.add(Number(index));
      return bindings[Number(index)];
    });
    checkReferenceIndex(
      row,
      'entryPointsIndex',
      entryPoints.length,
      referencedReads,
      'Invalid shader reflection entry points reference',
    );
    return {
      ...metadata,
      boundGlobals: globals,
      ...(entryPointsIndex === undefined
        ? {}
        : { entryPoints: entryPoints[Number(entryPointsIndex)] }),
    };
  });
  if (used.size !== bindings.length)
    throw new Error('Shader reflection bindings table has unused entries');
  return rows;
}

/** Pure expansion shared by browser admission and synchronous packaged-input loading. */
export function expandShaderManifestPublication(
  value: unknown,
  options: {
    readonly deferReflections?: boolean;
    /** Consume exclusively owned reflection JSON without changing validation timing. */
    readonly ownedReflections?: boolean;
  } = {},
): {
  readonly manifest: unknown;
  readonly sourceFragments: ReadonlyMap<string, readonly string[]>;
  readonly fragmentTable: readonly string[];
  readonly sourceIndices: ReadonlyMap<string, readonly number[]>;
} {
  if (!isRecord(value) || !Object.hasOwn(value, 'schemaVersion')) {
    return {
      manifest: value,
      sourceFragments: new Map(),
      fragmentTable: [],
      sourceIndices: new Map(),
    };
  }
  if (
    value.schemaVersion !== SHADER_MANIFEST_PUBLICATION_VERSION &&
    value.schemaVersion !== '5.0.0'
  )
    throw new Error(
      `Unsupported shader manifest publication version: ${String(value.schemaVersion)}`,
    );
  assertPublicationShape(value, options);
  const fragments = Object.freeze([...value.fragments]) as readonly string[];
  const sources = value.sources;
  // Own and freeze the pooled ABI facts once before verification yields. Registry
  // keys can then share the admitted receipt instead of cloning its type tree
  // for every material variant.
  const receipts = structuredClone(value.receipts);
  freezeTree(receipts);
  // Snapshot each shared compiler fact once before the first digest await.
  // No row owns a writable copy of this publication-local table.
  const entryPoints = sharePublicationFacts(structuredClone(value.entryPoints));
  freezeTree(entryPoints);
  const deferReflections = options.deferReflections === true;
  // Owned JSON can share immutable facts immediately without eagerly validating
  // each reflection. Borrowed input first needs its independent snapshot.
  const referenced: PublicationReferences = {
    sources: new Set(),
    receipts: new Set(),
    entryPoints: new Set(),
    reflections: new Set(),
  };
  const reflections =
    value.schemaVersion === SHADER_MANIFEST_PUBLICATION_VERSION
      ? expandReflectionFacts(value, entryPoints, referenced.entryPoints, deferReflections)
      : sharePublicationFacts(
          (deferReflections || options.ownedReflections === true
            ? (value.reflections ?? [])
            : structuredClone(value.reflections ?? [])) as unknown[],
        );
  if (!deferReflections) {
    freezeTree(reflections);
    if (!reflections.every(isShaderReflection))
      throw new Error('Invalid shader manifest publication');
  }
  const tables = { receipts, entryPoints, reflections };
  const rows = collectPublicationRows(value.entries, value.materialShaders, tables, referenced);
  assertPublicationReferences(referenced, sources, receipts, entryPoints, reflections);
  const resolved = resolvePublicationSources(referenced.sources, sources, fragments);
  // Keep only sources requested by a renderer; verification never populates this cache.
  const manifest = expandPublicationRows(
    rows,
    resolved,
    receipts,
    entryPoints,
    reflections,
    deferReflections,
  );
  return {
    manifest,
    get sourceFragments() {
      return resolved.fragments;
    },
    fragmentTable: fragments,
    get sourceIndices() {
      return resolved.indices;
    },
  };
}

/**
 * Verify source bytes before ShaderRegistry's atomic validation. Reflection facts
 * are detached from `value` and shared within this publication at admission.
 */
export async function readShaderManifestPublication(value: unknown): Promise<unknown> {
  return verifyShaderManifestPublication(expandShaderManifestPublication(value));
}

/**
 * Same verification as {@link readShaderManifestPublication}, but takes ownership of
 * `value.reflections`: complete plain facts share immutable storage without cloning;
 * each row still validates on first read. Callers must pass freshly parsed JSON that
 * nothing else retains. Non-plain values and accessors keep the ordinary deferred route.
 */
export async function readOwnedShaderManifestPublication(value: unknown): Promise<unknown> {
  return verifyShaderManifestPublication(
    expandShaderManifestPublication(value, { deferReflections: true }),
  );
}

async function verifyShaderManifestPublication(
  expanded: ReturnType<typeof expandShaderManifestPublication>,
): Promise<unknown> {
  const sources = [...expanded.sourceIndices];
  const encoder = new TextEncoder();
  const fragmentDigests: Uint8Array[] = [];
  // Hash each pooled fragment once. The complete source is never materialized for admission.
  for (let offset = 0; offset < expanded.fragmentTable.length; offset += 64) {
    const hashes = await Promise.all(
      expanded.fragmentTable
        .slice(offset, offset + 64)
        .map((fragment) => digestShaderBytes(encoder.encode(fragment))),
    );
    fragmentDigests.push(...hashes);
  }
  // The root binds both fragment contents and their order. A bounded batch keeps
  // WebCrypto inputs small even when thousands of variants share the same blocks.
  for (let offset = 0; offset < sources.length; offset += 16) {
    const hashes = await Promise.all(
      sources
        .slice(offset, offset + 16)
        .map(
          async ([digest, indices]) =>
            [
              digest,
              await digestShaderBytes(
                shaderSourceDigestInput(
                  indices.map((index) => fragmentDigests[index] as Uint8Array),
                ),
              ),
            ] as const,
        ),
    );
    for (const [digest, hash] of hashes) {
      const actual = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== digest) throw new Error(`Shader source digest mismatch: ${digest}`);
    }
  }
  return expanded.manifest;
}

interface Fact {
  readonly value: unknown;
  readonly id: number;
}

function losslessJsonPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))
  );
}

/** Only detached plain acyclic data can acquire structural sharing. */
function plainTree(
  value: unknown,
  active: Set<object>,
  visited: Set<object>,
  json: { safe: boolean },
): boolean {
  if (value === null || typeof value !== 'object') {
    json.safe &&= losslessJsonPrimitive(value);
    return true;
  }
  if (active.has(value)) return false;
  if (visited.has(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (prototype === null || (Array.isArray(value) && prototype !== Array.prototype))
    json.safe = false;
  active.add(value);
  const keys = Object.keys(value);
  if (
    Array.isArray(value) &&
    (keys.length !== value.length || keys.some((field, index) => field !== String(index)))
  )
    json.safe = false;
  for (const field of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return false;
    if (!plainTree(descriptor.value, active, visited, json)) return false;
  }
  active.delete(value);
  visited.add(value);
  return true;
}

/**
 * Called on detached entry-read snapshots or exclusively owned reflection JSON at admission.
 * The short-lived pool shares complete immutable values, not resource or shader identities.
 * No pool, key string or caller-owned object escapes with the accepted facts.
 */
function sharePublicationFacts(rows: unknown[]): unknown[] {
  const json = { safe: true };
  if (!plainTree(rows, new Set(), new Set(), json)) return rows;
  if (json.safe) coalesceJsonRowChildren(rows);
  const pool = new Map<string, Fact>();
  const primitives = new Map<unknown, Fact>();
  const fields = new Map<string, number>();
  const negativeZero = Symbol();
  const seen = new WeakMap<object, Fact>();
  let nextId = 0;
  function intern(value: unknown): Fact {
    if (value === null || typeof value !== 'object') {
      const key = Object.is(value, -0) ? negativeZero : value;
      let fact = primitives.get(key);
      if (fact === undefined) {
        fact = { value, id: nextId++ };
        primitives.set(key, fact);
      }
      return fact;
    }
    const previous = seen.get(value);
    if (previous !== undefined) return previous;
    const record = value as Record<string, unknown>;
    let key = Array.isArray(value)
      ? `a${value.length}:`
      : Object.getPrototypeOf(value) === null
        ? 'n:'
        : 'o:';
    // Own key order, array holes, optional absence and signed zero all survive.
    for (const field of Object.keys(record)) {
      let fieldId = fields.get(field);
      if (fieldId === undefined) {
        fieldId = fields.size;
        fields.set(field, fieldId);
      }
      const child = intern(record[field]);
      record[field] = child.value;
      key += `${fieldId}:${child.id};`;
    }
    let fact = pool.get(key);
    if (fact === undefined) {
      fact = { value: Object.freeze(value), id: nextId++ };
      pool.set(key, fact);
    }
    seen.set(value, fact);
    return fact;
  }
  return intern(rows).value as unknown[];
}

/** Native JSON keys coalesce large repeated row children before the recursive walk. */
function coalesceJsonRowChildren(rows: unknown[]): void {
  const children = new Map<string, object>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      const child = record[field];
      if (child === null || typeof child !== 'object') continue;
      const key = JSON.stringify(child);
      const previous = children.get(key);
      if (previous === undefined) children.set(key, child);
      else record[field] = previous;
    }
  }
}
