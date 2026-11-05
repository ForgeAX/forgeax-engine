import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { describe, expect, it, vi } from 'vitest';
import {
  createGeometryPipelineRequests,
  type GeometryPipelineRequestContext,
  type PipelineRequestRuntime,
} from '../geometry-pipeline-requests';
import type { MaterialShaderPipelineEntry } from '../render-context';

describe('main-pass material pipeline cache', () => {
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
});
