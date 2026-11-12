import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { err, ok, type RenderPipeline, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import type { MaterialShaderPipelineEntry } from '../../record/render-context';
import { gpuLanePreparesAsynchronously } from '../batch-execution';
import {
  createRasterPipelines,
  type ProjectedRasterPipelines,
  type RasterPipelineShape,
} from '../production-raster-classes';
import type { MaterialAbiRasterAdapter } from '../production-raster-material';

function fixture() {
  const ready = { pipeline: {} as RenderPipeline } as MaterialShaderPipelineEntry;
  const get = vi.fn(() => ready);
  const prepare = vi.fn(() => null);
  const pipeline: MaterialAbiRasterAdapter['pipeline'] = (...args) => {
    const factory = args[11] ?? get;
    const entry = factory('test::raster', false);
    return entry === null
      ? err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'pipeline preparation completes',
            hint: 'retry the scene snapshot',
          }),
        )
      : ok(entry.pipeline);
  };
  const layoutProjection = deriveVertexLayoutProjection({ position: new Float32Array(9) });
  const shape = {
    raster: { pipeline },
    artifact: { material: 'test::raster' },
    prepared: { mesh: { layoutProjection }, batch: { key: { topology: 'triangle-list' } } },
    deformation: 'rigid',
    format: 'rgba16float',
    sampleCount: 1,
    rendererRecording: true,
    shaderUvSetCount: 0,
    layoutProjection,
    topology: 'triangle-list',
    preparationFactory: prepare,
  } as unknown as RasterPipelineShape;
  return { pipelines: createRasterPipelines(shape), get, prepare };
}

it.each([
  'pipelineFor',
  'opaquePipelineFor',
  'gbufferPipelineFor',
  'aoInputPipelineFor',
  'temporalPipelineFor',
  'coveragePipelineFor',
] satisfies (keyof ProjectedRasterPipelines)[])('keeps %s encoding synchronous until explicit preparation', (name) => {
  const f = fixture();
  const selected = f.pipelines[name];
  if (selected === undefined) throw new Error('Required raster entry is unavailable');
  expect(selected(['rgba16float']).ok).toBe(true);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.get).toHaveBeenCalledTimes(1);
  const pending = fixture();
  expect(pending.pipelines[name]?.(['rgba16float'], undefined, true).ok).toBe(false);
  expect(pending.prepare).toHaveBeenCalledTimes(1);
  expect(pending.get).not.toHaveBeenCalled();
});

it('prepares builtin Unlit before encoding instead of starting asynchronous work in capture', () => {
  expect(
    gpuLanePreparesAsynchronously({ material: 'forgeax::default-unlit' } as MaterialShaderArtifact),
  ).toBe(true);
  expect(
    gpuLanePreparesAsynchronously({ material: 'test::custom' } as MaterialShaderArtifact),
  ).toBe(false);
});
