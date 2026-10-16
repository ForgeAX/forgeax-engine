import { World } from '@forgeax/engine-ecs';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { bench, describe } from 'vitest';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../src/record/main-pass-material';
import type { MaterialSnapshot } from '../src/render-system-extract';

// Measure the actual CPU material binding builder with fixed physical resources.
// GPU execution is deliberately outside this benchmark; these are not FPS.
describe('2000 draw material bindings / 32 materials / Worker-cloned records', () => {
  const resource = () => ({});
  const deps = {
    runtime: {
      device: {
        caps: { storageBuffer: false },
        limits: { maxSampledTexturesPerShaderStage: 16 },
        createBindGroup: () => ({ ok: true, value: resource() }),
      },
    },
    pipelineState: {
      materialBindGroupLayout: resource(),
      materialUniformBuffer: { buffer: resource() },
      meshStorageBuffer: { buffer: resource() },
      defaultSampler: resource(),
      defaultWhiteTextureView: resource(),
      defaultNormalTextureView: resource(),
      fallbackTextureView: resource(),
      defaultAnisotropyTextureView: resource(),
    },
    world: new World(),
    store: { materialResourceEpoch: 0 },
    materialSlice: 256,
    videoHighPerfAvailable: false,
    skylightResources: {
      irradianceView: resource(), irradianceSampler: resource(),
      prefilterView: resource(), prefilterSampler: resource(),
      brdfLutView: resource(), intensityBuffer: resource(),
    },
    materialBgShared: new Map(),
    materialBgAssemblyCache: new Map(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {},
  } as unknown as PerSubmeshMaterialBgDeps;
  const rows = Array.from({ length: 2000 }, (_, index) => ({
    materialHandle: index % 32,
    materialShaderId: 'forgeax::default-standard-pbr',
    materialParamSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
    paramSnapshot: { roughness: 0.5 },
  } as unknown as MaterialSnapshot));
  const frames = [structuredClone(rows), structuredClone(rows)];
  let frame = 0;
  bench('unchanged binding resources', () => {
    const materials = frames[frame++ % frames.length];
    if (materials === undefined) throw new Error('missing frame');
    for (let index = 0; index < materials.length; index++) {
      const material = materials[index];
      if (material !== undefined) buildPerSubmeshMaterialBg(deps, material, index);
    }
  }, { time: 1500, warmupTime: 500, iterations: 40 });
});
