import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_FXAA,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  ReflectionProbe,
} from '@forgeax/engine-render';
import { renderGraphCompileCount, renderOrderedViewBindCount } from '@forgeax/engine-render-graph';
import { attachRecorder, buildFrameModel, summarizePasses } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';
import { shaderPublicationUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderPublicationUrl(
  await buildEngineShaderTemplateManifest({ hdrpSsao: false }),
);

it.each([
  false,
  true,
])('records one Deferred base draw and one specular draw for an overflowing probe class (Default GBuffer %s)', async (compact) => {
  const recorder = attachRecorder(webgpu).unwrap();
  let surface: GPUTexture | undefined;
  const errors: unknown[] = [];
  const canvas = {
    width: 128,
    height: 64,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        options.device.addEventListener('uncapturederror', (event) =>
          errors.push(event.error.message),
        );
        surface = options.device.createTexture({
          size: [128, 64],
          format: options.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const { renderer } = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const world = new World();
  const mesh = testAssets(world)
    .create(createBoxGeometry(1, 1, 1).unwrap())
    .unwrap();
  const material = testAssets(world)
    .create(Materials.standard({ baseColor: [0.8, 0.5, 0.2, 1], metallic: 0.5, roughness: 0.4 }))
    .unwrap();
  const probes = ([64, 64, 128, 256] as const).map((resolution, index) => {
    const x = (index - 1.5) * 2.4;
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    return world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 1] } },
        { component: ReflectionProbe, data: { resolution, halfExtents: [1.1, 2, 2] } },
      )
      .unwrap();
  });
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 7] } },
      {
        component: Camera,
        data: { fov: Math.PI / 4, aspect: 2, near: 0.1, far: 30, bloom: 0, antialias: 0 },
      },
    )
    .unwrap();
  world
    .spawn({ component: DirectionalLight, data: { direction: [0, 0, -1], intensity: 1 } })
    .unwrap();
  renderValue(
    renderer.setProfile({
      ...renderer.inspect().profile,
      renderPath: 'deferred',
      gpuOcclusion: false,
      ...(compact ? { gbufferFormat: 'default' } : {}),
    }),
  );
  const lease = renderValue(renderer.attach(world));
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    return drawReadyFrame(renderer, { source: lease, geometryLane: 'direct' });
  };
  const captureLighting = async () => {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    const model = buildFrameModel((await capture).unwrap().tape);
    const writesReceiverContext = summarizePasses(model).some(({ colorTargets }) =>
      colorTargets.some(({ label }) => label === 'deferred-surface-context'),
    );
    expect(writesReceiverContext).toBe(
      compact && renderer.inspect().reflectionProbes.activeCount > 0,
    );
    return model.works
      .flatMap((work) => work.pipeline.shaders.map((shader) => shader.entryPoint))
      .filter((entry) => entry.startsWith('fs_standard_deferred'));
  };
  try {
    // Each submitted frame completes at most one capture face or PMREM step.
    // Allow all four probes to publish before observing the lighting lane.
    for (let frame = 0; frame < 160; frame++) {
      await draw();
      if (renderer.inspect().reflectionProbes.activeCount === probes.length) break;
    }
    expect(renderer.inspect().reflectionProbes.activeCount).toBe(probes.length);
    await draw();
    // Change the view's physical stages while the overflow probe lane is active.
    const compile = renderGraphCompileCount();
    const bind = renderOrderedViewBindCount();
    world.set(camera, Camera, { antialias: ANTIALIAS_FXAA }).unwrap();
    expect(await captureLighting()).toEqual([
      compact
        ? 'fs_standard_deferred_compact_reflections_channels_array_dual'
        : 'fs_standard_deferred_reflections_array_dual',
      compact
        ? 'fs_standard_deferred_compact_reflections_overflow'
        : 'fs_standard_deferred_reflections_overflow',
    ]);

    const bindings = renderOrderedViewBindCount() - bind;
    expect(bindings).toBeGreaterThan(0);
    expect(renderGraphCompileCount() - compile).toBe(bindings);

    for (const probe of probes) world.despawn(probe).unwrap();
    await draw();
    expect(await captureLighting()).toEqual([
      compact ? 'fs_standard_deferred_compact' : 'fs_standard_deferred',
    ]);
    expect(renderer.inspect().reflectionProbes.activeCount).toBe(0);
    expect(errors).toEqual([]);
  } catch (cause) {
    throw new Error(
      JSON.stringify({ cause, errors, reflectionProbes: renderer.inspect().reflectionProbes }),
      { cause },
    );
  } finally {
    unsubscribe();
    await renderer.dispose();
    surface?.destroy();
    (await recorder.dispose()).unwrap();
  }
}, 90_000);
