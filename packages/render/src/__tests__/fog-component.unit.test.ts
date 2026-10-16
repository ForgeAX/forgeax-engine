import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Fog } from '../components/fog';
import { selectEnvironment } from '../environment/frame';

describe('Fog component contract', () => {
  it('exposes one bounded authoring component with stable defaults', () => {
    expect(Fog.name).toBe('Fog');
    expect(Fog.fields.color.type).toBe('array<f32, 3>');
    expect(Fog.fields.density.default).toBe(0.01);
    expect(Fog.fields.heightFalloff.default).toBe(0);
    expect(Fog.fields.maxOpacity.default).toBe(1);

    const world = new World();
    const entity = world.spawn({ component: Fog, data: {} }).unwrap();
    const value = world.get(entity, Fog).unwrap();
    expect(Array.from(value.color)).toEqual([0.5, 0.5, 0.5]);
    expect(value.density).toBeCloseTo(0.01);
    expect(value.heightFalloff).toBe(0);
    expect(value.maxOpacity).toBe(1);
  });

  it.each([
    ['color', { color: [1.1, 0.2, 0.3] }],
    ['density', { density: -0.1 }],
    ['heightFalloff', { heightFalloff: Number.NaN }],
    ['maxOpacity', { maxOpacity: 1.1 }],
  ] as const)('rejects invalid %s at the shared selection owner', (field, override) => {
    const result = selectEnvironment({
      environments: [],
      fogs: [
        {
          entityKey: 1,
          color: [0.2, 0.3, 0.4],
          density: 0.01,
          heightFalloff: 0,
          maxOpacity: 1,
          ...override,
        },
      ],
      suns: [],
      lane: 'direct',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('environment-selection-invalid');
    expect(result.error.detail.field).toContain(field);
    expect(result.error.expected).toContain('finite');
    expect(result.error.hint).toContain(field);
  });

  it('rejects a second Fog owner without choosing a first-hit winner', () => {
    const result = selectEnvironment({
      environments: [],
      fogs: [
        { entityKey: 2, color: [0.2, 0.3, 0.4], density: 0.01, heightFalloff: 0, maxOpacity: 1 },
        { entityKey: 3, color: [0.4, 0.3, 0.2], density: 0.02, heightFalloff: 0, maxOpacity: 1 },
      ],
      suns: [],
      lane: 'direct',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'fog-cardinality', detail: { count: 2 } },
    });
  });
});
