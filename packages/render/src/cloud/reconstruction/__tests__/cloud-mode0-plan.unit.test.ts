import { expect, it } from 'vitest';
import { earthAtmosphere } from '../../../__tests__/atmosphere-fixture';
import { selectEnvironment } from '../../../environment/frame';
import type { AtmosphereParameters } from '../../../extract/environment';
import { withBuiltinRenderFeatures } from '../../../features/builtins';
import type { RenderFeaturePlanContext } from '../../../features/plan';
import type { RenderFeatureExtractView } from '../../../features/types';
import { createSceneDataCatalog } from '../../../temporal/scene-data-catalog';
import type { ExtractedAnalyticCloudLayer } from '../../extract';
import type { CloudLayerInspection } from '../../inspection';
import type { CookedCloudShadow } from '../../lighting/shadow';
import type { createMode0CloudFeature } from '../feature';
import { createCloudFeatureFrameContext } from '../frame-context';

function fixture() {
  const feature = withBuiltinRenderFeatures([]).find(
    (entry) => entry.identity === 'forgeax.cloud-layer',
  ) as ReturnType<typeof createMode0CloudFeature>;
  if (feature === undefined) throw new Error('Missing production cloud builtin');
  const layer: ExtractedAnalyticCloudLayer = {
    status: 'analytic' as const,
    bottomMeters: 5000,
    thicknessMeters: 10000,
    entryLimitMeters: 350000,
    traceLimitMeters: 200000,
    sample: {
      extinctionPerMeter: 0.001,
      albedo: [1, 1, 1] as const,
      emissivePerMeter: [0, 0, 0] as const,
      materialAO: 1,
    },
  };
  const context: RenderFeaturePlanContext = {
    caps: {
      rgba16floatRenderable: true,
      backendKind: 'webgpu',
      compute: true,
      storageBuffer: true,
    } as never,
    generation: 1,
    frame: { frameNumber: 1 },
    getFeatureShaderSource: () => '// shader',
    views: [
      {
        identity: 'camera',
        render: true,
        frame: { frameNumber: 1, width: 1919, height: 1079 },
        targets: [
          { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
          { name: 'depth', kind: 'depth', format: 'depth32float', sampleCount: 1 },
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
  const data = (shadowMap?: CookedCloudShadow) => ({
    layers: { camera: shadowMap ? { ...layer, shadowMap } : layer },
    views: context.views.map(({ identity, render }) => ({
      identity,
      render,
    })) as readonly RenderFeatureExtractView[],
    inspection: {} as Record<string, CloudLayerInspection>,
  });
  const params = (value: ReturnType<typeof data>) => {
    const plan = feature.plan(value, context);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw plan.error;
    const resource = plan.value.work
      .flatMap((work) => work.resources ?? [])
      .find(
        (resource) =>
          resource.kind === 'fullscreen-program' && resource.name === 'cloud-layer-transport',
      );
    if (resource?.kind !== 'fullscreen-program' || resource.params === undefined)
      throw new Error('Missing reconstruction params');
    return Array.from(new Float32Array(resource.params.defaultValue.buffer));
  };
  return { feature, data, params, context };
}

it('stages phase and history only after all real resolve work is submitted', () => {
  const { feature, data, params } = fixture();
  const first = data();
  expect(params(first).slice(16, 21)).toEqual([0, 0, 1919, 1079, 0]);
  feature.onFrameSubmitted?.(first, {
    works: [
      {
        scope: { view: 'camera' },
        passes: ['cloud-analytic-trace', 'cloud-layer-transport', 'cloud-layer-resolve'].map(
          (name) => ({
            name,
            graphics: { draws: [{ kind: 'draw' }] },
          }),
        ),
      },
    ],
  });
  expect(first.inspection.camera?.status).toBe('available');
  const next = data();
  expect(params(next).slice(16, 21)).toEqual([0, 1, 1919, 1079, 1]);
  feature.onFrameAborted?.(next);
  expect(params(data()).slice(16, 21)).toEqual([0, 1, 1919, 1079, 1]);
});

it('invalidates aerial history on selected medium and range edits but retains it during sun motion', () => {
  const { feature, data, params } = fixture();
  const frame = (atmosphere: AtmosphereParameters, far: number, sunX = 0, fogDensity = 0) => {
    const next = data();
    const environment = selectEnvironment({
      environments: [{ kind: 'atmosphere', entityKey: 1, sourceKey: 'air', atmosphere }],
      fogs:
        fogDensity === 0
          ? []
          : [
              {
                entityKey: 3,
                color: [0.1, 0.2, 0.3],
                density: fogDensity,
                heightFalloff: 0.01,
                maxOpacity: 1,
                skyOpacity: 1,
                mode: 'exp',
                near: 0,
                far: 10000,
              },
            ],
      suns: [{ entityKey: 2, direction: [sunX, -1, 0], color: [1, 1, 1], intensity: 120000 }],
    }).unwrap();
    next.views = [
      {
        identity: 'camera',
        render: true,
        selectedCamera: { far } as never,
        frame: createCloudFeatureFrameContext(next.layers.camera, undefined, environment),
      },
    ];
    return next;
  };
  const first = frame(earthAtmosphere, 25000);
  params(first);
  feature.onFrameSubmitted?.(first, {
    works: [
      {
        scope: { view: 'camera' },
        passes: ['cloud-analytic-trace', 'cloud-layer-transport', 'cloud-layer-resolve'].map(
          (name) => ({ name, graphics: { draws: [{ kind: 'draw' }] } }),
        ),
      },
    ],
  });
  expect(params(frame(earthAtmosphere, 25000, 0.001))[20]).toBe(1);
  for (const next of [
    frame({ ...earthAtmosphere, mieScattering: earthAtmosphere.mieScattering * 2 }, 25000),
    frame({ ...earthAtmosphere, aerialPerspectiveStart: 1000 }, 25000),
    frame({ ...earthAtmosphere, aerialPerspectiveDistanceScale: 2 }, 25000),
    frame(earthAtmosphere, 50000),
    frame(earthAtmosphere, 25000, 0, 0.001),
  ])
    expect(params(next)[20]).toBe(0);
});

it('retains submitted history and advances the production phase under continuous solar motion', () => {
  const { feature, data, params } = fixture();
  const map: CookedCloudShadow = {
    directionToLight: [0, 1, 0],
    origin: [0, 30000, 0],
    right: [1, 0, 0],
    up: [0, 0, 1],
    extentMeters: 40000,
    depthMeters: 60000,
    resolution: 128,
    mapSamples: 64,
    mode: 1,
    cast: true,
    biasMeters: 0,
    strength: 1,
    surfaceStrength: 1,
  };
  const first = data(map);
  first.layers.camera = {
    ...first.layers.camera,
    shadowSettings: map,
  };
  params(first);
  feature.onFrameSubmitted?.(first, {
    works: [
      {
        scope: { view: 'camera' },
        passes: ['cloud-analytic-trace', 'cloud-layer-transport', 'cloud-layer-resolve'].map(
          (name) => ({ name, graphics: { draws: [{ kind: 'draw' }] } }),
        ),
      },
    ],
  });
  const moving = data({
    ...map,
    directionToLight: [0.001, 0.9999995, 0],
    origin: [10, 29999, 0],
    depthMeters: 60001,
  });
  moving.layers.camera = {
    ...moving.layers.camera,
    shadowSettings: { ...map, directionToLight: [0.001, 0.9999995, 0] },
  };
  expect(params(moving).slice(16, 21)).toEqual([0, 1, 1919, 1079, 1]);
  expect(moving.inspection.camera?.mode0?.resetReasons).toEqual([]);
  expect(moving.inspection.camera?.capability.compute).toBe(true);
});

it('does not accept a declared plan or an omitted reconstruction draw as history', () => {
  const { feature, data, params } = fixture();
  const first = data();
  params(first);
  feature.onFrameSubmitted?.(first, {
    works: [
      {
        scope: { view: 'camera' },
        passes: [{ name: 'cloud-layer-resolve', graphics: { draws: [{ kind: 'draw' }] } }],
      },
    ],
  });
  expect(params(data()).slice(16, 21)).toEqual([0, 0, 1919, 1079, 0]);
});

it.each([
  0, 1,
])('uses the effective solar spectrum for mode %i at ground night with sunlit high clouds', (mode) => {
  const { feature, data, params } = fixture();
  const frame = (rgb: readonly [number, number, number]) => {
    const next = data();
    next.layers.camera = {
      ...next.layers.camera,
      lightEnvironment: {
        atmosphereAvailable: true,
        skySource: 'atmosphere',
        skyLuminance: [0, 0, 0],
        groundSolarTransmittance: [0, 0, 0],
      },
      lighting: {
        atmosphereTransmittanceMode: mode,
        phase: [0.8, 0, 0],
        multipleScattering: [0.5, 0.5, 0.5, 1],
        shadow: [1, 16, 15000],
      },
    };
    next.views = [
      {
        identity: 'camera',
        render: true,
        frame: {
          cloudSun: {
            direction: [-0.9986295, 0.052336, 0],
            intensity: rgb[0],
            color: rgb,
          } as never,
        },
      },
    ];
    return next;
  };
  const first = frame([120000, 120000, 120000]);
  params(first);
  feature.onFrameSubmitted?.(first, {
    works: [
      {
        scope: { view: 'camera' },
        passes: ['cloud-analytic-trace', 'cloud-layer-transport', 'cloud-layer-resolve'].map(
          (name) => ({ name, graphics: { draws: [{ kind: 'draw' }] } }),
        ),
      },
    ],
  });
  for (const rgb of [
    [60000, 60000, 60000],
    [120000, 30000, 120000],
  ] as const) {
    const next = frame(rgb);
    expect(params(next)[20]).toBe(mode === 1 ? 0 : 1);
    expect(next.inspection.camera?.mode0?.resetReasons).toEqual(
      mode === 1 ? ['lighting-changed'] : [],
    );
  }
});
