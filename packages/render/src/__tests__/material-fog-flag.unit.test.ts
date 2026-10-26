import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { prepareBatchExecution } from '../gpu-driven/batch-execution';
import { matchesRecordMode } from '../record/material-pass-selection';
import { type MaterialSnapshot, pipelineRenderState } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';

const opaque: MaterialSnapshot = {
  baseColor: vec3.create(1, 1, 1),
  metallic: 0,
  roughness: 0.5,
  passes: [],
};
const unfogged: MaterialSnapshot = { ...opaque, renderState: { fog: false } };

describe('MaterialRenderState.fog', () => {
  it('survives pipeline render-state projection (fog:false)', () => {
    expect(pipelineRenderState({ fog: false })).toEqual({ fog: false });
  });
  it('is absent when unauthored', () => {
    expect(pipelineRenderState({})).toBeUndefined();
  });
});

describe('surfaceEmissionOnly', () => {
  it('is exported by surface_v1 with the emission-only contract', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../../shader/src/surface_v1.wgsl', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(
      /fn surfaceEmissionOnly\(input : SurfaceInput, emissive : vec3<f32>, opacity : f32\)/,
    );
    expect(src).toContain(
      'SurfaceData(vec3<f32>(0.0), input.viewDirectionWS, 0.0, 1.0, emissive, 0.0, opacity, 0.0)',
    );
  });
});

describe('opaque fog:false (Three Material.fog on opaque draws)', () => {
  it('splits the opaque queue into fogged and unfogged record modes', () => {
    expect(matchesRecordMode(opaque, 'opaque')).toBe(true);
    expect(matchesRecordMode(unfogged, 'opaque')).toBe(true);
    expect(matchesRecordMode(opaque, 'opaque-fogged')).toBe(true);
    expect(matchesRecordMode(unfogged, 'opaque-fogged')).toBe(false);
    expect(matchesRecordMode(opaque, 'opaque-unfogged')).toBe(false);
    expect(matchesRecordMode(unfogged, 'opaque-unfogged')).toBe(true);
    const blended = { ...unfogged, transparent: true };
    expect(matchesRecordMode(blended, 'opaque-unfogged')).toBe(false);
  });

  it('keeps fog:false opaque draws on the direct route, never in an indirect batch', () => {
    const resolve = () => {
      throw new Error('a direct route resolves no scene-index artifact');
    };
    const pass = {
      kind: 'forward' as const,
      shaderId: 'forgeax::default-standard-pbr',
      renderState: { fog: false },
    };
    const geometry = {
      receipt: { identity: 'box', vertexInputs: [], topology: 'triangle-list', indexed: true },
      draw: { kind: 'indexed', first: 0, count: 36, baseVertex: 0, topology: 'triangle-list' },
      deformation: 'rigid',
    } as const;
    expect(prepareBatchExecution(geometry, unfogged, pass, resolve).unwrap().route).toBe('direct');
  });

  it('counts fog:false opaque materials as graph demand', () => {
    const material = (snapshot: MaterialSnapshot) =>
      ({ snapshot }) as unknown as Parameters<MaterialFrame['with']>[0];
    expect(new MaterialFrame(undefined).with(material(opaque)).hasUnfoggedOpaque).toBe(false);
    expect(new MaterialFrame(undefined).with(material(unfogged)).hasUnfoggedOpaque).toBe(true);
  });
});
