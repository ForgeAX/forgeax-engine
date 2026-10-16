import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { admitSsrSpatial, type SsrSpatialAdmission } from '../ssr/admission';
import { addSsrSpatialPasses } from '../ssr/graph';

type Frame = { readonly encoder: RhiCommandEncoder };

function blockedAdmission(): SsrSpatialAdmission {
  return admitSsrSpatial({
    camera: {
      projection: 'perspective',
      near: 0.1,
      far: 100,
      screenSpaceReflection: { maxDistance: 40, thickness: 0.2, maxRoughness: 0.6 },
    },
    environment: {
      lane: 'deferred',
      m0: { status: 'fallback-only' },
      sceneInputs: true,
      temporal: true,
      reflectionFallback: true,
      capabilities: {
        compute: true,
        storageTexture: true,
        rgba16floatRenderable: true,
        r32floatSampledStorage: true,
      },
    },
  });
}

describe('SSR zero-work contract', () => {
  it('does not create targets, history, bindings, or passes when admission is blocked', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const result = addSsrSpatialPasses(graph, {
      admission: blockedAdmission(),
      width: 5,
      height: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { enabled: false, passNames: [], resources: undefined },
    });
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 5, height: 3 } }).unwrap();
    expect(compiled.inspect().passes).toEqual([]);
    expect(compiled.inspect().resources).toEqual([]);
    expect(compiled.inspect().passes.some((pass) => pass.name.startsWith('ssr-'))).toBe(false);
    await compiled.retire();
  });

  it('does not simulate SSR work for a direct lane even when its other inputs are ready', () => {
    const admission = admitSsrSpatial({
      camera: {
        projection: 'perspective',
        near: 0.1,
        far: 100,
        screenSpaceReflection: { maxDistance: 40, thickness: 0.2, maxRoughness: 0.6 },
      },
      environment: {
        lane: 'direct',
        m0: { status: 'admitted' },
        sceneInputs: true,
        temporal: true,
        reflectionFallback: true,
        capabilities: {
          compute: true,
          storageTexture: true,
          rgba16floatRenderable: true,
          r32floatSampledStorage: true,
        },
      },
    });
    expect(admission.status).toBe('fallback-only');
    expect(admission.work).toEqual({
      attachmentCount: 0,
      passCount: 0,
      bindingCount: 0,
      resourceCount: 0,
      historyCount: 0,
      temporalDemand: 0,
    });
  });
});
