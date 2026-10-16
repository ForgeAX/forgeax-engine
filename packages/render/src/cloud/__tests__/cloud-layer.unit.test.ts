import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { CloudLayer, CloudQualityValue } from '../../components/cloud-layer';
import { DirectionalLight } from '../../components/directional-light';
import { freezeRenderFeaturePlan } from '../../features/plan';
import { createSceneDataCatalog } from '../../temporal/scene-data-catalog';
import {
  buildCloudDensityCache,
  evaluateCloudDensity,
  reconstructCloudDensityCache,
  sampleCloudDensity,
  snapshotCloudDensityCache,
} from '../density';
import { extractCloudLayer } from '../extract';
import {
  CLOUD_LAYER_FEATURE_IDENTITY,
  CLOUD_RESOLVE_FULLSCREEN_WGSL,
  CLOUD_TRANSPORT_FULLSCREEN_WGSL,
  createCloudLayerFeature,
} from '../feature';
import {
  applyCloudSolarTransmittance,
  integrateCloudCameraPath,
  integrateCloudInterior,
  integrateCloudSolarColumn,
} from '../optics';
import { validateCloudLayer } from '../parameters';
import { inspectCloudLayerResources } from '../resources';
import { createCloudShadowProjection, sampleCloudShadow } from '../shadow';
import { cloudTemporalResetReasons, createCloudHistory, reprojectCloudHistory } from '../temporal';

function params() {
  const result = validateCloudLayer({
    seed: 42,
    baseHeight: 10,
    thickness: 20,
    scale: 0.02,
    coverage: 0.35,
    density: 1.5,
    wind: [3, 0, -1],
    quality: 'low',
    shadowRange: 100,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('CloudLayer authoring and deterministic field', () => {
  it('publishes a closed schema and validates its source facts', () => {
    expect(CloudLayer.name).toBe('CloudLayer');
    expect(CloudLayer.fields).toMatchObject({
      seed: { type: 'u32', default: 1337 },
      baseHeight: { type: 'f32', default: 120 },
      thickness: { type: 'f32', default: 80 },
      scale: { type: 'f32', default: 0.004 },
      coverage: { type: 'f32', default: 0.48 },
      density: { type: 'f32', default: 1 },
      wind: { type: 'array<f32, 3>' },
      quality: { type: 'f32', default: CloudQualityValue.medium },
      shadowRange: { type: 'f32', default: 512 },
    });
    const invalid = validateCloudLayer({ coverage: 2 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('cloud-layer-invalid-parameter');
  });

  it('admitted a scene placement plan with a depth-bounded HDR composite', () => {
    const world = new World();
    world
      .spawn({ component: CloudLayer, data: { ...params(), quality: CloudQualityValue.low } })
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0.3, -0.9, 0.2], color: [1, 0.9, 0.8], intensity: 2 },
      })
      .unwrap();
    const feature = createCloudLayerFeature();
    const frameCloud = extractCloudLayer(world);
    if (!frameCloud.ok) throw frameCloud.error;
    if (frameCloud.value === undefined) throw new Error('cloud frame was not extracted');
    const extracted = feature.extract({
      worlds: [world],
      owner: 0,
      frameNumber: 1,
      caps: { compute: true, storageBuffer: true, rgba16floatRenderable: true } as never,
      views: [
        {
          identity: 'test-view',
          render: true,
          frame: {
            cloudLayer: frameCloud.value,
            view: {
              identity: 'test-view',
              width: 64,
              height: 32,
              cameraRevision: 0,
              deviceGeneration: 0,
              cameraPosition: [0, 3, 0],
            },
          },
        },
      ],
    });
    if (!extracted.ok) throw extracted.error;
    expect(extracted.ok).toBe(true);
    expect(extracted.value.views['test-view']?.params?.seed).toBe(42);
    expect(extracted.value.views['test-view']?.sunRadiance?.[0]).toBeCloseTo(2);
    expect(extracted.value.views['test-view']?.sunRadiance?.[1]).toBeCloseTo(1.8);
    expect(extracted.value.views['test-view']?.sunRadiance?.[2]).toBeCloseTo(1.6);
    const planned = feature.plan(extracted.value, {
      caps: {
        compute: true,
        storageBuffer: true,
        rgba16floatRenderable: true,
      } as never,
      frame: { frameNumber: 1 },
      generation: 1,
      views: [
        {
          identity: 'test-view',
          render: true,
          frame: { frameNumber: 1 },
          targets: [
            { name: 'motion-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
            { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
            { name: 'depth', kind: 'depth', format: 'depth24plus-stencil8', sampleCount: 1 },
            { name: 'cloud-shadow', kind: 'color', format: 'rgba16float', sampleCount: 1 },
            {
              name: 'cloud-history-radiance-previous',
              kind: 'color',
              format: 'rgba16float',
              sampleCount: 1,
            },
            {
              name: 'cloud-history-radiance-current',
              kind: 'color',
              format: 'rgba16float',
              sampleCount: 1,
            },
            {
              name: 'cloud-history-transmittance-previous',
              kind: 'color',
              format: 'rgba16float',
              sampleCount: 1,
            },
            {
              name: 'cloud-history-transmittance-current',
              kind: 'color',
              format: 'rgba16float',
              sampleCount: 1,
            },
            {
              name: 'cloud-history-depth-previous',
              kind: 'color',
              format: 'rgba16float',
              sampleCount: 1,
            },
            {
              name: 'cloud-history-depth-current',
              kind: 'color',
              format: 'rgba16float',
              sampleCount: 1,
            },
          ],
          sceneData: createSceneDataCatalog({
            featureIdentity: CLOUD_LAYER_FEATURE_IDENTITY,
            generation: 1,
            planIdentity: `${CLOUD_LAYER_FEATURE_IDENTITY}:1`,
            rgba16floatRenderable: true,
          }),
        },
      ],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw planned.error;
    const frozen = freezeRenderFeaturePlan(
      CLOUD_LAYER_FEATURE_IDENTITY,
      {
        resources: planned.value.work.flatMap((work) => work.resources),
        passes: planned.value.work.flatMap((work) => work.passes),
      },
      [
        { name: 'motion-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
        { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
        { name: 'depth', kind: 'depth', format: 'depth24plus-stencil8', sampleCount: 1 },
        { name: 'cloud-shadow', kind: 'color', format: 'rgba16float', sampleCount: 1 },
        {
          name: 'cloud-history-radiance-previous',
          kind: 'color',
          format: 'rgba16float',
          sampleCount: 1,
        },
        {
          name: 'cloud-history-radiance-current',
          kind: 'color',
          format: 'rgba16float',
          sampleCount: 1,
        },
        {
          name: 'cloud-history-transmittance-previous',
          kind: 'color',
          format: 'rgba16float',
          sampleCount: 1,
        },
        {
          name: 'cloud-history-transmittance-current',
          kind: 'color',
          format: 'rgba16float',
          sampleCount: 1,
        },
        {
          name: 'cloud-history-depth-previous',
          kind: 'color',
          format: 'rgba16float',
          sampleCount: 1,
        },
        {
          name: 'cloud-history-depth-current',
          kind: 'color',
          format: 'rgba16float',
          sampleCount: 1,
        },
      ],
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) throw frozen.error;
    expect(feature.placement).toBe('scene');
    expect(feature.shaderModuleMode).toBe('immediate');
    expect(frozen.value.passes.map((pass) => pass.name)).toContain('cloud-layer-transport');
    expect(frozen.value.passes.map((pass) => pass.name)).toContain('cloud-layer-resolve');
    expect(frozen.value.passes.map((pass) => pass.name)).toContain('cloud-layer-shadow');
    const shadowPass = frozen.value.passes.find(
      (pass) => pass.kind === 'raster' && pass.name === 'cloud-layer-shadow',
    );
    expect(shadowPass?.kind).toBe('raster');
    if (shadowPass?.kind === 'raster') {
      // The light-space shadow branch reconstructs its receiver from the
      // snapped projection and never samples scene depth. Keeping depth out
      // of the graph reads avoids an artificial read-before-main dependency.
      expect(shadowPass.sampledTargets).not.toContain('depth');
    }
    const fullscreen = frozen.value.resources.find(
      (resource) => resource.kind === 'fullscreen-program',
    );
    expect(fullscreen?.kind).toBe('fullscreen-program');
    if (fullscreen?.kind === 'fullscreen-program') {
      expect(fullscreen.reads).toEqual([
        'motion-input',
        'cloud-history-radiance-previous',
        'cloud-history-transmittance-previous',
        'cloud-history-depth-previous',
        { key: 'depth', sampleType: 'depth' },
      ]);
      expect(fullscreen.params?.byteSize).toBe(176);
      expect(fullscreen.storageBindings).toEqual([8]);
      expect(fullscreen.usesView).toBe(true);
    }
    const shadowFullscreen = frozen.value.resources.find(
      (resource) =>
        resource.kind === 'fullscreen-program' && resource.name === 'cloud-layer-shadow',
    );
    expect(shadowFullscreen?.kind).toBe('fullscreen-program');
    if (shadowFullscreen?.kind === 'fullscreen-program') {
      expect(shadowFullscreen.params?.byteSize).toBe(176);
    }
    const transportFullscreen = frozen.value.resources.find(
      (resource) =>
        resource.kind === 'fullscreen-program' && resource.name === 'cloud-layer-transport',
    );
    expect(transportFullscreen?.kind).toBe('fullscreen-program');
    if (transportFullscreen?.kind === 'fullscreen-program') {
      expect(transportFullscreen.fragmentEntryPoint).toBe('fs_transport');
      expect(transportFullscreen.params?.byteSize).toBe(176);
      expect(transportFullscreen.storageBindings).toEqual([8]);
      expect(transportFullscreen.reads).toEqual([
        'motion-input',
        'cloud-shadow',
        { key: 'depth', sampleType: 'depth' },
      ]);
    }
    const resolveFullscreen = frozen.value.resources.find(
      (resource) =>
        resource.kind === 'fullscreen-program' && resource.name === 'cloud-layer-resolve',
    );
    expect(resolveFullscreen?.kind).toBe('fullscreen-program');
    if (resolveFullscreen?.kind === 'fullscreen-program') {
      expect(resolveFullscreen.reads).toEqual([
        'motion-input',
        'cloud-history-radiance-current',
        'cloud-history-transmittance-current',
        'cloud-history-depth-current',
        'cloud-history-radiance-previous',
        'cloud-history-transmittance-previous',
        'cloud-history-depth-previous',
        { key: 'depth', sampleType: 'depth' },
      ]);
    }
    const transportPass = frozen.value.passes.find(
      (pass) => pass.kind === 'raster' && pass.name === 'cloud-layer-transport',
    );
    expect(transportPass?.kind).toBe('raster');
    if (transportPass?.kind === 'raster') {
      expect(transportPass.colorAttachments).toHaveLength(3);
    }
  });

  it('is deterministic, periodic and reconstructible from the cache snapshot', () => {
    const source = params();
    const first = buildCloudDensityCache(source);
    const second = buildCloudDensityCache(source);
    expect(first.digest).toBe(second.digest);
    expect([...first.data]).toEqual([...second.data]);
    expect(first.formationData.byteLength).toBe(first.data.byteLength * 3);
    expect(first.byteLength).toBe(first.formationData.byteLength);
    expect([...first.formationData]).toEqual([...second.formationData]);
    const evaluationOnly = validateCloudLayer({
      ...source,
      coverage: 0.72,
      density: 0.55,
      wind: [11, 0, -4],
    });
    expect(evaluationOnly.ok).toBe(true);
    if (!evaluationOnly.ok) throw evaluationOnly.error;
    const evaluationCache = buildCloudDensityCache(evaluationOnly.value);
    expect(evaluationCache.sourceKey).toBe(first.sourceKey);
    expect(evaluationCache.digest).toBe(first.digest);
    expect([...evaluationCache.formationData]).toEqual([...first.formationData]);
    const snapshot = snapshotCloudDensityCache(first);
    const restored = reconstructCloudDensityCache(source, snapshot);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw restored.error;
    expect(restored.value.digest).toBe(first.digest);
    expect(sampleCloudDensity(first, source, [0, 20, 0])).toBeCloseTo(
      sampleCloudDensity(first, source, [1 / source.scale, 20, 0]),
      2,
    );
    expect(evaluateCloudDensity(source, [0, 0, 0]).density).toBe(0);
  });

  it('samples the authored field at cache texel centers without a half-cell shift', () => {
    const source = { ...params(), coverage: 0.8 };
    const cache = buildCloudDensityCache(source);
    let maxError = 0;
    let shiftedError = 0;
    for (let z = 0; z < cache.resolution; z += 3) {
      for (let y = 1; y < cache.resolution - 1; y += 3) {
        const x = (z * 7 + y * 3) % cache.resolution;
        const point: [number, number, number] = [
          (x + 0.5) / cache.resolution / source.scale,
          source.baseHeight + ((y + 0.5) / cache.resolution) * source.thickness,
          (z + 0.5) / cache.resolution / source.scale,
        ];
        maxError = Math.max(
          maxError,
          Math.abs(
            sampleCloudDensity(cache, source, point) - evaluateCloudDensity(source, point).density,
          ),
        );
        const shifted = [
          point[0] + 0.5 / cache.resolution / source.scale,
          point[1] + (0.5 / cache.resolution) * source.thickness,
          point[2] + 0.5 / cache.resolution / source.scale,
        ];
        shiftedError = Math.max(
          shiftedError,
          Math.abs(
            sampleCloudDensity(cache, source, shifted) -
              evaluateCloudDensity(source, point).density,
          ),
        );
      }
    }
    // Three R8 bases are quantized before a nonlinear coverage/height remap.
    // Compare normalized extinction, rather than making the tolerance depend
    // on the authored density multiplier. The explicit half-cell falsifier
    // preserves the addressing regression independently of the noise seed.
    expect(maxError / source.density).toBeLessThan(0.015);
    expect(shiftedError / source.density).toBeGreaterThan(0.05);
  });

  it('increases occupied density monotonically with authored coverage', () => {
    const base = params();
    let totalLow = 0;
    let totalHigh = 0;
    for (let z = 0; z < 12; z++) {
      for (let x = 0; x < 12; x++) {
        const position = [
          x / 12 / base.scale,
          base.baseHeight + base.thickness * 0.5,
          z / 12 / base.scale,
        ];
        const low = evaluateCloudDensity({ ...base, coverage: 0.3 }, position).density;
        const high = evaluateCloudDensity({ ...base, coverage: 0.8 }, position).density;
        expect(high).toBeGreaterThanOrEqual(low);
        totalLow += low;
        totalHigh += high;
      }
    }
    expect(totalHigh).toBeGreaterThan(totalLow + 1);
  });

  it('advects the cached formation when vertical wind is authored', () => {
    const movingResult = validateCloudLayer({ ...params(), wind: [0, 10, 0] });
    expect(movingResult.ok).toBe(true);
    if (!movingResult.ok) throw movingResult.error;
    const moving = movingResult.value;
    const cache = buildCloudDensityCache(moving);
    let analyticDelta = 0;
    let cachedDelta = 0;
    for (let x = 0; x < 16; x += 1) {
      for (let y = 1; y < 8; y += 1) {
        const position = [x * 37, moving.baseHeight + (moving.thickness * y) / 8, 71];
        analyticDelta = Math.max(
          analyticDelta,
          Math.abs(
            evaluateCloudDensity(moving, position, 7).density -
              evaluateCloudDensity(moving, position, 0).density,
          ),
        );
        cachedDelta = Math.max(
          cachedDelta,
          Math.abs(
            sampleCloudDensity(cache, moving, position, 7) -
              sampleCloudDensity(cache, moving, position, 0),
          ),
        );
      }
    }
    expect(analyticDelta).toBeGreaterThan(0.1);
    expect(cachedDelta).toBeGreaterThan(0.1);

    let longAnalyticDelta = 0;
    let longCachedDelta = 0;
    for (let x = 0; x < 16; x += 1) {
      for (let y = 1; y < 8; y += 1) {
        const position = [x * 37, moving.baseHeight + (moving.thickness * y) / 8, 71];
        longAnalyticDelta = Math.max(
          longAnalyticDelta,
          Math.abs(
            evaluateCloudDensity(moving, position, 107).density -
              evaluateCloudDensity(moving, position, 100).density,
          ),
        );
        longCachedDelta = Math.max(
          longCachedDelta,
          Math.abs(
            sampleCloudDensity(cache, moving, position, 107) -
              sampleCloudDensity(cache, moving, position, 100),
          ),
        );
      }
    }
    expect(longAnalyticDelta).toBeGreaterThan(0.1);
    expect(longCachedDelta).toBeGreaterThan(0.1);

    let analyticSeamDelta = 0;
    let cachedSeamDelta = 0;
    for (let x = 0; x < 16; x += 1) {
      for (let y = 1; y < 8; y += 1) {
        const position = [x * 37, moving.baseHeight + (moving.thickness * y) / 8, 71];
        analyticSeamDelta = Math.max(
          analyticSeamDelta,
          Math.abs(
            evaluateCloudDensity(moving, position, 5.00001).density -
              evaluateCloudDensity(moving, position, 4.99999).density,
          ),
        );
        cachedSeamDelta = Math.max(
          cachedSeamDelta,
          Math.abs(
            sampleCloudDensity(cache, moving, position, 5.00001) -
              sampleCloudDensity(cache, moving, position, 4.99999),
          ),
        );
      }
    }
    expect(analyticSeamDelta).toBeLessThan(0.01);
    expect(cachedSeamDelta).toBeLessThan(0.01);
  });

  it('keeps the production transport and resolve contracts explicit', () => {
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('fs_transport');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('cloud_solar_cached_transmittance');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('@location(2) depth');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('cachedShadow.g');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('cachedShadow.b');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain(
      'let occupiedMin = min(firstHeight, lastHeight)',
    );
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('abs(sunDirection.y) > 0.2');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('let directionBudget = select(');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('let residualSteps = min(directionBudget');
    expect(CLOUD_TRANSPORT_FULLSCREEN_WGSL).toContain('cloud_density(samplePosition)');
    expect(CLOUD_RESOLVE_FULLSCREEN_WGSL).toContain('textureLoad(sceneDepth');
    expect(CLOUD_RESOLVE_FULLSCREEN_WGSL).toContain('currentRadiance');
    expect(CLOUD_RESOLVE_FULLSCREEN_WGSL).toContain('foregroundAccepted');
    expect(CLOUD_RESOLVE_FULLSCREEN_WGSL).toContain('if (!currentValid || !foregroundAccepted)');
    expect(CLOUD_RESOLVE_FULLSCREEN_WGSL).toContain('let minTransport');
  });
});

describe('CloudLayer optical ownership', () => {
  it('keeps camera, solar-column and interior paths distinct', () => {
    const source = params();
    const cache = buildCloudDensityCache(source);
    const camera = integrateCloudCameraPath(
      source,
      { origin: [0, 0, 0], direction: [0, 1, 0], maxDistance: 100 },
      { cache, steps: 8 },
    );
    const column = integrateCloudSolarColumn(source, [0, 15, 0], [0.4, 1, 0.2], {
      cache,
      steps: 8,
      maxDistance: 100,
    });
    const interior = integrateCloudInterior(
      source,
      { origin: [0, 15, 0], direction: [0, 1, 0], maxDistance: 100 },
      { sunRadiance: [2, 2, 2], sunDirection: [0.4, 1, 0.2] },
      { cache, steps: 8 },
    );
    expect(camera.path).toBe('camera');
    expect(column.path).toBe('solar-column');
    expect(interior.path).toBe('cloud-interior');
    expect(camera.transmittance).toBeGreaterThanOrEqual(0);
    expect(camera.transmittance).toBeLessThanOrEqual(1);
    expect(interior.scattering[0]).toBeGreaterThanOrEqual(0);
    expect(applyCloudSolarTransmittance([2, 3, 4], 0.5)).toEqual([1, 1.5, 2]);
  });

  it('projects stable world-space shadows and exposes low-sun fallback', () => {
    const source = params();
    const projection = createCloudShadowProjection({
      center: [0, 0, 0],
      sunDirection: [0.3, 0.9, 0.2],
      range: 100,
      resolution: 128,
    });
    const same = createCloudShadowProjection({
      center: [0, 0, 0],
      sunDirection: [0.3, 0.9, 0.2],
      range: 100,
      resolution: 128,
    });
    expect(projection.revision).toBe(same.revision);
    const shadow = sampleCloudShadow(source, projection, [0, 15, 0]);
    expect(shadow.revision).toBe(projection.revision);
    const lowSun = createCloudShadowProjection({
      center: [0, 0, 0],
      sunDirection: [1, 0.01, 0],
      range: 100,
    });
    expect(sampleCloudShadow(source, lowSun, [0, 15, 0]).fallback).toBe('low-sun');
  });
});

describe('CloudLayer temporal history', () => {
  const signature = {
    sourceKey: 'cloud-layer-v1:42',
    viewId: 'main',
    authoringGeneration: 1,
    cloudShadowRevision: 2,
    cameraRevision: 3,
    deviceGeneration: 4,
    width: 64,
    height: 32,
    timeSeconds: 1,
    quality: 'medium' as const,
  };

  it('resets on source, resize, camera, recovery and time discontinuity', () => {
    expect(cloudTemporalResetReasons(undefined, signature)).toEqual(['history-missing']);
    expect(cloudTemporalResetReasons(signature, { ...signature, sourceKey: 'changed' })).toContain(
      'authoring-generation',
    );
    expect(cloudTemporalResetReasons(signature, { ...signature, width: 128 })).toContain('resize');
    expect(cloudTemporalResetReasons(signature, { ...signature, timeSeconds: 2 })).toContain(
      'time-discontinuity',
    );
    expect(cloudTemporalResetReasons(signature, signature, { cameraCut: true })).toContain(
      'camera-cut',
    );
    expect(cloudTemporalResetReasons(signature, signature, { recovery: true })).toContain(
      'recovery',
    );
  });

  it('rejects disoccluded history and accepts bounded motion reprojection', () => {
    const history = createCloudHistory(signature, 1, true);
    expect(history.width).toBe(64);
    expect(history.height).toBe(32);
    const accepted = reprojectCloudHistory({
      currentDepth: 10,
      historyDepth: 10.1,
      motion: [1, 0],
      currentPixel: [20, 10],
      historySize: [64, 32],
    });
    expect(accepted.accepted).toBe(true);
    const rejected = reprojectCloudHistory({
      currentDepth: 10,
      historyDepth: 20,
      motion: [0, 0],
      currentPixel: [20, 10],
      historySize: [64, 32],
    });
    expect(rejected.reason).toBe('depth-disocclusion');
  });
});

describe('CloudLayer resource evidence', () => {
  it('separates descriptor declarations from measured GPU residency', () => {
    const source = params();
    const cache = buildCloudDensityCache(source);
    const shadow = createCloudShadowProjection({
      center: [0, 0, 0],
      sunDirection: [0.3, 0.9, 0.2],
      range: 100,
      resolution: 128,
    });
    const history = createCloudHistory(
      {
        sourceKey: 'cloud-layer-v1:42',
        viewId: 'main',
        authoringGeneration: 1,
        cloudShadowRevision: shadow.revision,
        cameraRevision: 0,
        deviceGeneration: 0,
        width: 64,
        height: 32,
        timeSeconds: 0,
        quality: 'low',
      },
      1,
    );
    const declared = inspectCloudLayerResources({ generation: 1, cache, shadow, history });
    expect(declared.gpuEvidence).toBe('declared');
    expect(declared.shadowBytes).toBe(0);
    expect(declared.historyBytes).toBe(0);
    expect(declared.declaredShadowBytes).toBe(128 * 128 * 8);
    expect(declared.declaredHistoryBytes).toBe(32 * 16 * 6 * 8);
    const odd = inspectCloudLayerResources({
      generation: 1,
      history: { ...history, width: 65, height: 33 },
    });
    expect(odd.declaredHistoryBytes).toBe(33 * 17 * 6 * 8);
    const measured = inspectCloudLayerResources({
      generation: 1,
      cache,
      shadow,
      history,
      shadowBytes: declared.declaredShadowBytes,
      historyBytes: declared.declaredHistoryBytes,
      inFlightBytes: 4096,
    });
    expect(measured.gpuEvidence).toBe('measured');
    expect(measured.residentBytes).toBe(
      cache.byteLength + declared.declaredShadowBytes + declared.declaredHistoryBytes,
    );
    expect(measured.inFlightBytes).toBe(4096);
  });
});
