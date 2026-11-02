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

// These are the same immutable fragments read by each row's lazy getter.
// Weak row keys keep source queries from extending a publication's lifetime.
const fragmentsByRow = new WeakMap<object, readonly string[]>();
/** Utility rows use the same admitted source owner as material variants. */
export function manifestShaderSource(row: { readonly wgsl: string }): ShaderSource {
  return selectedSourcesByRow.get(row)?.() ?? new ShaderSource([row.wgsl]);
}

const selectedSourcesByRow = new WeakMap<object, () => ShaderSource>();

/** Read the verified fragment owner without retaining its expanded body. */
export function materialShaderSource(row: { readonly composedWgsl: string }): ShaderSource {
  return selectedSourcesByRow.get(row)?.() ?? new ShaderSource([row.composedWgsl]);
}

/** Exact source matching for boot-module aliases and selected material variants. */
export function materialShaderSourceEquals(
  row: { readonly composedWgsl: string },
  source: string,
): boolean {
  const fragments = fragmentsByRow.get(row);
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
  const fragments = fragmentsByRow.get(row);
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
): Record<string, unknown> {
  const selected = new Map<string, ShaderSource>();
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
      ...(reflectionIndex === undefined
        ? {}
        : { reflection: reflections[reflectionIndex as number] }),
    };
    const fragments = sources.fragments.get(digest) as readonly string[];
    fragmentsByRow.set(result, fragments);
    const select = (): ShaderSource => {
      let source = selected.get(digest);
      if (source === undefined) {
        source = new ShaderSource(fragments);
        selected.set(digest, source);
      }
      return source;
    };
    selectedSourcesByRow.set(result, select);
    Object.defineProperty(result, field, {
      enumerable: true,
      get() {
        return select().read();
      },
    });
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

/** Pure expansion shared by browser admission and synchronous packaged-input loading. */
export function expandShaderManifestPublication(value: unknown): {
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
      (!Array.isArray(value.reflections) || !value.reflections.every(isShaderReflection)))
  ) {
    throw new Error('Invalid shader manifest publication');
  }
  const fragments = [...value.fragments] as string[];
  const sources = value.sources;
  const receipts = value.receipts;
  // Snapshot each shared compiler fact once before the first digest await.
  // No row owns a writable copy of this publication-local table.
  const entryPoints = structuredClone(value.entryPoints);
  freezeTree(entryPoints);
  const reflections = structuredClone(value.reflections ?? []) as unknown[];
  freezeTree(reflections);
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
  const manifest = expandPublicationRows(rows, resolved, receipts, entryPoints, reflections);
  return {
    manifest,
    sourceFragments: resolved.fragments,
    fragmentTable: fragments,
    sourceIndices: resolved.indices,
  };
}

/** Verify source bytes before ShaderRegistry's atomic validation. */
export async function readShaderManifestPublication(value: unknown): Promise<unknown> {
  const expanded = expandShaderManifestPublication(value);
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
