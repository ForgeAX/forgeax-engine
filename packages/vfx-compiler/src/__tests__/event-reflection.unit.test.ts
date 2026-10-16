import { parseParticleEffectSourceV3 } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const base = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'bolt',
      capacity: 64,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 4 },
      schedule: { rate: 1 },
      program: { module: 'bolt.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: 'material-guid' }],
      channels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
      events: [
        {
          id: 'impact-event',
          channel: 'impact',
          subEmitter: 'spark',
          fanOut: 2,
          recursionDepth: 1,
        },
      ],
    },
    {
      id: 'spark',
      capacity: 32,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 2 },
      schedule: { rate: 0 },
      program: { module: 'spark.vfx.wgsl' },
      renderers: [{ kind: 'billboard', material: 'material-guid' }],
    },
  ],
};

describe('VFX event reflection source contract', () => {
  it('reflects bounded channels and same-effect sub-emitter metadata', () => {
    const result = parseParticleEffectSourceV3(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.emitters[0]).toMatchObject({
      channels: [{ id: 'impact', capacity: 2, overflow: 'drop-newest' }],
      events: [{ id: 'impact-event', channel: 'impact', subEmitter: 'spark' }],
    });
  });

  it.each([
    [
      'unknown channel',
      {
        events: [
          { id: 'e', channel: 'missing', subEmitter: 'spark', fanOut: 1, recursionDepth: 1 },
        ],
      },
    ],
    [
      'unknown emitter',
      {
        events: [
          { id: 'e', channel: 'impact', subEmitter: 'missing', fanOut: 1, recursionDepth: 1 },
        ],
      },
    ],
    [
      'fan-out overflow',
      {
        events: [{ id: 'e', channel: 'impact', subEmitter: 'spark', fanOut: 0, recursionDepth: 1 }],
      },
    ],
    [
      'depth overflow',
      {
        events: [{ id: 'e', channel: 'impact', subEmitter: 'spark', fanOut: 1, recursionDepth: 0 }],
      },
    ],
  ])('fails closed for %s with structured detail', (_name, event) => {
    const emitter = { ...base.emitters[0], ...event };
    const result = parseParticleEffectSourceV3({ ...base, emitters: [emitter, base.emitters[1]] });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        code: expect.stringContaining('vfx-'),
        expected: expect.any(String),
        hint: expect.any(String),
        detail: expect.any(Object),
      });
  });
});
