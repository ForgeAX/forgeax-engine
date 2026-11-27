import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import {
  createRasterPipelines,
  type RasterPipelineShape,
} from '../gpu-driven/production-raster-classes';

function receiverFixture(leanLighting: boolean, simpleReceiver = true) {
  const general = { label: 'general' };
  const simple = { label: 'simple' };
  let simpleReady = false;
  const pipeline = vi.fn((...args: unknown[]) => {
    const artifact = args[7] as MaterialShaderArtifact;
    if (artifact.variantSet === 'DIRECTIONAL_SHADOW_SIMPLE=false+LEAN_LIGHTING=false')
      return ok(general);
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
      program: { entryPoints: [] },
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
    directionalShadowSimple: simpleReceiver,
    leanLighting,
  } as unknown as RasterPipelineShape;
  const { pipelineFor } = createRasterPipelines(shape);
  return {
    general,
    simple,
    pipeline,
    pipelineFor,
    complete: () => {
      simpleReady = true;
    },
  };
}

it.each([
  { simpleReceiver: true, leanLighting: false },
  { simpleReceiver: true, leanLighting: true },
  { simpleReceiver: false, leanLighting: true },
])('preserves receiver=$simpleReceiver and lean=$leanLighting while the native PSO builds', ({
  simpleReceiver,
  leanLighting,
}) => {
  const { general, simple, pipeline, pipelineFor, complete } = receiverFixture(
    leanLighting,
    simpleReceiver,
  );
  // A frame that just turned simple (e.g. the light stopped casting) is not held.
  const first = pipelineFor(['rgba8unorm']);
  expect(first.ok && first.value).toBe(general);
  const selected = pipeline.mock.calls.map(
    (call) => (call[7] as MaterialShaderArtifact).variantSet,
  );
  expect(selected).toEqual([
    `DIRECTIONAL_SHADOW_SIMPLE=${simpleReceiver}+LEAN_LIGHTING=${leanLighting}`,
    'DIRECTIONAL_SHADOW_SIMPLE=false+LEAN_LIGHTING=false',
  ]);
  // The fallback is not retained; the simple receiver takes over once built.
  complete();
  const second = pipelineFor(['rgba8unorm']);
  expect(second.ok && second.value).toBe(simple);
  const third = pipelineFor(['rgba8unorm']);
  expect(third.ok && third.value).toBe(simple);
  expect(pipeline).toHaveBeenCalledTimes(3);
});

it.each([
  false,
  true,
])('requires selected PSO completion for private lean=%s preparation', (lean) => {
  const { general, simple, pipelineFor, complete } = receiverFixture(lean);
  expect(pipelineFor(['rgba8unorm'], undefined, true).ok).toBe(false);
  const ordinary = pipelineFor(['rgba8unorm']);
  expect(ordinary.ok && ordinary.value).toBe(general);
  expect(pipelineFor(['rgba8unorm'], undefined, true).ok).toBe(false);
  complete();
  const prepared = pipelineFor(['rgba8unorm'], undefined, true);
  expect(prepared.ok && prepared.value).toBe(simple);
  const displayed = pipelineFor(['rgba8unorm']);
  expect(displayed.ok && displayed.value).toBe(simple);
});
