import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { iesImporter } from '../ies/ies-importer.js';
import { parseLm63TypeC } from '../ies/parse-lm63.js';
import { readFloat16LE, resampleTypeC } from '../ies/resample-type-c.js';

const GUID = '019f0000-0000-7000-8000-000000000081';
const SOURCE = `IESNA:LM-63-2002
TILT=NONE
1 1000 1 3 3 1 1 1 1 1
1 1 20
0 90 180
0 90 180
1 2 3
4 5 6
1 2 3
`;

function context(source: string): ImportContext {
  return {
    source: 'fixtures/asymmetric.ies',
    readSource: async () => ({ ok: true as const, value: new TextEncoder().encode(source) }),
    readSibling: async () => ({ ok: false as const, error: new Error('not used') as never }),
    decodeImage: async () => {
      throw new Error('not used');
    },
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'ies/main', kind: 'ies-profile' }],
    importSettings: {},
  };
}

function fixture(): string {
  return `IESNA:LM-63-2002
[TEST] ForgeAX Type C fixture
TILT=NONE
1 1000 1 3 3 1 1 1 1 1
1 1 20
0 90 180
0 90 180
1 2 3
4 5 6
1 2 3
`;
}

describe('LM-63 Type C producer primitives', () => {
  it('parses TILT=NONE and preserves Type C angle tables', () => {
    const parsed = parseLm63TypeC(fixture());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.horizontalAnglesDeg).toEqual([0, 90, 180]);
      expect(parsed.value.candela).toHaveLength(9);
      expect(parsed.value.tilt).toBe('NONE');
    }
  });

  it('rejects tilted or non-Type-C sources with source diagnostics', () => {
    const tilted = parseLm63TypeC(fixture().replace('TILT=NONE', 'TILT=INCLUDE'));
    const nonTypeC = parseLm63TypeC(fixture().replace('1 1000 1 3 3 1 1', '1 1000 1 3 3 2 1'));
    expect(tilted.ok).toBe(false);
    expect(nonTypeC.ok).toBe(false);
  });

  it('resamples to deterministic finite peak-normalized little-endian f16 bytes', () => {
    const parsed = parseLm63TypeC(fixture());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = resampleTypeC(parsed.value);
    const second = resampleTypeC(parsed.value);
    expect(first).toEqual(second);
    expect(first).toHaveLength(256 * 128 * 2);
    const samples = Array.from({ length: 256 * 128 }, (_, index) =>
      readFloat16LE(first, index * 2),
    );
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(Math.max(...samples)).toBeCloseTo(1, 6);
    expect(samples[0]).toBeCloseTo(1 / 6, 3);
    expect(samples[127 * 256]).toBeCloseTo(3 / 6, 3);
    expect(samples[255]).toBe(samples[1]);
    expect(samples.at(-1)).toBe(samples[127 * 256 + 1]);
  });
});

function symmetricSource(horizontal: number[], rows: number[], vertical = [0, 180]): string {
  return `IESNA:LM-63-2002
TILT=NONE
1 1000 1 ${vertical.length} ${horizontal.length} 1 2 0 0 0
1 1 20
${vertical.join(' ')}
${horizontal.join(' ')}
${rows.map((value) => vertical.map(() => value).join(' ')).join('\n')}
`;
}

async function importedSamples(source: string): Promise<(degrees: number, row?: number) => number> {
  const imported = await iesImporter.import(context(source));
  expect(imported.ok).toBe(true);
  if (!imported.ok) throw new Error('IES fixture import failed');
  const bytes = imported.value.assets[0]?.artifacts.body?.bytes;
  if (bytes === undefined) throw new Error('missing cooked IES bytes');
  return (degrees, row = 64) => readFloat16LE(bytes, (row * 256 + (degrees / 360) * 256) * 2);
}

describe('LM-63 measured-angle symmetry through import', () => {
  it('rounds a normalized profile across a binary16 exponent boundary', async () => {
    const sample = await importedSamples(symmetricSource([0, 90, 180], [0.24999, 1, 0.9999]));
    expect(sample(0)).toBe(0.25);
    expect(sample(180)).toBe(1);
  });

  it('reflects quadrant symmetry around every 90-degree plane', async () => {
    const sample = await importedSamples(symmetricSource([0, 45, 90], [1, 4, 2]));
    expect(sample(0)).toBeCloseTo(0.25, 3);
    expect(sample(90)).toBeCloseTo(0.5, 3);
    expect(sample(180)).toBeCloseTo(0.25, 3);
    expect(sample(270)).toBeCloseTo(0.5, 3);
    for (const angle of [45, 135, 225, 315]) expect(sample(angle)).toBe(1);
  });

  it('preserves the measured rows when reflecting bilateral symmetry', async () => {
    const sample = await importedSamples(symmetricSource([0, 45, 135, 180], [1, 3, 5, 2]));
    expect(sample(45)).toBeCloseTo(0.6, 3);
    expect(sample(135)).toBe(1);
    expect(sample(315)).toBe(sample(45));
    expect(sample(225)).toBe(sample(135));
    expect(sample(270)).toBe(sample(90));
  });

  it('supports the 90-to-270-degree bilateral plane', async () => {
    const sample = await importedSamples(symmetricSource([90, 180, 270], [1, 2, 3]));
    expect(sample(90)).toBeCloseTo(1 / 3, 3);
    expect(sample(270)).toBe(1);
    expect(sample(0)).toBe(sample(180));
    expect(sample(45)).toBe(sample(135));
    expect(sample(315)).toBe(sample(225));
  });

  it('preserves full-turn asymmetry and rotationally symmetric profiles', async () => {
    const sample = await importedSamples(symmetricSource([0, 90, 180, 270, 360], [1, 2, 3, 4, 1]));
    expect([0, 90, 180, 270].map((angle) => sample(angle))).toEqual([0.25, 0.5, 0.75, 1]);
    const axial = await importedSamples(symmetricSource([0], [2]));
    for (const angle of [0, 45, 90, 180, 270, 315]) expect(axial(angle)).toBe(1);
  });

  it('imports a 270-degree opening with lit diagonal directions and a dark opposite cone', async () => {
    const source = `IESNA:LM-63-2002
TILT=NONE
1 1000 1 5 1 1 2 0 0 0
1 1 20
0 90 134 135 180
0
1 1 1 0 0
`;
    const sample = await importedSamples(source);
    expect(sample(0, 0)).toBe(1);
    expect(sample(0, 80)).toBe(1); // 113.4 degrees: past the lateral plane.
    expect(sample(0, 96)).toBe(0); // 136.1 degrees: beyond the 135-degree half-angle.
    expect(sample(0, 127)).toBe(0);
  });

  it.each([
    [0, 90],
    [90, 180],
  ])('keeps the unmeasured hemisphere dark for vertical angles %j', async (start, end) => {
    const sample = await importedSamples(symmetricSource([0], [2], [start, end]));
    expect(sample(0, 0)).toBe(start === 0 ? 1 : 0);
    expect(sample(0, 127)).toBe(end === 180 ? 1 : 0);
  });

  it('rejects unordered, duplicate and unsupported angle domains and negative candela', () => {
    for (const angles of [
      [0, 90, 45, 180],
      [0, 90, 90, 180],
      [0, 120],
      [10, 180],
    ]) {
      expect(
        parseLm63TypeC(
          symmetricSource(
            angles,
            angles.map(() => 1),
          ),
        ).ok,
      ).toBe(false);
    }
    expect(parseLm63TypeC(symmetricSource([0], [-1])).ok).toBe(false);
    expect(parseLm63TypeC(symmetricSource([0], [1], [0, 100, 90, 180])).ok).toBe(false);
  });
});

describe('IES Pack and publication boundary', () => {
  it('publishes the authored GUID and cooked artifact without source text', async () => {
    const result = await iesImporter.import(context(SOURCE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assets).toHaveLength(1);
    expect(result.value.assets[0]).toMatchObject({ guid: GUID, kind: 'ies-profile' });
    expect(result.value.assets[0]?.payload).toMatchObject({ kind: 'ies-profile' });
    expect(result.value.assets[0]?.artifacts.body?.bytes).toHaveLength(256 * 128 * 2);
  });

  it('is byte deterministic and rejects invalid sources before publication', async () => {
    const first = await iesImporter.import(context(SOURCE));
    const second = await iesImporter.import(context(SOURCE));
    expect(first).toEqual(second);

    const failed = await iesImporter.import(context(SOURCE.replace('TILT=NONE', 'TILT=INCLUDE')));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toMatchObject({ code: 'source-validation-failed' });
      expect(failed.error.expected).toContain('TILT=NONE');
      expect(failed.error.detail).toMatchObject({ diagnostics: expect.any(Array) });
    }
  });
});
