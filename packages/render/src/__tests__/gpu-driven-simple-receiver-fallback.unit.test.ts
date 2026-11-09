import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import {
  createRasterPipelines,
  type RasterPipelineShape,
} from '../gpu-driven/production-raster-classes';

it('draws the general directional receiver while the simple scene-index receiver builds', () => {
  const general = { label: 'general' };
  const simple = { label: 'simple' };
  let simpleReady = false;
  const pipeline = vi.fn((...args: unknown[]) => {
    const artifact = args[7] as MaterialShaderArtifact;
    if (!artifact.variantSet?.includes('DIRECTIONAL_SHADOW_SIMPLE=true')) return ok(general);
    return simpleReady
      ? ok(simple)
      : err(new RhiError({ code: 'rhi-not-available', expected: 'built', hint: 'retry' }));
  });
  // The adapter is opaque here: only the selected artifact matters.
  const shape = {
    raster: { pipeline },
    prepared: { mesh: { layoutProjection: {} }, batch: { key: { topology: 'triangle-list' } } },
    artifact: {
      material: 'forgeax::default-standard-pbr',
      variantSet: 'DIRECTIONAL_SHADOW_SIMPLE=false+LEAN_LIGHTING=false',
    },
    deformation: 'rigid',
    format: 'rgba8unorm',
    sampleCount: 1,
    rendererRecording: true,
    shaderUvSetCount: 1,
    stripIndexFormat: undefined,
    standardSurfaceDiscards: 0,
    layoutProjection: undefined,
    topology: undefined,
    renderState: undefined,
    standardTextureMask: undefined,
    preparationFactory: undefined,
    visibleSurface: false,
    directionalShadowSimple: true,
  } as unknown as RasterPipelineShape;
  const { pipelineFor } = createRasterPipelines(shape);
  // A frame that just turned simple (e.g. the light stopped casting) is not held.
  const first = pipelineFor(['rgba8unorm']);
  expect(first.ok && first.value).toBe(general);
  const selected = pipeline.mock.calls.map(
    (call) => (call[7] as MaterialShaderArtifact).variantSet,
  );
  expect(selected).toEqual([
    'DIRECTIONAL_SHADOW_SIMPLE=true+LEAN_LIGHTING=true',
    'DIRECTIONAL_SHADOW_SIMPLE=false+LEAN_LIGHTING=false',
  ]);
  // The fallback is not retained; the simple receiver takes over once built.
  simpleReady = true;
  const second = pipelineFor(['rgba8unorm']);
  expect(second.ok && second.value).toBe(simple);
  const third = pipelineFor(['rgba8unorm']);
  expect(third.ok && third.value).toBe(simple);
  expect(pipeline).toHaveBeenCalledTimes(3);
});
