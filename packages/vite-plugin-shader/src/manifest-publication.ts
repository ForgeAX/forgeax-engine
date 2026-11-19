import { createHash } from 'node:crypto';
import {
  SHADER_MANIFEST_PUBLICATION_VERSION,
  shaderSourceDigestInput,
} from '@forgeax/engine-shader';

type ShaderEntry = {
  readonly wgsl: string;
  readonly entryPoints?: unknown;
  readonly reflection?: unknown;
};
type MaterialVariant = {
  readonly composedWgsl: string;
  readonly receipt?: unknown;
  readonly entryPoints?: unknown;
  readonly reflection?: unknown;
};
type MaterialEntry = MaterialVariant & { readonly variants: readonly MaterialVariant[] };

/** Identical publication facts share one value and retain row-local references. */
function createFactTable() {
  const values: unknown[] = [];
  const indices = new Map<string, number>();
  // Expanded publications share immutable fact objects across their variants.
  // Reuse that identity only inside this synchronous publication operation;
  // distinct objects still pass the canonical serialized-value interning below.
  const objectIndices = new WeakMap<object, number>();
  return {
    values,
    index(value: unknown): number {
      const object = value !== null && typeof value === 'object' ? value : undefined;
      const previous = object === undefined ? undefined : objectIndices.get(object);
      if (previous !== undefined) return previous;
      const key = JSON.stringify(value);
      let index = indices.get(key);
      if (index === undefined) {
        index = values.length;
        values.push(value);
        indices.set(key, index);
      }
      if (object !== undefined) objectIndices.set(object, index);
      return index;
    },
  };
}

/** Reflection identity is separate from the shared resource ABI and entry-read facts. */
function createReflectionTable(entryPoints: ReturnType<typeof createFactTable>) {
  const rows = createFactTable();
  const bindings = createFactTable();
  const selected = new WeakMap<object, number>();
  const read = (table: readonly unknown[], index: unknown): unknown => {
    if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= table.length)
      throw new Error('Invalid shader reflection fact reference');
    return table[Number(index)];
  };
  return {
    values: rows.values,
    bindings: bindings.values,
    index(
      value: unknown,
      owner?: { reflectionBindings: unknown[]; entryPoints: unknown[] },
    ): number {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid shader reflection facts');
      const previous = selected.get(value);
      if (previous !== undefined) return previous;
      const {
        boundGlobals,
        entryPoints: reads,
        bindingIndices,
        entryPointsIndex,
        ...metadata
      } = value as Record<string, unknown>;
      const globals = owner === undefined ? boundGlobals : bindingIndices;
      if (!Array.isArray(globals)) throw new Error('Invalid shader reflection bindings');
      const selectedReads =
        owner === undefined
          ? reads
          : entryPointsIndex === undefined
            ? undefined
            : read(owner.entryPoints, entryPointsIndex);
      const index = rows.index({
        ...metadata,
        bindingIndices: globals.map((binding) =>
          bindings.index(owner === undefined ? binding : read(owner.reflectionBindings, binding)),
        ),
        ...(selectedReads === undefined
          ? {}
          : { entryPointsIndex: entryPoints.index(selectedReads) }),
      });
      selected.set(value, index);
      return index;
    },
  };
}

/** One build publication owns source fragments and ABI facts across admitted results. */
export function createShaderManifestPublisher(
  sourceFragments?: ReadonlyMap<string, readonly string[]>,
) {
  const digests = new Map<string, string>();
  const fragments: string[] = [];
  const fragmentIndex = new Map<string, number>();
  const fragmentDigests: Buffer[] = [];
  const sources: Record<string, number[]> = {};
  const receipts = createFactTable();
  const entryPoints = createFactTable();
  const reflections = createReflectionTable(entryPoints);
  const sourceDigest = (source: string, owner: string): string => {
    if (!source || /^\.?\/[^\n]+\.composed\.wgsl$/i.test(source)) {
      throw new Error(`Shader manifest requires composed WGSL bytes: ${owner}=${source}`);
    }
    // Do not retain a second whole-body string as an internalized Map key.
    const contentKey = createHash('sha256').update(Buffer.from(source, 'utf16le')).digest('hex');
    const existing = digests.get(contentKey);
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
        // Split slices must not retain an otherwise released complete module.
        const owned = Buffer.from(fragment, 'utf16le').toString('utf16le');
        fragments.push(owned);
        fragmentIndex.set(owned, index);
        fragmentDigests.push(createHash('sha256').update(fragment).digest());
      }
      return index;
    });
    const digest = createHash('sha256')
      .update(shaderSourceDigestInput(indices.map((index) => fragmentDigests[index] as Buffer)))
      .digest('hex');
    digests.set(contentKey, digest);
    sources[digest] = indices;
    return digest;
  };
  const entry = <E extends ShaderEntry>(
    { wgsl, entryPoints: reads, reflection, ...metadata }: E,
    owner: string,
  ) => ({
    ...metadata,
    ...(reads === undefined ? {} : { entryPointsIndex: entryPoints.index(reads) }),
    ...(reflection === undefined ? {} : { reflectionIndex: reflections.index(reflection) }),
    sourceDigest: sourceDigest(wgsl, owner),
  });
  const variant = <M extends MaterialVariant>(
    { composedWgsl, receipt, entryPoints: reads, reflection, ...entry }: M,
    owner: string,
  ) => ({
    ...entry,
    ...(receipt === undefined ? {} : { receiptIndex: receipts.index(receipt) }),
    ...(reads === undefined ? {} : { entryPointsIndex: entryPoints.index(reads) }),
    ...(reflection === undefined ? {} : { reflectionIndex: reflections.index(reflection) }),
    sourceDigest: sourceDigest(composedWgsl, owner),
  });
  return {
    entry,
    variant,
    finish<E, M>(entries: E[], materialShaders: M[]) {
      return {
        schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
        receipts: receipts.values,
        entryPoints: entryPoints.values,
        reflections: reflections.values,
        reflectionBindings: reflections.bindings,
        fragments,
        sources,
        entries,
        materialShaders,
      };
    },
  };
}

/** Publish each composed source once, sharing repeated source blocks across variants. */
export function publishShaderManifest<E extends ShaderEntry, M extends MaterialEntry>(
  entries: readonly E[],
  materialShaders: readonly M[],
  sourceFragments?: ReadonlyMap<string, readonly string[]>,
) {
  const publisher = createShaderManifestPublisher(sourceFragments);
  const programs = entries.map((entry, index) =>
    publisher.entry(
      entry,
      `entry ${index} ${String('hash' in entry ? entry.hash : '')} keys ${Object.keys(entry).join(',')}`,
    ),
  );
  const materials = materialShaders.map(({ variants, ...entry }, index) => ({
    ...publisher.variant(entry, `material ${index}`),
    variants: variants.map((item, variantIndex) =>
      publisher.variant(item, `material ${index} variant ${variantIndex}`),
    ),
  }));
  return publisher.finish(programs, materials);
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
  const reflections = createReflectionTable(entryPoints);
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
      key: 'receiptIndex' | 'entryPointsIndex' | 'reflectionIndex',
      table: unknown[],
      output: ReturnType<typeof createFactTable>,
    ) => {
      if (!Object.hasOwn(row, key)) return {};
      const index = row[key];
      if (!Number.isSafeInteger(index) || Number(index) < 0 || table[Number(index)] === undefined)
        throw new Error(`Shader ${key} reference is missing`);
      return { [key]: output.index(table[Number(index)]) };
    };
    if (
      Object.hasOwn(row, 'reflectionIndex') &&
      (!Number.isSafeInteger(row.reflectionIndex) ||
        Number(row.reflectionIndex) < 0 ||
        Number(row.reflectionIndex) >= owner.reflections.length)
    )
      throw new Error('Shader reflectionIndex reference is missing');
    return {
      ...row,
      ...remap('receiptIndex', owner.receipts, receipts),
      ...remap('entryPointsIndex', owner.entryPoints, entryPoints),
      ...(row.reflectionIndex === undefined
        ? {}
        : {
            reflectionIndex: reflections.index(
              owner.reflections[Number(row.reflectionIndex)],
              owner,
            ),
          }),
    };
  };
  const material = (row: Published['materialShaders'][number], owner: Published) => ({
    ...project(row, owner),
    variants: row.variants.map((variant) => project(variant, owner)),
  });
  const entries = [
    ...engine.entries
      .filter((row) => engineEntryHashes.has(String((row as { hash?: unknown }).hash)))
      .map((row) =>
        // Metadata only fills absent fields; keeping the row's own field order
        // publishes the bytes a source compile of the same entry would.
        project(
          {
            ...row,
            ...Object.fromEntries(
              Object.entries(engineEntryMetadata).filter(([key]) => !Object.hasOwn(row, key)),
            ),
            glsl: '',
          },
          engine,
        ),
      ),
    ...authored.entries.map((row) => project(row, authored)),
  ];
  const materialShaders = [
    ...engine.materialShaders.map((row) => material(row, engine)),
    ...authored.materialShaders.map((row) => material(row, authored)),
  ];
  // Same field order as publishShaderManifest: a build that merges packaged
  // engine inputs publishes the bytes a full source compile would.
  return {
    schemaVersion: SHADER_MANIFEST_PUBLICATION_VERSION,
    receipts: receipts.values,
    entryPoints: entryPoints.values,
    reflections: reflections.values,
    reflectionBindings: reflections.bindings,
    fragments,
    sources,
    entries,
    materialShaders,
  };
}
