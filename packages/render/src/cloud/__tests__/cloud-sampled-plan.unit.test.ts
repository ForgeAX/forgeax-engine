import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderFeaturePlanContext } from '../../features/plan';
import { createSceneDataCatalog } from '../../temporal/scene-data-catalog';
import { createAnalyticCloudFeature, encodeProgram, encodeSampled } from '../analytic-feature';
import { CLOUD_REFERENCE_TEXTURE_ROLES } from '../contracts';
import type { ExtractedSampledCloudLayer } from '../extract';
import { createMode0CloudFeature } from '../reconstruction/feature';
import { CLOUD_MODE0_BLUE_NOISE } from '../tracing/blue-noise';

const layer: ExtractedSampledCloudLayer = {
  status: 'sampled',
  bottomMeters: 5000,
  thicknessMeters: 10_000,
  entryLimitMeters: 350_000,
  traceLimitMeters: 200_000,
  materialGuid: 'sampled',
  cookIdentity: 'fixture',
  kernelIdentity: '0'.repeat(64),
  programIdentity: `sha256:${'1'.repeat(64)}`,
  textures: CLOUD_REFERENCE_TEXTURE_ROLES.map(([role, dimension], i) => ({
    role,
    dimension,
    guid: role,
    handle: (i + 1) as AssetHandle<'texture'>,
    revision: 1,
  })),
  layoutScaleMeters: 256_000,
  coverageBias: -0.2,
  extinctionPerMeter: 0.001,
  albedo: [1, 1, 1, 1],
  weights: [1, 1, 1, 1, 1],
  windOffsetMeters: [0, 0, 0],
  useDetail: true,
  skipEmpty: true,
  viewSampleCountScale: 1,
  stopTransmittance: 0.005,
  diagnostic: [0, 0, 0],
};

function fixture(getFeatureShaderSource: RenderFeaturePlanContext['getFeatureShaderSource']) {
  const feature = createAnalyticCloudFeature();
  const context: RenderFeaturePlanContext = {
    caps: { rgba16floatRenderable: true, backendKind: 'webgpu' } as never,
    frame: { frameNumber: 1 },
    generation: 1,
    getFeatureShaderSource,
    views: [
      {
        identity: 'camera',
        render: true,
        frame: { frameNumber: 1 },
        targets: [
          { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
          { name: 'depth', kind: 'depth', format: 'depth32float-stencil8', sampleCount: 1 },
          { name: 'cloud-shadow-raw', kind: 'color', format: 'rg11b10ufloat', sampleCount: 1 },
          { name: 'cloud-shadow', kind: 'color', format: 'rg11b10ufloat', sampleCount: 1 },
        ],
        sceneData: createSceneDataCatalog({
          featureIdentity: feature.identity,
          generation: 1,
          planIdentity: 'camera',
          rgba16floatRenderable: true,
        }),
      },
    ],
  };
  return { feature, context };
}

it('fails a missing sampled kernel/static variant rather than asking for a uniform shader', () => {
  const resolve = vi.fn((id: string) =>
    id === 'forgeax::cloud-analytic-view' ? '// uniform exists' : undefined,
  );
  const { feature, context } = fixture(resolve);
  expect(feature.plan({ camera: layer }, context)).toMatchObject({
    ok: false,
    error: { code: 'cloud-layer-resource-failed' },
  });
  expect(resolve.mock.calls).toEqual([[`forgeax::cloud-sampled-view-${layer.kernelIdentity}-1`]]);
});

it('rejects a missing published texture role before selecting any cloud shader', () => {
  const resolve = vi.fn(() => '// sampled exists');
  const { feature, context } = fixture(resolve);
  expect(
    feature.plan({ camera: { ...layer, textures: layer.textures.slice(0, 3) } }, context),
  ).toMatchObject({ ok: false, error: { code: 'cloud-layer-resource-failed' } });
  expect(resolve).not.toHaveBeenCalled();
});

it('carries adopted optical settings in the exact production and Mode0 parameter ABI', () => {
  const bytes = encodeSampled({
    ...layer,
    lightEnvironment: {
      atmosphereAvailable: true,
      skyLuminance: [0, 0, 0],
      skySource: 'atmosphere',
      groundSolarTransmittance: [0.5, 0.25, 0.125],
    },
    lighting: {
      phase: [0.6, -0.3, 0.2],
      multipleScattering: [0.7, 0.4, 0.1, 1],
      shadow: [0, 16, 2000],
    },
  });
  expect(bytes.byteLength).toBe(304);
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, 76);
  expect(Array.from(values.slice(28, 31))).toEqual(Array.from(new Float32Array([0.6, -0.3, 0.2])));
  expect(Array.from(values.slice(36, 40))).toEqual([0, 16, 2000, 0]);
  expect(Array.from(values.slice(40, 44))).toEqual([0, 0, 1, 1]);
  expect(Array.from(values.slice(72, 76))).toEqual([0.5, 0.25, 0.125, 0]);
});

it('produces BSM before opaque without reading scene targets and keeps it for internal shadow with cast off', () => {
  const { feature, context } = fixture(() => '// source');
  const result = feature.plan(
    {
      camera: {
        ...layer,
        shadowMap: {
          directionToLight: [0, 1, 0],
          origin: [0, 30000, 0],
          right: [1, 0, 0],
          up: [0, 0, 1],
          extentMeters: 40000,
          depthMeters: 60000,
          resolution: 128,
          mapSamples: 64,
          mode: 1,
          cast: false,
          biasMeters: 0,
          strength: 1,
          surfaceStrength: 1,
        },
      },
    },
    context,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  const work = result.value.work?.[0];
  expect(work?.passes[0]?.name).toBe('cloud-layer-shadow');
  expect(work?.passes[0]).not.toHaveProperty('sampledTargets');
  const bindings = work?.resources.find((resource) => resource.name === 'cloud-bsm-inputs');
  expect(bindings).toMatchObject({
    kind: 'graphics-bindings',
    values: { input: false, depthFallback: true },
  });
  expect(bindings).not.toHaveProperty('logicalTargets');
  expect(work?.resources.find((resource) => resource.name === 'cloud-bsm-pipeline')).toMatchObject({
    program: { colorFormats: ['rg11b10ufloat'] },
  });
  const filter = result.value.work?.[1];
  expect(filter?.resources.find((resource) => resource.kind === 'graphics-program')).toMatchObject({
    program: { colorFormats: ['rg11b10ufloat'] },
  });
  expect(filter?.passes[0]).toMatchObject({
    name: 'cloud-layer-shadow-filter',
    sampledTargets: ['cloud-shadow-raw'],
    colorAttachments: [{ target: 'cloud-shadow', loadOp: 'clear', storeOp: 'store' }],
  });
  const trace = result.value.work?.[2]?.resources.find(
    (resource) => resource.name === 'analytic-cloud-inputs',
  );
  expect(trace).toMatchObject({ values: { additionalTextures: ['cloud-shadow', false, false] } });
});

it.each([
  'sampled',
  'program',
] as const)('traces %s clouds without consuming a shadow map that has no producer', (status) => {
  const { feature, context } = fixture(() => '// source');
  const cloud =
    status === 'sampled'
      ? layer
      : {
          ...layer,
          status: 'program' as const,
          rendererSource: '// admitted source',
          materialParameters: new Float32Array(4),
        };
  const plan = feature.plan({ camera: cloud }, context).unwrap();
  const work = plan.work[0];
  expect(work?.passes.find((pass) => pass.name === 'cloud-sampled-trace')).toMatchObject({
    kind: 'raster',
    sampledTargets: ['motion-input', 'depth'],
  });
  expect(
    work?.resources.find((resource) => resource.name === 'analytic-cloud-inputs'),
  ).toMatchObject({
    values: { additionalTextures: [false, false, false] },
  });
  const shader = work?.resources.find((resource) => resource.kind === 'fullscreen-program');
  expect(shader?.kind === 'fullscreen-program' && shader.reads).toContainEqual({
    key: 'unused-cloud-shadow',
    sampleType: 'unfilterable-float',
  });
  expect(plan.work.flatMap((work) => work.passes.map((pass) => pass.name))).not.toContain(
    'cloud-layer-shadow',
  );
});

it.each([
  'sampled',
  'program',
] as const)('switches the %s UE trace between a stable blue noise slice and midpoint sampling', (status) => {
  const { context: base } = fixture(() => '// cooked shader');
  const feature = createMode0CloudFeature();
  const cloud =
    status === 'sampled'
      ? layer
      : {
          ...layer,
          status: 'program' as const,
          rendererSource: '// cooked shader',
          materialParameters: new Float32Array(4),
        };
  for (const [frameNumber, viewBlueNoise] of [
    [1, true],
    [2, true],
    [6, false],
    [8, false],
    [31, true],
  ] as const) {
    const context: RenderFeaturePlanContext = {
      ...base,
      frame: { frameNumber },
      views: base.views.map((view) => ({
        ...view,
        frame: { frameNumber, width: 1280, height: 720 },
        targets: [
          ...view.targets,
          {
            name: 'cloud-mode0-trace-depth',
            kind: 'color',
            format: 'rgba16float',
            sampleCount: 1,
          },
        ],
      })),
    };
    const frame = {
      layers: { camera: { ...cloud, viewBlueNoise } },
      inspection: {},
      views: [{ identity: 'camera', render: true }],
    };
    const plan = feature.plan(frame, context).unwrap();
    const reconstruction = plan.work
      .flatMap((work) => work.resources)
      .find((resource) => resource.name === 'cloud-layer-transport');
    if (reconstruction?.kind !== 'fullscreen-program' || reconstruction.params === undefined)
      throw new Error('Missing reconstruction params');
    const historyValid = new Float32Array(reconstruction.params.defaultValue.buffer)[20];
    expect(historyValid).toBe(frameNumber === 2 || frameNumber === 8 ? 1 : 0);
    const trace = plan.work.find((work) =>
      work.passes.some((pass) => pass.name === 'cloud-sampled-trace'),
    );
    const program = trace?.resources.find((resource) => resource.kind === 'fullscreen-program');
    expect(program).toMatchObject({
      kind: 'fullscreen-program',
      fragmentEntryPoint: 'fs_trace_mode_zero_ue',
    });
    if (program?.kind !== 'fullscreen-program' || program.params === undefined)
      throw new Error('Missing trace params');
    expect(program.reads).toContain(CLOUD_MODE0_BLUE_NOISE);
    expect(
      trace?.resources.find((resource) => resource.name === 'analytic-cloud-inputs'),
    ).toMatchObject({
      values: { additionalTextures: expect.arrayContaining([CLOUD_MODE0_BLUE_NOISE]) },
    });
    const params = new Float32Array(program.params.defaultValue.buffer);
    expect(params[status === 'sampled' ? 27 : 59]).toBe(viewBlueNoise ? 1 : -1);
    feature.onFrameSubmitted?.(frame, {
      works: [
        {
          scope: { view: 'camera' },
          passes: ['cloud-sampled-trace', 'cloud-layer-transport', 'cloud-layer-resolve'].map(
            (name) => ({ name, graphics: { draws: [{ kind: 'draw' }] } }),
          ),
        },
      ],
    });
  }
});

it('packs explicit generic extinction adoption and the authored inheritance sentinel', () => {
  const program = {
    status: 'program' as const,
    diagnostic: [0, 0, 0] as const,
    bottomMeters: 5000,
    thicknessMeters: 10000,
    entryLimitMeters: 350000,
    traceLimitMeters: 200000,
    materialGuid: 'material',
    cookIdentity: 'cook',
    programIdentity: 'program',
    rendererSource: '// admitted source',
    materialParameters: new Float32Array(4),
    windOffsetMeters: [0, 0, 0] as const,
    viewSampleCountScale: 1,
    stopTransmittance: 0,
  };
  const inherited = encodeProgram(program);
  expect(new Float32Array(inherited.buffer)[11]).toBe(-1);
  const vacuum = encodeProgram({ ...program, extinctionOverridePerMeter: 0 });
  expect(new Float32Array(vacuum.buffer)[11]).toBe(0);
  const adopted = encodeProgram({ ...program, extinctionOverridePerMeter: 0.002 });
  expect(new Float32Array(adopted.buffer)[11]).toBeCloseTo(0.002, 8);
});
