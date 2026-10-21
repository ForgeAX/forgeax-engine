import { isShaderEntryPointReads } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';

const digestPattern = /^[a-f0-9]{64}$/;
export const SHADER_MANIFEST_PUBLICATION_VERSION = '5.0.0' as const;

const sourceDomain = new TextEncoder().encode('forgeax.shader.source.v4\0');

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
    !value.entryPoints.every(isShaderEntryPointReads)
  ) {
    throw new Error('Invalid shader manifest publication');
  }
  const fragments = [...value.fragments] as string[];
  const sources = value.sources;
  const receipts = value.receipts;
  // Snapshot each shared compiler fact once before the first digest await.
  // No row owns a writable copy of this publication-local table.
  const entryPoints = structuredClone(value.entryPoints);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(entryPoints);
  const referenced = new Set<string>();
  const referencedReceipts = new Set<number>();
  const referencedEntryPoints = new Set<number>();
  const check = (candidate: unknown): Record<string, unknown> => {
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
      ].some((key) => Object.hasOwn(candidate, key))
    ) {
      throw new Error('Shader row requires one source digest');
    }
    referenced.add(candidate.sourceDigest);
    if (Object.hasOwn(candidate, 'receiptIndex')) {
      const index = candidate.receiptIndex;
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= receipts.length
      ) {
        throw new Error('Invalid shader receipt reference');
      }
      referencedReceipts.add(index as number);
    }
    if (Object.hasOwn(candidate, 'entryPointsIndex')) {
      const index = candidate.entryPointsIndex;
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= entryPoints.length
      ) {
        throw new Error('Invalid shader entry points reference');
      }
      referencedEntryPoints.add(index as number);
    }
    return candidate;
  };
  const entries = value.entries.map(check);
  const materials = value.materialShaders.map((candidate) => {
    const row = check(candidate);
    if (!Array.isArray(row.variants)) throw new Error('Material variants must be an array');
    return { row, variants: row.variants.map(check) as Record<string, unknown>[] };
  });
  if (Object.keys(sources).length !== referenced.size) {
    throw new Error('Shader source table has missing or unused entries');
  }
  if (referencedReceipts.size !== receipts.length) {
    throw new Error('Shader receipt table has unused entries');
  }
  if (referencedEntryPoints.size !== entryPoints.length) {
    throw new Error('Shader entry points table has unused entries');
  }
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
    ownedIndices.forEach((index) => {
      usedFragments.add(index);
    });
    const blocks = ownedIndices.map((index: number) => fragments[index] as string);
    if (!blocks.some((fragment) => fragment.length > 0)) {
      throw new Error(`Shader source is empty: ${digest}`);
    }
    sourceFragments.set(digest, blocks);
    sourceIndices.set(digest, ownedIndices);
  }
  if (usedFragments.size !== fragments.length) {
    throw new Error('Shader fragment table has unused entries');
  }
  // Keep only sources actually requested by a renderer, instead of every
  // capability permutation. Verification below never populates this cache.
  const decoded = new Map<string, string>();
  const expand = (row: Record<string, unknown>, field: string) => {
    const { sourceDigest, receiptIndex, entryPointsIndex, ...metadata } = row;
    const digest = sourceDigest as string;
    const result = {
      ...metadata,
      ...(receiptIndex === undefined ? {} : { receipt: receipts[receiptIndex as number] }),
      ...(entryPointsIndex === undefined
        ? {}
        : { entryPoints: entryPoints[entryPointsIndex as number] }),
    };
    fragmentsByRow.set(result, sourceFragments.get(digest) as readonly string[]);
    Object.defineProperty(result, field, {
      enumerable: true,
      get() {
        let source = decoded.get(digest);
        if (source === undefined) {
          source = (sourceFragments.get(digest) as readonly string[]).join('');
          decoded.set(digest, source);
        }
        return source;
      },
    });
    return result;
  };
  return {
    manifest: {
      entries: entries.map((row) => expand(row, 'wgsl')),
      materialShaders: materials.map(({ row, variants }) =>
        Object.assign(expand(row, 'composedWgsl'), {
          variants: variants.map((variant) => expand(variant, 'composedWgsl')),
        }),
      ),
    },
    sourceFragments,
    fragmentTable: fragments,
    sourceIndices,
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
