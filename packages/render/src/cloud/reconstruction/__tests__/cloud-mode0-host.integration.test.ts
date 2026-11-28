import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { abortFeatureFrame, prepareFeatureFrame } from '../../../__tests__/feature-frame-driver';
import { fixtureCamera } from '../../../__tests__/standard-light-cap-fixture';
import { withBuiltinRenderFeatures } from '../../../features/builtins';
import { createRenderFeatureHost } from '../../../features/host';
import { renderFeatureSourceContext } from '../../../features/source';
import type { ExtractedFrame } from '../../../render-system-extract';
import { resolveFeatureTargets } from '../../../render-system-record-attempt';
import { cloudIdentity } from '../../authoring/identity';
import { CLOUD_REFERENCE_TEXTURE_ROLES } from '../../contracts';
import type { ExtractedProgramCloudLayer } from '../../extract';
import { viewCloudShadowProjection } from '../../lighting/shadow';

it.each([
  'local',
  'published',
] as const)('plans per-camera Beer map writers from %s source captures when shadows become available', async (delivery) => {
  const feature = withBuiltinRenderFeatures([]).find(
    (entry) => entry.identity === 'forgeax.cloud-layer',
  );
  if (feature === undefined) throw new Error('Missing cloud builtin');
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderFeatureHost([feature]).unwrap();
  const world = new World();
  const cameras = [fixtureCamera(0), fixtureCamera(20000)].map((camera, index) => ({
    ...camera,
    entityKey: index + 1,
  }));
  const sun = {
    direction: new Float32Array([0, -1, 0]),
    intensity: 20000,
    color: new Float32Array([20000, 10000, 5000]),
  };
  const settings = {
    directionToLight: [0, 1, 0] as const,
    extentMeters: 160000,
    depthMeters: 160000,
    lightDistanceMeters: 80000,
    resolution: 64,
    mapSamples: 16,
    mode: 1,
    cast: false,
    biasMeters: 0,
    strength: 1,
    surfaceStrength: 1,
  };
  const cloud: ExtractedProgramCloudLayer = {
    status: 'program',
    bottomMeters: 5000,
    thicknessMeters: 10000,
    entryLimitMeters: 350000,
    traceLimitMeters: 200000,
    materialGuid: 'test-cloud',
    cookIdentity: 'test-cook',
    programIdentity: cloudIdentity({ program: 'source-captured-program' }),
    rendererSource: '//null-rhi-program',
    materialParameters: new Float32Array(0),
    windOffsetMeters: [0, 0, 0],
    viewSampleCountScale: 1,
    stopTransmittance: 0.005,
    diagnostic: [3, 0, 0],
  };
  try {
    for (const shadows of [false, true]) {
      const frameNumber = shadows ? 2 : 1;
      const layer = shadows ? { ...cloud, shadowSettings: settings } : cloud;
      const frame = { cameras, cloudLayer: layer, lights: { directional: sun } } as ExtractedFrame;
      const context = renderFeatureSourceContext(world, frame, frameNumber, { caps: device.caps });
      const sourceFeatures = host.captureSource({ ...context, caps: device.caps });
      expect(context.views.map((view) => view.frame?.cloudLayer?.shadowMap)).toEqual(
        shadows
          ? cameras.map((camera) => viewCloudShadowProjection(settings, camera.position))
          : [undefined, undefined],
      );
      if (shadows) expect(context.views.map((view) => view.frame?.cloudSun)).toEqual([sun, sun]);
      expect(layer.shadowMap).toBeUndefined();
      const batch = prepareFeatureFrame(
        host,
        context.views.map((view) => ({
          identity: view.identity,
          render: true,
          world,
          frameNumber,
          generation: 0,
          caps: device.caps,
          frameSize: { width: 33, height: 19 },
          targets: resolveFeatureTargets(
            { device },
            { colorAttachmentFormat: 'rgba16float' },
            { tonemap: 'aces-filmic', antialias: 'none' },
            view.frame?.cloudLayer,
          ),
          frame: { cloudLayer: layer },
          ...(delivery === 'local'
            ? { sourceFeatures }
            : {
                publishedFeatures: sourceFeatures.map(({ identity, result }) => ({
                  identity,
                  data: structuredClone(result.unwrap()),
                })),
              }),
          getFeatureShaderSource: () => '//null-rhi-source',
        })),
      );
      expect(batch.frame.errors).toEqual([]);
      for (const view of context.views) {
        const plans = batch.views.get(view.identity)?.plans;
        expect(plans).toHaveLength(1);
        const names = plans?.flatMap(({ plan }) => plan.passes.map((pass) => pass.name));
        expect(names).toContain('cloud-sampled-trace');
        expect(names?.includes('cloud-layer-shadow')).toBe(shadows);
        expect(names?.includes('cloud-layer-shadow-filter')).toBe(shadows);
      }
      abortFeatureFrame(host);
    }
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});

it('prepares the real builtin Mode0 resource namespace with shadow and every reconstruction stage', async () => {
  const feature = withBuiltinRenderFeatures([]).find(
    (entry) => entry.identity === 'forgeax.cloud-layer',
  );
  if (feature === undefined) throw new Error('Missing cloud builtin');
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const host = createRenderFeatureHost([feature]).unwrap();
  const world = new World();
  const targetsFor = (cloud: Parameters<typeof resolveFeatureTargets>[3]) =>
    resolveFeatureTargets(
      { device },
      { colorAttachmentFormat: 'rgba16float' },
      { tonemap: 'aces-filmic', antialias: 'none' },
      cloud,
    );
  const layer = {
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
    shadowMap: {
      directionToLight: [0, 1, 0] as const,
      origin: [0, 30000, 0] as const,
      right: [1, 0, 0] as const,
      up: [0, 0, 1] as const,
      extentMeters: 40000,
      depthMeters: 60000,
      resolution: 128,
      mapSamples: 64,
      mode: 1 as const,
      cast: false,
      biasMeters: 0,
      strength: 1,
      surfaceStrength: 1,
    },
  };
  try {
    const program = {
      ...layer,
      status: 'program' as const,
      materialGuid: 'test-cloud',
      cookIdentity: 'test-cook',
      programIdentity: cloudIdentity({ program: 'test-program' }),
      rendererSource: '//null-rhi-program',
      materialParameters: new Float32Array(0),
      windOffsetMeters: [0, 0, 0] as const,
      viewSampleCountScale: 1,
      stopTransmittance: 0.005,
      diagnostic: [3, 0, 0] as const,
    };
    const batch = prepareFeatureFrame(host, [
      {
        identity: 'camera',
        render: true,
        world,
        frameNumber: 1,
        generation: 0,
        caps: device.caps,
        frameSize: { width: 33, height: 19 },
        targets: targetsFor(program),
        frame: { cloudLayer: program },
        getFeatureShaderSource: () => '//null-rhi-source',
      },
    ]);
    expect(batch.frame.errors).toEqual([]);
    const plans = batch.views.get('camera')?.plans ?? [];
    expect(plans).toHaveLength(1);
    const programName = `cloud-program-trace-${program.programIdentity.slice('sha256:'.length)}`;
    expect(plans[0]?.plan.resources.map((resource) => resource.name)).toEqual(
      expect.arrayContaining([programName, `${programName}-shadow`]),
    );
    const names = plans[0]?.plan.passes.map((pass) => pass.name);
    expect(names).not.toContain('cloud-mode0-probe');
    const display = plans[0]?.plan.resources.find(
      (resource) =>
        resource.kind === 'fullscreen-program' && resource.name === 'cloud-layer-resolve',
    );
    if (display?.kind !== 'fullscreen-program' || !display.params)
      throw new Error('Missing display parameters');
    expect(display.params.byteSize).toBe(128);
    const displayParams = new Float32Array(display.params.defaultValue.buffer);
    expect(displayParams[24]).toBe(3);
    expect(Array.from(displayParams.slice(28))).toEqual([5000, 10000, 350000, 200000]);
    expect(names).toEqual(
      expect.arrayContaining([
        'cloud-layer-shadow',
        'cloud-sampled-trace',
        'cloud-layer-transport',
        'cloud-layer-resolve',
      ]),
    );
    const sampled = {
      ...program,
      status: 'sampled' as const,
      lightEnvironment: {
        atmosphereAvailable: true,
        skyLuminance: [0, 0, 0] as const,
        skySource: 'atmosphere' as const,
      },
      kernelIdentity: '0'.repeat(64),
      textures: CLOUD_REFERENCE_TEXTURE_ROLES.map(([role, dimension], index) => ({
        role,
        dimension,
        guid: role,
        handle: (index + 1) as AssetHandle<'texture'>,
        revision: 1,
      })),
      layoutScaleMeters: 256000,
      coverageBias: -2,
      extinctionPerMeter: 0,
      albedo: [1, 1, 1, 1] as const,
      weights: [1, 1, 1, 1, 1] as const,
      useDetail: false,
      skipEmpty: true,
      diagnostic: [2, 2, 2] as const,
    };
    const probed = prepareFeatureFrame(host, [
      {
        identity: 'camera',
        render: true,
        world,
        frameNumber: 2,
        generation: 0,
        caps: device.caps,
        frameSize: { width: 33, height: 19 },
        targets: targetsFor(sampled),
        frame: { cloudLayer: sampled },
        getFeatureShaderSource: () => '//null-rhi-source',
      },
    ]);
    expect(probed.frame.errors).toEqual([]);
    const probePlan = probed.views.get('camera')?.plans[0]?.plan;
    expect(probePlan?.passes.some((pass) => pass.name === 'cloud-mode0-probe')).toBe(true);
    for (const name of ['cloud-sampled-trace', 'cloud-mode0-probe']) {
      const pass = probePlan?.passes.find((candidate) => candidate.name === name);
      expect(pass?.kind === 'raster' && pass.sampledTargets).toEqual(
        expect.arrayContaining(['cloud-atmosphere-transmittance', 'cloud-atmosphere-distant-sky']),
      );
    }
    expect(probePlan?.submission).toBe('atomic');
    expect(
      probePlan?.resources.some(
        (resource) =>
          resource.kind === 'fullscreen-program' && resource.fragmentEntryPoint === 'fs_probe',
      ),
    ).toBe(true);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});
