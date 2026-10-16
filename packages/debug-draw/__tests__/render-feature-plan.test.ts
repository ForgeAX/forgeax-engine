import { describe, expect, it } from 'vitest';
import { freezeRenderFeaturePlan } from '../../render/src/features/plan';
import { createDebugDrawRenderFeaturePlan } from '../src/render-feature';

describe('debug draw RenderFeature plan', () => {
  it('shares line vertices while each view owns its projection and target', () => {
    const projections = [new Float32Array(16).fill(1), new Float32Array(16).fill(2)];
    const plan = createDebugDrawRenderFeaturePlan({
      vertexCapacity: 32, vertexCount: 6,
      views: projections.map((viewProjection, index) => ({ identity: `view-${index}`, target: 'scene-color', colorFormat: 'rgba16float', viewProjection })),
    });
    const shared = plan.work[0];
    if (shared === undefined) throw new Error('shared vertices missing');
    expect(shared.scope).toBe('frame');
    expect(shared.resources.map((resource) => resource.kind)).toEqual(['buffer', 'vertex-data']);
    expect(plan.work).toHaveLength(3);
    for (const [index, view] of plan.work.slice(1).entries()) {
      expect(view.scope).toEqual({ view: `view-${index}` });
      const validated = freezeRenderFeaturePlan('debug-draw', { resources: [...shared.resources, ...view.resources], passes: view.passes }, [
        { name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      ]);
      expect(validated.ok).toBe(true);
      const binding = view.resources.find((resource) => resource.kind === 'graphics-bindings');
      expect(binding).toMatchObject({ values: { viewProjection: projections[index] } });
      expect(view.passes[0]).toMatchObject({ kind: 'raster', draws: [{ vertexData: [{ resource: 'debug-draw.vertex-data' }], draw: { kind: 'draw', vertexCount: 6 } }] });
    }
  });
  it('allocates no resources for empty geometry or a missing view roster', () => {
    expect(createDebugDrawRenderFeaturePlan({ vertexCapacity: 32, views: [] })).toEqual({ work: [] });
    expect(createDebugDrawRenderFeaturePlan({ vertexCapacity: 32, vertexCount: 0, views: [{ identity: 'main', target: 'scene-color', viewProjection: new Float32Array(16) }] })).toEqual({ work: [] });
  });
});
