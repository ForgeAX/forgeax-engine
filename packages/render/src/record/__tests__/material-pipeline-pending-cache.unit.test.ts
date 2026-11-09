import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { describe, expect, it, vi } from 'vitest';
import {
  createGeometryPipelineRequests,
  type GeometryPipelineRequestContext,
  type PipelineRequestRuntime,
} from '../geometry-pipeline-requests';
import type { MaterialShaderPipelineEntry } from '../render-context';

describe('main-pass material pipeline cache', () => {
  it.each([
    'forward',
    'deferred',
    'temporal',
  ] as const)('selects the owned preparation path for %s draws', (passKind) => {
    const ready = {} as MaterialShaderPipelineEntry;
    const getter = vi.fn().mockReturnValue(ready);
    const prepare = vi.fn().mockReturnValue(null);
    const requests = createGeometryPipelineRequests(
      {
        runtime: {
          getMaterialShaderPipelineEntry: getter,
          prepareMaterialShaderPipelineEntry: prepare,
        },
      } as unknown as GeometryPipelineRequestContext,
      {
        passKind,
        sampleCount: 1,
        colorFormats: ['rgba8unorm'],
        coverageOnly: false,
        tonemapActive: false,
        msaaActive: false,
        viewBindGroupDynamicOffset: 0,
        transparentDepthWrite: false,
        oit: undefined,
      },
    );
    const entry = requests.resolveMaterialPipeline(
      'test::policy',
      {},
      'triangle-list',
      'uint16',
      undefined,
      undefined,
      deriveVertexLayoutProjection({ position: new Float32Array(9) }),
    );
    if (passKind === 'temporal') {
      expect(entry).toBe(ready);
      expect(getter).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
    } else {
      expect(entry).toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it('keeps transient pending pipelines retryable across a tight frame loop', () => {
    // The resolver treats a resolved entry as opaque; no device or draw state
    // belongs to this lookup-only test.
    const ready = {} as MaterialShaderPipelineEntry;
    const lookup = vi
      .fn<NonNullable<PipelineRequestRuntime['getMaterialShaderPipelineEntry']>>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(ready);
    const context = {
      runtime: { getMaterialShaderPipelineEntry: lookup },
    } as unknown as GeometryPipelineRequestContext;
    const requests = createGeometryPipelineRequests(context, {
      passKind: 'forward',
      sampleCount: 1,
      colorFormats: ['rgba8unorm'],
      coverageOnly: false,
      tonemapActive: false,
      msaaActive: false,
      viewBindGroupDynamicOffset: 0,
      transparentDepthWrite: false,
      oit: undefined,
    });
    const projection = deriveVertexLayoutProjection({ position: new Float32Array(9) });
    const resolve = () =>
      requests.resolveMaterialPipeline(
        'test::pending',
        {},
        'triangle-list',
        'uint16',
        undefined,
        undefined,
        projection,
      );
    expect(resolve()).toBeNull();
    expect(resolve()).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(resolve()).toBe(ready);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(resolve()).toBe(ready);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('draws the general directional receiver while the simple receiver builds', () => {
    const general = { pipeline: {} } as MaterialShaderPipelineEntry;
    const simple = { pipeline: {} } as MaterialShaderPipelineEntry;
    let simpleReady = false;
    const lookup = vi
      .fn<NonNullable<PipelineRequestRuntime['getMaterialShaderPipelineEntry']>>()
      .mockImplementation((...args) =>
        String(args[5]).includes('DIRECTIONAL_SHADOW_SIMPLE=true')
          ? simpleReady
            ? simple
            : null
          : general,
      );
    const context = {
      runtime: { getMaterialShaderPipelineEntry: lookup },
      directionalShadowSimple: true,
    } as unknown as GeometryPipelineRequestContext;
    const requests = createGeometryPipelineRequests(context, {
      passKind: 'forward',
      sampleCount: 1,
      colorFormats: ['rgba8unorm'],
      coverageOnly: false,
      tonemapActive: false,
      msaaActive: false,
      viewBindGroupDynamicOffset: 0,
      transparentDepthWrite: false,
      oit: undefined,
    });
    const projection = deriveVertexLayoutProjection({ position: new Float32Array(9) });
    const resolve = () =>
      requests.resolveMaterialPipeline(
        'forgeax::default-standard-pbr',
        {},
        'triangle-list',
        'uint16',
        undefined,
        undefined,
        projection,
      );
    // A frame that just turned simple (e.g. the light stopped casting) is not held.
    expect(resolve()).toBe(general);
    const requested = lookup.mock.calls.map((call) => String(call[5]));
    expect(requested[0]).toContain('DIRECTIONAL_SHADOW_SIMPLE=true');
    expect(requested[1]).not.toContain('DIRECTIONAL_SHADOW_SIMPLE=true');
    // The fallback is not memoized under the simple key.
    simpleReady = true;
    expect(resolve()).toBe(simple);
    expect(resolve()).toBe(simple);
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
