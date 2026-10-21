import { err, ok, type PackV2Error, type Result } from '@forgeax/engine-types';

const SCHEMA = 'pack-material-programs/1';

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

/** Transport sharing ends at the package boundary; every material keeps its complete record. */
export function encodeMaterialProgramWire(value: unknown): unknown {
  if (!record(value) || value.schemaVersion !== '2.0.0' || !Array.isArray(value.assets))
    return value;
  const programs: unknown[] = [];
  const indices = new Map<string, number>();
  const identities = new Map<object, number>();
  let repeated = false;
  const pack = mapPrograms(value, (values) =>
    values.map((program) => {
      if (!record(program)) throw new TypeError('expected a cooked material program object');
      let index = identities.get(program);
      if (index !== undefined) repeated = true;
      else {
        const key = JSON.stringify(program);
        index = indices.get(key);
        if (index === undefined) {
          index = programs.length;
          indices.set(key, index);
          programs.push(program);
        } else repeated = true;
        identities.set(program, index);
      }
      return index;
    }),
  );
  return repeated ? { schemaVersion: SCHEMA, pack, programs } : value;
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
    Object.keys(value).some((key) => !['schemaVersion', 'pack', 'programs'].includes(key)) ||
    !record(value.pack) ||
    value.pack.schemaVersion !== '2.0.0' ||
    !Array.isArray(value.pack.assets) ||
    !Array.isArray(value.programs) ||
    !value.programs.every(record)
  )
    return failure();
  const programs = value.programs;
  const used = new Set<number>();
  let invalid = false;
  const pack = mapPrograms(value.pack, (refs) =>
    refs.map((index) => {
      if (
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= programs.length
      ) {
        invalid = true;
        return undefined;
      }
      used.add(index);
      return programs[index];
    }),
  );
  return invalid || used.size !== programs.length ? failure() : ok(pack);
}
