import { describe, expect, it } from 'vitest';
import { isParticleTopologyRenderer, parseParticleEffectSourceV3 } from '../code-source-v3.js';

const rendererSource = (renderer: unknown) => ({
  schemaVersion: 3,
  emitters: [
    {
      id: 'showcase',
      capacity: 64,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 4 },
      schedule: { rate: 4 },
      program: { module: 'forgeax_vfx::default' },
      renderers: [renderer],
    },
  ],
});

describe('Batch B renderer source contract', () => {
  it.each([
    ['billboard', { kind: 'billboard', material: 'vfx', sorting: 'view-depth' }],
    ['ribbon', { kind: 'ribbon', material: 'vfx', stripKey: 'alive-index', capacity: 32 }],
    ['trail', { kind: 'trail', material: 'vfx', historyLength: 8, capacity: 32 }],
    ['beam', { kind: 'beam', material: 'vfx', endpointField: 'velocity', capacity: 16 }],
  ])('parses the independent %s topology', (_kind, renderer) => {
    const parsed = parseParticleEffectSourceV3(rendererSource(renderer));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.emitters[0]?.renderers[0]).toMatchObject(renderer);
  });

  it('rejects zero topology capacity instead of silently disabling output', () => {
    const parsed = parseParticleEffectSourceV3(
      rendererSource({ kind: 'trail', material: 'vfx', historyLength: 8, capacity: 0 }),
    );

    expect(parsed).toMatchObject({
      ok: false,
      error: { code: 'vfx-source-renderer-invalid' },
    });
  });

  it('keeps an explicitly disabled renderer distinguishable from an empty list', () => {
    const parsed = parseParticleEffectSourceV3(
      rendererSource({
        kind: 'ribbon',
        material: 'vfx',
        stripKey: 'alive-index',
        capacity: 32,
        enabled: false,
      }),
    );

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.emitters[0]?.renderers[0]).toMatchObject({ enabled: false });
  });

  it.each([
    [{ kind: 'billboard', material: 'vfx' }, false],
    [{ kind: 'mesh', material: 'vfx', mesh: 'cube' }, false],
    [{ kind: 'ribbon', material: 'vfx', stripKey: 'alive-index', capacity: 32 }, true],
    [{ kind: 'trail', material: 'vfx', historyLength: 8, capacity: 32 }, true],
    [{ kind: 'beam', material: 'vfx', endpointField: 'velocity', capacity: 16 }, true],
  ] as const)('classifies %o as a topology renderer: %s', (renderer, topology) => {
    const parsed = parseParticleEffectSourceV3(rendererSource(renderer));
    const value = parsed.ok ? parsed.value.emitters[0]?.renderers[0] : undefined;
    expect(value).toBeDefined();
    if (value !== undefined) expect(isParticleTopologyRenderer(value)).toBe(topology);
  });
});
