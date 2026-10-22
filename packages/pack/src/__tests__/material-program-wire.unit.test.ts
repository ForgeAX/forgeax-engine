import { describe, expect, it } from 'vitest';
import { decodeMaterialProgramWire, encodeMaterialProgramWire } from '../material-program-wire.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

const program = {
  specializationKey: 'sha256:program',
  artifact: { path: 'program.wgsl', mediaType: 'text/wgsl', digest: 'sha256:artifact' },
  selections: [{ pass: 'forward', abi: { fields: ['baseColor'] } }],
};
function fixture() {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    scopeId: 'game',
    generation: 7,
    digest: 'package-digest',
    outputSetDigest: 'output-digest',
    assets: [
      {
        guid: 'material-a',
        kind: 'material',
        refs: ['texture-a'],
        artifacts: {},
        payload: {
          kind: 'material',
          values: { roughness: 0.2 },
          cooked: {
            schemaVersion: 'material-cook/4',
            materialGuid: 'material-a',
            receipt: { sourceRevision: 'a' },
            programs: [structuredClone(program)],
          },
        },
      },
      {
        guid: 'material-b',
        kind: 'material',
        refs: ['texture-b'],
        artifacts: {},
        payload: {
          kind: 'material',
          values: { roughness: 0.8 },
          cooked: {
            schemaVersion: 'material-cook/4',
            materialGuid: 'material-b',
            receipt: { sourceRevision: 'b' },
            programs: [structuredClone(program)],
          },
        },
      },
      {
        guid: 'mesh',
        kind: 'mesh',
        refs: ['material-a'],
        artifacts: {},
        payload: { kind: 'mesh', marker: 42 },
      },
    ],
  };
}
const wire = () => JSON.parse(JSON.stringify(encodeMaterialProgramWire(fixture())));

describe('package material program sharing', () => {
  it('round trips complete records and publication identity without mutating either input', () => {
    const source = fixture(),
      copy = structuredClone(source),
      encoded = wire(),
      original = structuredClone(encoded);
    const result = decodeMaterialProgramWire(encoded);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toEqual(source);
    expect(source).toEqual(copy);
    expect(encoded).toEqual(original);
    const restored = result.value as ReturnType<typeof fixture>;
    expect(restored.assets[0]?.payload.cooked?.programs[0]).toBe(
      restored.assets[1]?.payload.cooked?.programs[0],
    );
    expect(encoded.programs).toHaveLength(1);
  });
  it('retains different program metadata and material parameters', () => {
    const source = fixture();
    required(
      required(required(required(source.assets[1]).payload.cooked).programs[0]).selections[0],
    ).abi.fields.push('normal');
    const encoded = encodeMaterialProgramWire(source);
    expect(encoded).toBe(source);
    const third = structuredClone(required(source.assets[0]));
    third.guid = 'material-c';
    source.assets.push(third);
    const result = decodeMaterialProgramWire(
      JSON.parse(JSON.stringify(encodeMaterialProgramWire(source))),
    );
    expect(result).toMatchObject({ ok: true, value: source });
  });
  it('keeps packages without repeated programs in their ordinary envelope', () => {
    const source = fixture();
    source.assets.splice(1, 1);
    expect(encodeMaterialProgramWire(source)).toBe(source);
    expect(decodeMaterialProgramWire(source)).toMatchObject({ ok: true, value: source });
  });
  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    '0',
    null,
    {},
    999,
  ])('rejects invalid program reference %s', (index) => {
    const input = wire();
    input.pack.assets[0].payload.cooked.programs[0] = index;
    expect(decodeMaterialProgramWire(input)).toMatchObject({
      ok: false,
      error: { code: 'pack-v2-envelope-invalid' },
    });
  });
  it('rejects unused entries, malformed tables and unknown envelope fields', () => {
    const unused = wire();
    unused.programs.push({ ...program, specializationKey: 'other' });
    const malformed = wire();
    malformed.programs[0] = null;
    const unknown = wire();
    unknown.extra = true;
    for (const input of [unused, malformed, unknown])
      expect(decodeMaterialProgramWire(input).ok).toBe(false);
  });
  it('shares one ABI between distinct program specializations', () => {
    const source = fixture();
    const second = required(required(required(source.assets[1]).payload.cooked).programs[0]);
    second.specializationKey = 'sha256:other';
    const encoded = JSON.parse(JSON.stringify(encodeMaterialProgramWire(source)));
    expect(encoded).toMatchObject({ schemaVersion: 'pack-material-programs/2' });
    expect(encoded.programs).toHaveLength(2);
    expect(encoded.abis).toEqual([{ fields: ['baseColor'] }]);
    expect(encoded.programs.map((entry: typeof program) => entry.selections[0]?.abi)).toEqual([
      0, 0,
    ]);
    const result = decodeMaterialProgramWire(encoded);
    expect(result).toMatchObject({ ok: true, value: source });
  });
  it.each([-1, 0.5, '0', null, {}, 999])('rejects invalid ABI reference %s', (index) => {
    const input = wire();
    input.programs[0].selections[0].abi = index;
    expect(decodeMaterialProgramWire(input).ok).toBe(false);
  });
  it('rejects unused ABI entries', () => {
    const input = wire();
    input.abis.push({ fields: ['unused'] });
    expect(decodeMaterialProgramWire(input).ok).toBe(false);
  });
  it('shares records nested in direct and record material representations', () => {
    const source = fixture();
    const first = required(source.assets[0]),
      second = required(source.assets[1]);
    const input = {
      ...source,
      assets: [
        { ...first, payload: first.payload.cooked },
        { ...second, payload: { record: second.payload.cooked } },
      ],
    };
    const result = decodeMaterialProgramWire(
      JSON.parse(JSON.stringify(encodeMaterialProgramWire(input))),
    );
    expect(result).toMatchObject({ ok: true, value: input });
  });
});
