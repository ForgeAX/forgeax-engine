import { createHash } from 'node:crypto';
import {
  SHADER_MANIFEST_PUBLICATION_VERSION,
  shaderSourceDigestInput,
} from '@forgeax/engine-shader';

type ShaderEntry = { readonly wgsl: string; readonly entryPoints?: unknown };
type MaterialVariant = {
  readonly composedWgsl: string;
  readonly receipt?: unknown;
  readonly entryPoints?: unknown;
};
type MaterialEntry = MaterialVariant & { readonly variants: readonly MaterialVariant[] };

/** Identical publication facts share one value and retain row-local references. */
function createFactTable() {
  const values: unknown[] = [];
  const indices = new Map<string, number>();
  return {
    values,
    index(value: unknown): number {
      const key = JSON.stringify(value);
      let index = indices.get(key);
      if (index === undefined) {
        index = values.length;
        values.push(value);
        indices.set(key, index);
      }
      return index;
    },
  };
}

/** Publish each composed source once, sharing repeated source blocks across variants. */
export function publishShaderManifest<E extends ShaderEntry, M extends MaterialEntry>(
  entries: readonly E[],
  materialShaders: readonly M[],
  sourceFragments?: ReadonlyMap<string, readonly string[]>,
) {
  const digests = new Map<string, string>();
  const fragments: string[] = [];
  const fragmentIndex = new Map<string, number>();
  const fragmentDigests: Buffer[] = [];
  const sources: Record<string, number[]> = {};
  const receipts = createFactTable();
  const entryPoints = createFactTable();
  const sourceDigest = (source: string, owner: string): string => {
    if (!source || /^\.?\/[^\n]+\.composed\.wgsl$/i.test(source)) {
      throw new Error(`Shader manifest requires composed WGSL bytes: ${owner}=${source}`);
    }
    const existing = digests.get(source);
    if (existing !== undefined) return existing;
    let blocks = sourceFragments?.get(source);
    if (blocks !== undefined && blocks.join('') !== source) {
      throw new Error('Shader source fragments do not match admitted bytes');
    }
    if (blocks === undefined) {
      const parts = source.split('\n\n');
      blocks = parts
        .map((part, index) => part + (index + 1 < parts.length ? '\n\n' : ''))
        .filter(Boolean);
    }
    const indices = blocks.map((fragment) => {
      let index = fragmentIndex.get(fragment);
      if (index === undefined) {
        index = fragments.length;
        fragments.push(fragment);
        fragmentIndex.set(fragment, index);
        fragmentDigests.push(createHash('sha256').update(fragment).digest());
      }
      return index;
    });
    const digest = createHash('sha256')
      .update(shaderSourceDigestInput(indices.map((index) => fragmentDigests[index] as Buffer)))
      .digest('hex');
    digests.set(source, digest);
    sources[digest] = indices;
    return digest;
  };
  const programs = entries.map(({ wgsl, entryPoints: reads, ...entry }, index) => ({
    ...entry,
    ...(reads === undefined ? {} : { entryPointsIndex: entryPoints.index(reads) }),
    sourceDigest: sourceDigest(
      wgsl,
      `entry ${index} ${String('hash' in entry ? entry.hash : '')} keys ${Object.keys(entry).join(',')}`,
    ),
  }));
  const variant = (
    { composedWgsl, receipt, entryPoints: reads, ...entry }: MaterialVariant,
    owner: string,
  ) => ({
    ...entry,
    ...(receipt === undefined ? {} : { receiptIndex: receipts.index(receipt) }),
    ...(reads === undefined ? {} : { entryPointsIndex: entryPoints.index(reads) }),
    sourceDigest: sourceDigest(composedWgsl, owner),
  });
  const materials = materialShaders.map(({ variants, ...entry }, index) => ({
    ...variant(entry, `material ${index}`),
    variants: variants.map((item, variantIndex) =>
      variant(item, `material ${index} variant ${variantIndex}`),
    ),
  }));
  return {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    receipts: receipts.values,
    entryPoints: entryPoints.values,
    fragments,
    sources,
    entries: programs,
    materialShaders: materials,
  };
}

export type ShaderManifestPublication = ReturnType<typeof publishShaderManifest>;
type Published = ShaderManifestPublication;

/** Carry an admitted engine publication into an app without expanding its WGSL. */
export function mergeShaderManifestPublications(
  engine: Published,
  authored: Published,
  engineEntryHashes: ReadonlySet<string>,
  engineEntryMetadata: Readonly<Record<string, unknown>> = {},
): Published {
  if (
    engine.schemaVersion !== SHADER_MANIFEST_PUBLICATION_VERSION ||
    authored.schemaVersion !== SHADER_MANIFEST_PUBLICATION_VERSION
  )
    throw new Error('Shader publication versions must match');
  const fragments: string[] = [];
  const fragmentIndices = new Map<string, number>();
  const sources: Record<string, number[]> = {};
  const receipts = createFactTable();
  const entryPoints = createFactTable();
  const project = <T extends Record<string, unknown>>(row: T, owner: Published): T => {
    const digest = row.sourceDigest;
    if (typeof digest !== 'string') throw new Error('Shader row has no source digest');
    if (!Object.hasOwn(sources, digest)) {
      const indices = Object.hasOwn(owner.sources, digest) ? owner.sources[digest] : undefined;
      if (indices === undefined) throw new Error(`Shader source is missing: ${digest}`);
      sources[digest] = indices.map((index) => {
        const fragment = owner.fragments[index];
        if (fragment === undefined) throw new Error(`Shader fragment is missing: ${digest}`);
        let outputIndex = fragmentIndices.get(fragment);
        if (outputIndex === undefined) {
          outputIndex = fragments.length;
          fragments.push(fragment);
          fragmentIndices.set(fragment, outputIndex);
        }
        return outputIndex;
      });
    }
    const remap = (
      key: 'receiptIndex' | 'entryPointsIndex',
      table: unknown[],
      output: ReturnType<typeof createFactTable>,
    ) => {
      if (!Object.hasOwn(row, key)) return {};
      const index = row[key];
      if (!Number.isSafeInteger(index) || Number(index) < 0 || table[Number(index)] === undefined)
        throw new Error(`Shader ${key} reference is missing`);
      return { [key]: output.index(table[Number(index)]) };
    };
    return {
      ...row,
      ...remap('receiptIndex', owner.receipts, receipts),
      ...remap('entryPointsIndex', owner.entryPoints, entryPoints),
    };
  };
  const material = (row: Published['materialShaders'][number], owner: Published) => ({
    ...project(row, owner),
    variants: row.variants.map((variant) => project(variant, owner)),
  });
  return {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    fragments,
    sources,
    receipts: receipts.values,
    entryPoints: entryPoints.values,
    entries: [
      ...engine.entries
        .filter((row) => engineEntryHashes.has(String((row as { hash?: unknown }).hash)))
        .map((row) => project({ ...engineEntryMetadata, ...row, glsl: '' }, engine)),
      ...authored.entries.map((row) => project(row, authored)),
    ],
    materialShaders: [
      ...engine.materialShaders.map((row) => material(row, engine)),
      ...authored.materialShaders.map((row) => material(row, authored)),
    ],
  };
}
