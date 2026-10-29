import { gunzipSync, gzipSync } from 'node:zlib';

/** The one packaged engine shader input under `dist/engine-inputs/`. */
export const PACKAGED_PROFILES_FILE = 'profiles.json.gz';
export const PACKAGED_PROFILES_VERSION = 2;
export const PACKAGED_PROFILE_NAMES = ['base-ssao', 'point-ssao'] as const;
export type PackagedProfileName = (typeof PACKAGED_PROFILE_NAMES)[number];

/** The compiler publication fields this container pools across profiles. */
interface ProfilePublication {
  readonly schemaVersion: unknown;
  readonly receipts: unknown;
  readonly entryPoints: unknown;
  readonly fragments: readonly string[];
  readonly sources: Readonly<Record<string, readonly number[]>>;
  readonly entries: unknown;
  readonly materialShaders: unknown;
}

/**
 * One profile's publication with its key order intact. Producers differ in
 * key and fragment-table order (compiler vs merged app inputs), so the rows
 * keep both: `fragments` lists the profile's table as pool indices and
 * `sources` lists its digests in publication order.
 */
interface ProfileRows extends Omit<ProfilePublication, 'fragments' | 'sources'> {
  readonly fragments: readonly number[];
  readonly sources: readonly string[];
}

export interface PackagedProfiles {
  readonly schemaVersion: typeof PACKAGED_PROFILES_VERSION;
  /** `engineShaderSourceDigest` of the WGSL every profile was compiled from. */
  readonly shaderSourceDigest: string;
  readonly imports: Record<string, string>;
  readonly fragments: readonly string[];
  readonly sources: Readonly<Record<string, readonly number[]>>;
  readonly profiles: Readonly<Partial<Record<PackagedProfileName, ProfileRows>>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Pools fragments and sources shared by the compiled profiles into one
 * deterministic gzip container. Each profile must rebuild to its exact
 * compiler publication, so consumers keep reading the producer's bytes.
 */
export function encodePackagedProfiles(input: {
  readonly shaderSourceDigest: string;
  readonly imports: Record<string, string>;
  readonly publications: Readonly<Partial<Record<PackagedProfileName, ProfilePublication>>>;
}): Buffer {
  const fragments: string[] = [];
  const fragmentIndices = new Map<string, number>();
  const sources: Record<string, number[]> = {};
  const profiles: Partial<Record<PackagedProfileName, ProfileRows>> = {};
  for (const name of PACKAGED_PROFILE_NAMES) {
    const publication = input.publications[name];
    if (publication === undefined) continue;
    for (const fragment of publication.fragments) {
      if (!fragmentIndices.has(fragment)) {
        fragmentIndices.set(fragment, fragments.length);
        fragments.push(fragment);
      }
    }
    for (const [digest, indices] of Object.entries(publication.sources)) {
      const pooled = indices.map((index) => {
        const fragment = publication.fragments[index];
        if (fragment === undefined) throw new Error(`${name} source ${digest} has no fragment`);
        let pooledIndex = fragmentIndices.get(fragment);
        if (pooledIndex === undefined) {
          pooledIndex = fragments.length;
          fragments.push(fragment);
          fragmentIndices.set(fragment, pooledIndex);
        }
        return pooledIndex;
      });
      const existing = sources[digest];
      if (existing !== undefined && existing.join() !== pooled.join()) {
        throw new Error(`profiles disagree on the fragments of source ${digest}`);
      }
      sources[digest] = pooled;
    }
    profiles[name] = Object.fromEntries(
      Object.entries(publication).map(([key, value]) => [
        key,
        key === 'fragments'
          ? publication.fragments.map((fragment) => fragmentIndices.get(fragment) as number)
          : key === 'sources'
            ? Object.keys(publication.sources)
            : value,
      ]),
    ) as unknown as ProfileRows;
  }
  const container: PackagedProfiles = {
    schemaVersion: PACKAGED_PROFILES_VERSION,
    shaderSourceDigest: input.shaderSourceDigest,
    imports: input.imports,
    fragments,
    sources,
    profiles,
  };
  for (const name of PACKAGED_PROFILE_NAMES) {
    const publication = input.publications[name];
    if (
      publication !== undefined &&
      JSON.stringify(packagedProfilePublication(container, name)) !== JSON.stringify(publication)
    ) {
      throw new Error(`${name} does not rebuild to its exact compiler publication`);
    }
  }
  return gzipSync(JSON.stringify(container), { level: 9 });
}

/**
 * `undefined` for a container written by another format version; malformed
 * current-version bytes throw, because they never come from the producer.
 */
export function decodePackagedProfiles(bytes: Uint8Array): PackagedProfiles | undefined {
  const value: unknown = JSON.parse(gunzipSync(bytes).toString('utf8'));
  if (!isRecord(value) || value.schemaVersion !== PACKAGED_PROFILES_VERSION) return undefined;
  if (
    typeof value.shaderSourceDigest !== 'string' ||
    !isRecord(value.imports) ||
    !Object.values(value.imports).every((source) => typeof source === 'string') ||
    !Array.isArray(value.fragments) ||
    !value.fragments.every((fragment) => typeof fragment === 'string') ||
    !isRecord(value.sources) ||
    !isRecord(value.profiles) ||
    !Object.entries(value.profiles).every(
      ([name, rows]) =>
        (PACKAGED_PROFILE_NAMES as readonly string[]).includes(name) &&
        isRecord(rows) &&
        Array.isArray(rows.fragments) &&
        rows.fragments.every((index) => Number.isSafeInteger(index)) &&
        Array.isArray(rows.sources) &&
        rows.sources.every((digest) => typeof digest === 'string'),
    )
  ) {
    throw new Error('Invalid packaged engine shader profiles');
  }
  return value as unknown as PackagedProfiles;
}

/** The exact producer publication of one profile, or `undefined` when absent. */
export function packagedProfilePublication(
  container: PackagedProfiles,
  name: PackagedProfileName,
): ProfilePublication | undefined {
  const rows = container.profiles[name];
  if (rows === undefined) return undefined;
  const local = new Map<number, number>();
  const fragments = rows.fragments.map((pooled, index) => {
    const fragment = container.fragments[pooled];
    if (fragment === undefined) throw new Error(`Packaged shader fragment is missing: ${pooled}`);
    local.set(pooled, index);
    return fragment;
  });
  const sources = Object.fromEntries(
    rows.sources.map((digest) => {
      const pooled = Object.hasOwn(container.sources, digest)
        ? container.sources[digest]
        : undefined;
      if (!Array.isArray(pooled)) throw new Error(`Packaged shader source is missing: ${digest}`);
      return [
        digest,
        pooled.map((index) => {
          const position = local.get(index);
          if (position === undefined)
            throw new Error(`Packaged shader source ${digest} leaves its profile table`);
          return position;
        }),
      ];
    }),
  );
  return Object.fromEntries(
    Object.entries(rows).map(([key, value]) => [
      key,
      key === 'fragments' ? fragments : key === 'sources' ? sources : value,
    ]),
  ) as unknown as ProfilePublication;
}
