import { isShaderEntryPointReads, isShaderReflection, ShaderSource } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';

const digestPattern = /^[a-f0-9]{64}$/;
export const SHADER_MANIFEST_PUBLICATION_VERSION = '5.0.0' as const;

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

// Verified fragment arrays already own each source independently of other rows.
// Each verified fragment array belongs to exactly one published source digest.
const selectedSources = new WeakMap<readonly string[], ShaderSource>();
const selectedSourcesByRow = new WeakMap<object, readonly string[]>();
const publishedDigests = new WeakMap<readonly string[], string>();
const deferredReflectionRows = new WeakSet<object>();
/** True while a row's reflection is validated on first read instead of at admission. */
export function hasDeferredReflection(row: object): boolean {
  return deferredReflectionRows.has(row);
}

function selectSource(fragments: readonly string[]): ShaderSource {
  let source = selectedSources.get(fragments);
  if (source === undefined) {
    source = new ShaderSource(fragments, publishedDigests.get(fragments));
    selectedSources.set(fragments, source);
  }
  return source;
}

/** Bound to the fragment owner, so detached and foreign-receiver reads stay independent. */
function readSourceText(this: readonly string[]): string {
  return selectSource(this).read();
}

/** Utility rows use the same admitted source owner as material variants. */
export function manifestShaderSource(row: { readonly wgsl: string }): ShaderSource {
  const fragments = selectedSourcesByRow.get(row);
  return fragments === undefined ? new ShaderSource([row.wgsl]) : selectSource(fragments);
}

/** Read the verified fragment owner without retaining its expanded body. */
export function materialShaderSource(row: { readonly composedWgsl: string }): ShaderSource {
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
  for (const fragment of fragments) {
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
  return pattern.test(fragments === undefined ? row.composedWgsl : fragments.join(''));
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
  readonly fragments: Map<string, readonly string[]>;
  readonly indices: Map<string, readonly number[]>;
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
  const sourceFragments = new Map<string, readonly string[]>();
  const sourceIndices = new Map<string, readonly number[]>();
  const usedFragments = new Set<number>();
  for (const digest of referenced) {
    const indices = Object.hasOwn(sources, digest) ? sources[digest] : undefined;
    if (
      !Array.isArray(indices) ||
      indices.length === 0 ||
      !indices.every(
        (index) => Number.isSafeInteger(index) && index >= 0 && index < fragments.length,
      )
    ) {
      throw new Error(`Invalid shader source fragments: ${digest}`);
    }
    const ownedIndices = [...indices] as number[];
    for (const index of ownedIndices) usedFragments.add(index);
    const blocks = ownedIndices.map((index) => fragments[index] as string);
    if (!blocks.some((fragment) => fragment.length > 0)) {
      throw new Error(`Shader source is empty: ${digest}`);
    }
    sourceFragments.set(digest, blocks);
    sourceIndices.set(digest, ownedIndices);
  }
  if (usedFragments.size !== fragments.length) {
    throw new Error('Shader fragment table has unused entries');
  }
  return { fragments: sourceFragments, indices: sourceIndices };
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
  const admittedReflections = new Map<number, unknown>();
  // First read of a deferred reflection snapshots, freezes and validates that
  // one table entry; the result is shared by every row that references it.
  const admitReflection = (index: number): unknown => {
    if (admittedReflections.has(index)) return admittedReflections.get(index);
    // The owned table already shares immutable compiler facts. Validate only the
    // selected row; no clone or retained interning pool is needed here.
    const snapshot = reflections[index];
    freezeTree(snapshot);
    if (!isShaderReflection(snapshot)) throw new Error('Invalid shader manifest publication');
    admittedReflections.set(index, snapshot);
    return snapshot;
  };
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
      Object.defineProperty(result, 'reflection', {
        enumerable: true,
        get: () => admitReflection(reflectionIndex as number),
      });
      deferredReflectionRows.add(result);
    }
    const fragments = sources.fragments.get(digest) as readonly string[];
    let getter = selected.get(digest);
    if (getter === undefined) {
      publishedDigests.set(fragments, digest);
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
        (options.deferReflections !== true && !value.reflections.every(isShaderReflection))))
  ) {
    throw new Error('Invalid shader manifest publication');
  }
}

/** Pure expansion shared by browser admission and synchronous packaged-input loading. */
export function expandShaderManifestPublication(
  value: unknown,
  options: { readonly deferReflections?: boolean } = {},
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
  if (value.schemaVersion !== SHADER_MANIFEST_PUBLICATION_VERSION)
    throw new Error(
      `Unsupported shader manifest publication version: ${String(value.schemaVersion)}`,
    );
  assertPublicationShape(value, options);
  const fragments = [...value.fragments] as string[];
  const sources = value.sources;
  // Own and freeze the pooled ABI facts once before verification yields. Registry
  // keys can then share the admitted receipt instead of cloning its type tree
  // for every material variant.
  const receipts = structuredClone(value.receipts);
  freezeTree(receipts);
  // Snapshot each shared compiler fact once before the first digest await.
  // No row owns a writable copy of this publication-local table.
  const entryPoints = structuredClone(value.entryPoints);
  freezeTree(entryPoints);
  const deferReflections = options.deferReflections === true;
  // Owned JSON can share immutable facts immediately without eagerly validating
  // each reflection. Borrowed input first needs its independent snapshot.
  const reflections = shareReflectionFacts(
    (deferReflections
      ? (value.reflections ?? [])
      : structuredClone(value.reflections ?? [])) as unknown[],
  );
  if (!deferReflections) freezeTree(reflections);
  const referenced: PublicationReferences = {
    sources: new Set(),
    receipts: new Set(),
    entryPoints: new Set(),
    reflections: new Set(),
  };
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
    sourceFragments: resolved.fragments,
    fragmentTable: fragments,
    sourceIndices: resolved.indices,
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
 * `value.reflections`: immutable subtrees are shared in place, and each row is
 * validated on first read without an up-front clone. Callers must pass freshly
 * parsed JSON that nothing else retains.
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

/** Only detached plain acyclic data can acquire structural sharing. */
function plainTree(value: unknown, active: Set<object>, visited: Set<object>): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (active.has(value)) return false;
  if (visited.has(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  active.add(value);
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record))
    if (!plainTree(record[field], active, visited)) return false;
  active.delete(value);
  visited.add(value);
  return true;
}

/**
 * Called on detached snapshots or exclusively owned JSON at admission. The short-lived
 * pool shares complete immutable values, not resource or shader identities.
 * No pool, key string or caller-owned object escapes with the accepted facts.
 */
function shareReflectionFacts(rows: unknown[]): unknown[] {
  if (!plainTree(rows, new Set(), new Set())) return rows;
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
