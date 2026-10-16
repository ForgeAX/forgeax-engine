import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface RangeSample {
  readonly input: number;
  readonly expected: number;
}

interface AuthorityFixture {
  readonly schemaVersion: 1;
  readonly authorityId: 'threeR184SquaredWindow';
  readonly status: 'ready' | 'blocked';
  readonly revision: 'three@0.184.0';
  readonly source: {
    readonly package: 'three';
    readonly path: string;
    readonly sha256: string;
    readonly symbol: 'getDistanceAttenuation';
  };
  readonly config: {
    readonly decayExponent: 2;
    readonly worldUnitMeters: 1;
    readonly exposure: 1;
    readonly directLightIntensityUnits: {
      readonly directional: 'lux';
      readonly point: 'candela';
      readonly spot: 'candela';
    };
    readonly gltfIntensityScale: 1;
    readonly range: {
      readonly finiteRangeUnit: 'meters';
      readonly noCutoffValues: readonly string[];
    };
    readonly cone: {
      readonly sourceUnit: 'radians';
      readonly componentUnit: 'degrees';
      readonly snapshotFields: readonly ['cosInner', 'cosOuter'];
    };
    readonly direction: {
      readonly sourceAxis: '-Z';
      readonly normalizationOwner: 'extract';
      readonly downstreamNormalization: 'forbidden';
    };
  };
  readonly threeR184SquaredWindow: {
    readonly expression: 'clamp(1 - (d / c)^4, 0, 1)^2';
    readonly normalizedDistanceSamples: readonly RangeSample[];
  };
  readonly threeR184NoCutoff: {
    readonly expression: '1 / max(d^2, 0.01)';
    readonly distanceSamples: readonly RangeSample[];
  };
  readonly khrUnsquaredReference: {
    readonly expression: 'clamp(1 - (d / r)^4, 0, 1) / d^2';
    readonly normalizedDistanceWindowSamples: readonly RangeSample[];
    readonly runtimeAuthority: 'reference-only';
  };
}

const calibrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../cases/direct-light/calibration',
);

const sourcePath = join(
  process.cwd(),
  'node_modules/.pnpm/three@0.184.0/node_modules/three/src/nodes/lighting/LightUtils.js',
);

async function loadAuthority(): Promise<AuthorityFixture> {
  const source = await readFile(
    join(calibrationDirectory, 'three-r184-finite-range-authority.json'),
    'utf8',
  );
  return JSON.parse(source) as AuthorityFixture;
}

function squaredWindow(distanceRatio: number): number {
  return Math.max(1 - distanceRatio ** 4, 0) ** 2;
}

function noCutoff(distance: number): number {
  return 1 / Math.max(distance ** 2, 0.01);
}

function authorityReadiness(fixture: {
  readonly source?: AuthorityFixture['source'] | undefined;
  readonly config?: AuthorityFixture['config'] | undefined;
  readonly threeR184SquaredWindow?: AuthorityFixture['threeR184SquaredWindow'] | undefined;
  readonly status?: AuthorityFixture['status'] | undefined;
}): 'ready' | 'blocked' {
  return fixture.source !== undefined && fixture.config !== undefined && fixture.threeR184SquaredWindow !== undefined
    ? fixture.status ?? 'blocked'
    : 'blocked';
}

describe('Three r184 finite-range authority', () => {
  it('pins the source revision and fixed mapping configuration', async () => {
    const fixture = await loadAuthority();
    const source = await readFile(sourcePath);

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.authorityId).toBe('threeR184SquaredWindow');
    expect(fixture.status).toBe('ready');
    expect(fixture.revision).toBe('three@0.184.0');
    expect(fixture.source.path).toBe('src/nodes/lighting/LightUtils.js');
    expect(createHash('sha256').update(source).digest('hex')).toBe(fixture.source.sha256);
    expect(fixture.source.symbol).toBe('getDistanceAttenuation');
    expect(fixture.config).toMatchObject({
      decayExponent: 2,
      worldUnitMeters: 1,
      exposure: 1,
      directLightIntensityUnits: {
        directional: 'lux',
        point: 'candela',
        spot: 'candela',
      },
      gltfIntensityScale: 1,
      range: { finiteRangeUnit: 'meters' },
      cone: {
        sourceUnit: 'radians',
        componentUnit: 'degrees',
        snapshotFields: ['cosInner', 'cosOuter'],
      },
      direction: {
        sourceAxis: '-Z',
        normalizationOwner: 'extract',
        downstreamNormalization: 'forbidden',
      },
    });
  });

  it('matches every finite and no-cutoff expected sample', async () => {
    const fixture = await loadAuthority();

    expect(fixture.threeR184SquaredWindow.expression).toBe('clamp(1 - (d / c)^4, 0, 1)^2');
    for (const sample of fixture.threeR184SquaredWindow.normalizedDistanceSamples) {
      expect(squaredWindow(sample.input)).toBeCloseTo(sample.expected, 12);
    }

    expect(fixture.threeR184NoCutoff.expression).toBe('1 / max(d^2, 0.01)');
    for (const sample of fixture.threeR184NoCutoff.distanceSamples) {
      expect(noCutoff(sample.input)).toBeCloseTo(sample.expected, 12);
    }
  });

  it('keeps the KHR unsquared reference explicit and distinct', async () => {
    const fixture = await loadAuthority();
    const threeSamples = fixture.threeR184SquaredWindow.normalizedDistanceSamples;
    const khrSamples = fixture.khrUnsquaredReference.normalizedDistanceWindowSamples;

    expect(fixture.khrUnsquaredReference.runtimeAuthority).toBe('reference-only');
    expect(fixture.khrUnsquaredReference.expression).toBe('clamp(1 - (d / r)^4, 0, 1) / d^2');
    expect(khrSamples.map((sample) => sample.input)).toEqual(threeSamples.map((sample) => sample.input));
    expect(khrSamples[2]?.expected).not.toBe(threeSamples[2]?.expected);
  });

  it('blocks when source, config, or expected evidence is missing', async () => {
    const fixture = await loadAuthority();

    expect(authorityReadiness({ ...fixture, source: undefined })).toBe('blocked');
    expect(authorityReadiness({ ...fixture, config: undefined })).toBe('blocked');
    expect(authorityReadiness({ ...fixture, threeR184SquaredWindow: undefined })).toBe('blocked');
    expect(authorityReadiness({ ...fixture, status: 'blocked' })).toBe('blocked');
  });
});
