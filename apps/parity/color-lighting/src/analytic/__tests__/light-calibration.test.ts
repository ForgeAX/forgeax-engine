import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface CalibrationFixture {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly status: 'blocked' | 'ready';
  readonly mapping: {
    readonly directionalIntensityUnit: 'lux';
    readonly punctualIntensityUnit: 'candela';
    readonly worldUnitMeters: number;
    readonly exposureMultiplier: number;
    readonly gltfIntensityScale: number;
  } | null;
  readonly expected: Readonly<Record<string, number>> | null;
  readonly blockingEvidence: readonly string[];
}

const calibrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../cases/direct-light/calibration',
);

async function loadCalibrationFixtures(): Promise<CalibrationFixture[]> {
  const source = await readFile(join(calibrationDirectory, 'three-r184-khr-calibration.json'), 'utf8');
  return [JSON.parse(source) as CalibrationFixture];
}

describe('direct-light calibration gate', () => {
  it('stably blocks implementation while revision-specific evidence is absent', async () => {
    const fixtures = await loadCalibrationFixtures();
    expect(fixtures).toHaveLength(1);
    const fixture = fixtures[0];
    if (fixture === undefined) throw new Error('missing calibration fixture');

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.revision).toBe('three-r184');
    expect(fixture.status).toBe('blocked');
    expect(fixture.mapping).toBeNull();
    expect(fixture.expected).toBeNull();
    expect(fixture.blockingEvidence).toEqual([
      'revision-specific world-unit convention',
      'exposure interaction with direct-light intensity',
      'glTF KHR_lights_punctual import numeric mapping',
    ]);
  });

  it('only a complete mapping can unlock implementation', async () => {
    const [fixture] = await loadCalibrationFixtures();
    if (fixture === undefined) throw new Error('missing calibration fixture');
    const implementationUnlocked = fixture.status === 'ready' && fixture.mapping !== null && fixture.expected !== null;
    expect(implementationUnlocked).toBe(false);
  });
});
