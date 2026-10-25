import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { Fog, FogModeValue, fogModeFromU32 } from '../components/fog';
import { selectEnvironment } from '../environment/frame';
import { type FogCandidate, fogIsActive } from '../extract/environment';

const EXP_FOG: FogCandidate = {
  entityKey: 1,
  color: [0.2, 0.3, 0.4],
  density: 0.01,
  heightFalloff: 0,
  maxOpacity: 1,
  mode: 'exp',
  near: 0,
  far: 100,
};

function selectionIssue(candidate: FogCandidate): { field: unknown; expected: string } | undefined {
  const result = selectEnvironment({ environments: [], fogs: [candidate], suns: [] });
  if (result.ok) return undefined;
  if (result.error.code !== 'environment-selection-invalid') throw result.error;
  return { field: result.error.detail.field, expected: result.error.expected };
}

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
    expect(value.mode).toBe(FogModeValue.exp);
    expect(value.near).toBe(0);
    expect(value.far).toBe(100);
  });

  it('names the Three.js fog laws as closed mode labels', () => {
    expect(FogModeValue).toEqual({ exp: 0, exp2: 1, linear: 2 });
    expect([0, 1, 2, 3].map(fogModeFromU32)).toEqual(['exp', 'exp2', 'linear', undefined]);
  });

  it('accepts scene-linear HDR fog colours, as Three.js accepts any Color', () => {
    expect(selectionIssue({ ...EXP_FOG, color: [0.65, 1.1, 1.55] })).toBeUndefined();
    expect(selectionIssue({ ...EXP_FOG, color: [0.2, Number.POSITIVE_INFINITY, 0.1] })?.field).toBe(
      'color[1]',
    );
  });

  it('names the violated bound in the error message a Worker surfaces', () => {
    const result = selectEnvironment({
      environments: [],
      fogs: [{ ...EXP_FOG, color: [0.2, -1, 0.1] }],
      suns: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe(
      'environment selection field color[1] is invalid: expected a finite number >= 0 (scene-linear; values above 1 are HDR), got -1',
    );
  });

  it('accepts Three.js Fog(color, near, far) and FogExp2(color, density) shapes', () => {
    expect(selectionIssue({ ...EXP_FOG, mode: 'linear', near: 65, far: 125 })).toBeUndefined();
    expect(selectionIssue({ ...EXP_FOG, mode: 'exp2', density: 0.02 })).toBeUndefined();
  });

  it.each([
    ['mode', { mode: undefined }],
    ['near', { mode: 'linear', near: -1 }],
    ['far', { mode: 'linear', near: 50, far: 50 }],
    ['far', { mode: 'linear', far: Number.POSITIVE_INFINITY }],
    ['heightFalloff', { mode: 'exp2', heightFalloff: 0.1 }],
    ['heightFalloff', { mode: 'linear', heightFalloff: 0.1 }],
  ] as const)('rejects an invalid %s for its mode', (field, override) => {
    expect(selectionIssue({ ...EXP_FOG, ...override })?.field).toBe(field);
  });

  it('activates linear fog by its range and the exponential laws by density', () => {
    expect(fogIsActive({ ...EXP_FOG, mode: 'linear', density: 0, near: 10, far: 20 })).toBe(true);
    expect(fogIsActive({ ...EXP_FOG, mode: 'linear', maxOpacity: 0, near: 10, far: 20 })).toBe(
      false,
    );
    expect(fogIsActive({ ...EXP_FOG, mode: 'exp2', density: 0 })).toBe(false);
    expect(fogIsActive({ ...EXP_FOG, mode: 'exp2' })).toBe(true);
    expect(fogIsActive(EXP_FOG)).toBe(true);
  });

  it.each([
    ['color', { color: [-0.1, 0.2, 0.3] }],
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
          mode: 'exp',
          near: 0,
          far: 100,
          ...override,
        },
      ],
      suns: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'environment-selection-invalid') throw result.error;
    expect(result.error.detail.field).toContain(field);
    expect(result.error.expected).toContain('finite');
    expect(result.error.hint).toContain(field);
  });

  it('rejects a second Fog owner without choosing a first-hit winner', () => {
    const result = selectEnvironment({
      environments: [],
      fogs: [
        { ...EXP_FOG, entityKey: 2, color: [0.2, 0.3, 0.4], density: 0.01 },
        { ...EXP_FOG, entityKey: 3, color: [0.4, 0.3, 0.2], density: 0.02 },
      ],
      suns: [],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'fog-cardinality', detail: { count: 2 } },
    });
  });
});
