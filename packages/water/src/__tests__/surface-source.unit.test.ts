import { describe, expect, it } from 'vitest';
import type { WaterBodySnapshot } from '../contracts.js';
import { waterGerstnerSurfaceSource } from '../surface-source.js';

function body(): WaterBodySnapshot {
  return {
    guid: 'lake-instance',
    sceneGeneration: 7,
    binding: { kind: 'unbound' },
    asset: { kind: 'water-body', type: 'lake', waveSetGuid: 'waves' },
    dependencies: [
      {
        guid: 'waves',
        field: 'waveSetGuid',
        kind: 'water-wave-set',
        status: 'valid',
        payload: {
          kind: 'water-wave-set',
          inputDigest: 'a'.repeat(64),
          depthMaskM: 0,
          maxWaveHeightM: 0.2,
          timeSource: 'scene-clock',
          waves: [{ directionXZ: [1, 0], wavelengthM: 10, amplitudeM: 0.2, steepness: 0.1 }],
        },
      },
    ],
  } as unknown as WaterBodySnapshot;
}

describe('Gerstner surface logical read source', () => {
  it('captures identity and dependency revision without another wave array or clock', () => {
    const source = waterGerstnerSurfaceSource('world-a', body()).unwrap();
    expect(source).toEqual({
      model: 'gerstner-fixed/1',
      bodyKey: '["world-a","lake-instance",7,0]',
      bodyGeneration: 7,
      zoneGeneration: 0,
      waveSetDigest: 'a'.repeat(64),
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(waterGerstnerSurfaceSource('world-b', body()).unwrap().bodyKey).not.toBe(source.bodyKey);
  });

  it('rejects unsupported geometry and unaccepted dependencies', () => {
    const source = body();
    expect(
      waterGerstnerSurfaceSource('world', {
        ...source,
        asset: { ...source.asset, type: 'custom' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'query-data-unavailable' } });
    expect(waterGerstnerSurfaceSource('world', { ...source, dependencies: [] })).toMatchObject({
      ok: false,
      error: { code: 'query-data-unavailable' },
    });
  });
});
