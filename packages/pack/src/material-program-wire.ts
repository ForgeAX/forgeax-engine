import { encodeBase64, err, ok, type PackV2Error, type Result } from '@forgeax/engine-types';

const SCHEMA = 'pack-material-programs/2';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapPrograms(
  pack: Record<string, unknown>,
  map: (programs: unknown[]) => unknown[],
): Record<string, unknown> {
  if (!Array.isArray(pack.assets)) return pack;
  return {
    ...pack,
    assets: pack.assets.map((asset: unknown) => {
      if (!record(asset) || asset.kind !== 'material' || !record(asset.payload)) return asset;
      const payload = asset.payload;
      const field =
        payload.schemaVersion === 'material-cook/4'
          ? undefined
          : payload.cooked !== undefined
            ? 'cooked'
            : 'record';
      const cooked = field === undefined ? payload : payload[field];
      if (
        !record(cooked) ||
        cooked.schemaVersion !== 'material-cook/4' ||
        !Array.isArray(cooked.programs)
      )
        return asset;
      const projected = { ...cooked, programs: map(cooked.programs) };
      return {
        ...asset,
        payload: field === undefined ? projected : { ...payload, [field]: projected },
      };
    }),
  };
}

/** Selection ABIs repeat across specializations; each table program refers to them by index. */
function mapAbis(program: Record<string, unknown>, map: (abi: unknown) => unknown): unknown {
  if (!Array.isArray(program.selections)) return program;
  return {
    ...program,
    selections: program.selections.map((selection: unknown) =>
      record(selection) && selection.abi !== undefined
        ? { ...selection, abi: map(selection.abi) }
        : selection,
    ),
  };
}

/** Key metadata and complete binary views without creating an object key per byte. */
function materialProgramKey(value: unknown): string {
  if (!record(value)) return JSON.stringify(value);
  const artifact = Object.getOwnPropertyDescriptor(value, 'artifact')?.value;
  const bytes = record(artifact)
    ? Object.getOwnPropertyDescriptor(artifact, 'bytes')?.value
    : undefined;
  // JSON-only records and custom serializers retain the native JSON path.
  if (
    !record(artifact) ||
    !(bytes instanceof Uint8Array) ||
    'toJSON' in value ||
    'toJSON' in artifact ||
    'toJSON' in bytes
  )
    return JSON.stringify(value);
  const paths = new WeakMap<object, string>();
  let artifactBytes: string | undefined;
  const json = JSON.stringify(value, function (this: object, key: string, entry: unknown) {
    if (entry === null || typeof entry !== 'object') return entry;
    const parent = paths.get(this);
    const path =
      parent === undefined ? '' : `${parent}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    paths.set(entry, path);
    if (path === '/artifact/bytes' && entry instanceof Uint8Array) {
      // Read the actual view through a private snapshot, including its offset.
      // Own encoders or claimed artifact identities cannot replace its contents.
      artifactBytes = encodeBase64(new Uint8Array(entry));
      return null;
    }
    return entry;
  });
  // Ordinary JSON cannot start with this prefix. Paths distinguish bytes from
  // literal metadata outside the canonical artifact byte field.
  return artifactBytes === undefined ? json : `bytes:${JSON.stringify([json, artifactBytes])}`;
}

class Interner {
  constructor(keyFor?: (value: unknown) => string) {
    this.keyFor = keyFor;
  }
  private readonly keyFor: ((value: unknown) => string) | undefined;
  readonly values: unknown[] = [];
  private readonly indices = new Map<string, number>();
  repeated = false;
  index(value: unknown): number {
    const key = this.keyFor === undefined ? JSON.stringify(value) : this.keyFor(value);
    let index = this.indices.get(key);
    if (index === undefined) {
      index = this.values.length;
      this.indices.set(key, index);
      this.values.push(value);
    } else this.repeated = true;
    return index;
  }
}

/** Transport sharing ends at the package boundary; every material keeps its complete record. */
export function encodeMaterialProgramWire(value: unknown): unknown {
  if (!record(value) || value.schemaVersion !== '2.0.0' || !Array.isArray(value.assets))
    return value;
  const programs = new Interner(materialProgramKey);
  const identities = new Map<object, number>();
  const pack = mapPrograms(value, (values) =>
    values.map((program) => {
      if (!record(program)) throw new TypeError('expected a cooked material program object');
      let index = identities.get(program);
      if (index !== undefined) programs.repeated = true;
      else {
        index = programs.index(program);
        identities.set(program, index);
      }
      return index;
    }),
  );
  const abis = new Interner();
  const table = programs.values.map((program) =>
    mapAbis(program as Record<string, unknown>, (abi) => abis.index(abi)),
  );
  return programs.repeated || abis.repeated
    ? { schemaVersion: SCHEMA, pack, programs: table, abis: abis.values }
    : value;
}

/** Restore sharing before ordinary envelope, publication and material integrity validation. */
export function decodeMaterialProgramWire(value: unknown): Result<unknown, PackV2Error> {
  if (!record(value) || value.schemaVersion !== SCHEMA) return ok(value);
  const failure = () =>
    err<PackV2Error>({
      code: 'pack-v2-envelope-invalid',
      expected: 'a complete package material-program table with valid references',
      hint: 'rebuild the package with the current Engine',
      detail: { observed: 'invalid material program table', expected: SCHEMA },
    });
  if (
    Object.keys(value).some(
      (key) => !['schemaVersion', 'pack', 'programs', 'abis'].includes(key),
    ) ||
    !record(value.pack) ||
    value.pack.schemaVersion !== '2.0.0' ||
    !Array.isArray(value.pack.assets) ||
    !Array.isArray(value.programs) ||
    !value.programs.every(record) ||
    !Array.isArray(value.abis) ||
    !value.abis.every(record)
  )
    return failure();
  const abis = value.abis;
  const usedAbis = new Set<number>();
  let invalid = false;
  const reference = (index: unknown, length: number): index is number =>
    typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < length;
  const programs = value.programs.map((program) =>
    mapAbis(program, (index) => {
      if (!reference(index, abis.length)) {
        invalid = true;
        return undefined;
      }
      usedAbis.add(index);
      return abis[index];
    }),
  );
  const used = new Set<number>();
  const pack = mapPrograms(value.pack, (refs) =>
    refs.map((index) => {
      if (!reference(index, programs.length)) {
        invalid = true;
        return undefined;
      }
      used.add(index);
      return programs[index];
    }),
  );
  return invalid || used.size !== programs.length || usedAbis.size !== abis.length
    ? failure()
    : ok(pack);
}
