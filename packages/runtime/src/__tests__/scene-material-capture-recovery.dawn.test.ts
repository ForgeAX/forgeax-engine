import { mkdirSync, writeFileSync } from 'node:fs';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  CameraView,
  CubeCamera,
  Materials,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  ReflectionProbe,
} from '@forgeax/engine-render';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
// Complete a cube round, then admit the actual asynchronously prepared probes.
const minimumCaptureFrames = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 24 : 120;
const historyFrames = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 12 : 60;

it.each([
  0, 2,
])('rebuilds real multi-view, planar, cube intent %i and probe resources after injected loss', {
  timeout: 180_000,
  retry: 0,
}, async (cubeIntent) => {
  const directory = `artifacts/scene-material-scaling/capture-recovery/${cubeIntent === 0 ? 'once' : 'continuous'}`;
  mkdirSync(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  const surfaces: GPUTexture[] = [];
  const nativeErrors: string[] = [];
  let surface: GPUTexture | undefined;
  let loseDevice: (() => void) | undefined;
  const canvas = {
    width: 128,
    height: 64,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        options.device.addEventListener('uncapturederror', (event) =>
          nativeErrors.push(event.error.message),
        );
        surface = options.device.createTexture({
          size: [128, 64],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
        surfaces.push(surface);
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        gpuPassTiming: {},
        // Inject the loss notification through the existing backend seam.
        // Rendering, resource replacement and readback use native Dawn devices.
        rhiInstrumentation: {
          deviceLost: () =>
            new Promise((resolve) => {
              loseDevice = () =>
                resolve({ reason: 'unknown', message: 'capture recovery witness' });
            }),
        },
      },
      { shaderManifestUrl: manifest },
    ),
  );
  const renderer = host.renderer;
  const world = new World();
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(1.6, 1.6, 1).unwrap());
  const descriptor = {
    shape: '2d' as const,
    width: 32,
    height: 32,
    format: 'rgba8unorm' as const,
    mipLevels: 1 as const,
    sampleCount: 1 as const,
    sampled: true,
    readback: true,
  };
  const cameras: EntityHandle[] = [];
  const targets = [-3, 3].map((x, index) => {
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        {
          component: MeshRenderer,
          data: {
            materials: [
              world.allocSharedRef(
                'MaterialAsset',
                Materials.unlit(index === 0 ? [1, 0, 0, 1] : [0, 1, 0, 1]),
              ),
            ],
          },
        },
      )
      .unwrap();
    const target = renderValue(renderer.createRenderTarget(descriptor));
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 4] } },
        {
          component: Camera,
          data: { aspect: 1, fov: Math.PI / 3, near: 0.1, far: 20, antialias: 0, bloom: 0 },
        },
        { component: CameraView, data: { viewport: [index / 2, 0, 0.5, 1], order: index } },
        {
          component: PlanarReflection,
          data: {
            target: world.allocSharedRef('RenderTarget', target),
            normal: [0, 0, 1],
            distance: 1,
          },
        },
      )
      .unwrap();
    cameras.push(camera);
    return target;
  });
  const cube = renderValue(renderer.createRenderTarget({ ...descriptor, shape: 'cube' }));
  const snapshotTarget = renderValue(
    renderer.createRenderTarget({ ...descriptor, width: 16, height: 16, format: 'rgba16float' }),
  );
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 1] } },
      {
        component: CubeCamera,
        data: {
          target: world.allocSharedRef('RenderTarget', cube),
          faceBudget: 2,
          updateIntent: cubeIntent,
        },
      },
    )
    .unwrap();
  for (let index = 0; index < 3; index++) {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1] } },
        {
          component: ReflectionProbe,
          data: { resolution: 64, halfExtents: [10, 10, 10], priority: index },
        },
      )
      .unwrap();
  }
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const resourceWitnesses: unknown[] = [];
  let peakRetiringHistoryBytes = 0;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = renderValue(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    const returned = renderer.inspect();
    peakRetiringHistoryBytes = Math.max(
      peakRetiringHistoryBytes,
      returned.temporal.resources.retiringBytes,
    );
    resourceWitnesses.push({
      phase: 'draw-return',
      frameId: receipt.frameId,
      temporal: returned.temporal,
      graphGenerations: returned.renderGraphGenerationAllocation,
    });
    renderValue(await receipt.completed);
    expect(nativeErrors).toEqual([]);
    resourceWitnesses.push({
      phase: 'completed',
      frameId: receipt.frameId,
      temporal: renderer.inspect().temporal,
    });
    return receipt;
  };
  const observe = async (label: string) => {
    const tickets = [...targets, cube].map((target) =>
      renderValue(renderer.requestTargetReadback(target, { mipLevel: 0, layer: 0 })),
    );
    const snapshot = renderValue(
      renderer.requestFramebufferSnapshot(snapshotTarget, {
        region: { x: 0, y: 0, width: 16, height: 16 },
        camera: Number(cameras[0]),
      }),
    );
    const receipt = await draw();
    const result = renderValue(
      await renderer.observe(receipt, {
        include: ['target-readbacks', 'timings'],
        targetReadbacks: tickets,
        framebufferSnapshots: [snapshot],
      }),
    );
    writeFileSync(
      `${directory}/${label}-inspection.json`,
      JSON.stringify(renderer.inspect(), null, 2),
    );
    writeFileSync(`${directory}/${label}-timings.json`, JSON.stringify(result.timings, null, 2));
    for (const [index, readback] of (result.targetReadbacks ?? []).entries()) {
      writeFileSync(`${directory}/${label}-${index}.rgba`, readback.bytes);
    }
    expect(result.framebufferSnapshots).toHaveLength(1);
    expect(result.framebufferSnapshots?.[0]).toMatchObject({
      frameId: receipt.frameId,
      deviceGeneration: renderer.inspect().frame.deviceGeneration,
      camera: Number(cameras[0]),
    });
    const timing = result.timings;
    if (timing?.status !== 'complete' && timing?.status !== 'partial') {
      throw new Error(`native timing observation failed: ${JSON.stringify(timing)}`);
    }
    expect(timing.frame.frameId).toBe(receipt.frameId);
    expect(timing.frame.deviceGeneration).toBe(renderer.inspect().frame.deviceGeneration);
    expect(
      timing.frame.passes.some((pass) => pass.status === 'measured' && pass.passKind === 'raster'),
    ).toBe(true);
    expect(
      timing.frame.passes.some((pass) => pass.status === 'measured' && pass.passKind === 'copy'),
    ).toBe(true);
    expect(result.targetReadbacks).toHaveLength(3);
    for (const [index, readback] of (result.targetReadbacks ?? []).entries()) {
      expect(readback.frameId).toBe(receipt.frameId);
      expect(readback.deviceGeneration).toBe(renderer.inspect().frame.deviceGeneration);
      const offset =
        16 * readback.bytesPerRow + (index === 0 && label === 'recovered-resized' ? 32 : 16) * 4;
      if (index < 2) expect(readback.bytes[offset + index]).toBeGreaterThan(200);
      else expect(readback.bytes.some((value, byte) => byte % 4 === 1 && value > 200)).toBe(true);
    }
    return result;
  };
  const settleCaptures = async () => {
    for (let frame = 0; frame < 120; frame++) {
      await draw();
      if (
        frame + 1 >= minimumCaptureFrames &&
        renderer.inspect().reflectionProbes.activeCount === 3
      )
        break;
    }
  };
  try {
    await settleCaptures();
    const beforeCapture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    await draw();
    (await recorder.frameBoundary()).unwrap();
    writeFileSync(`${directory}/before.rhitape`, (await beforeCapture).unwrap().bytes);
    writeFileSync(
      `${directory}/before-readback-inspection.json`,
      JSON.stringify(renderer.inspect(), null, 2),
    );
    await observe('before');
    expect(renderer.inspect().reflectionProbes.activeCount).toBe(3);
    if (cubeIntent === 0) {
      for (const camera of cameras) world.set(camera, Camera, { antialias: 3 }).unwrap();
      for (let frame = 0; frame < historyFrames; frame++) await draw();
      expect(renderer.inspect().temporal.resources.activeBytes).toBeGreaterThan(0);
      const historyCapture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      for (const [index, camera] of cameras.entries()) {
        world
          .set(camera, CameraView, { viewport: index === 0 ? [0, 0, 0.75, 1] : [0.75, 0, 0.25, 1] })
          .unwrap();
      }
      await draw();
      (await recorder.frameBoundary()).unwrap();
      writeFileSync(`${directory}/history-resize.rhitape`, (await historyCapture).unwrap().bytes);
      expect(peakRetiringHistoryBytes).toBeGreaterThan(0);
      expect(renderer.inspect().temporal.resources.retiringBytes).toBe(0);
    }
    const generation = renderer.inspect().frame.deviceGeneration;
    expect(loseDevice).toBeDefined();
    loseDevice?.();
    const deadline = Date.now() + 10_000;
    while (renderer.inspect().state !== 'device-lost') {
      if (Date.now() > deadline) throw new Error('loss notification did not reach Renderer');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'device-operation-failed',
      detail: { operation: 'renderer-event', cause: { code: 'device-lost' } },
    });
    writeFileSync(`${directory}/injected-loss.json`, JSON.stringify(errors, null, 2));
    errors.length = 0;
    renderValue(await renderer.recover());
    expect(renderer.inspect().frame.deviceGeneration).toBeGreaterThan(generation);
    const firstTarget = targets[0];
    if (firstTarget === undefined) throw new Error('first planar target missing');
    renderValue(renderer.resizeRenderTarget(firstTarget, { ...descriptor, width: 64, height: 32 }));
    await settleCaptures();
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const observationFailures: unknown[] = [];
    try {
      await observe('recovered-resized');
    } catch (error) {
      observationFailures.push(error);
    }
    try {
      (await recorder.frameBoundary()).unwrap();
      writeFileSync(`${directory}/recovered.rhitape`, (await capture).unwrap().bytes);
    } catch (error) {
      observationFailures.push(error);
    }
    if (observationFailures.length === 1) throw observationFailures[0];
    if (observationFailures.length > 1)
      throw new AggregateError(observationFailures, 'observation and RHI capture failed');
    expect(renderer.inspect().views).toHaveLength(2);
    expect(renderer.inspect().reflectionProbes.activeCount).toBe(3);
    expect(nativeErrors).toEqual([]);
    expect(errors).toEqual([]);
    writeFileSync(
      `${directory}/resource-witnesses.json`,
      JSON.stringify(resourceWitnesses, null, 2),
    );
  } finally {
    writeFileSync(`${directory}/native-errors.json`, JSON.stringify(nativeErrors, null, 2));
    writeFileSync(
      `${directory}/resource-witnesses.json`,
      JSON.stringify(resourceWitnesses, null, 2),
    );
    unsubscribe();
    lease.dispose();
    renderValue(await renderer.dispose());
    for (const texture of surfaces) texture.destroy();
    (await recorder.dispose()).unwrap();
  }
});

it('reads the accepted cube face during a different continuous capture face on an implicit display', {
  timeout: 120_000,
  retry: 0,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const errors: string[] = [];
  let surface: GPUTexture | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        options.device.addEventListener('uncapturederror', (event) =>
          errors.push(event.error.message),
        );
        surface = options.device.createTexture({
          size: [64, 64],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      getCurrentTexture: () => surface,
      unconfigure() {},
    }),
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifest },
    ),
  );
  const renderer = host.renderer;
  const world = new World();
  const cube = renderValue(
    renderer.createRenderTarget({
      shape: 'cube',
      width: 32,
      height: 32,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: true,
    }),
  );
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 1] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(1.4, 1.4, 0.4).unwrap()),
        },
      },
      {
        component: MeshRenderer,
        data: { materials: [world.allocSharedRef('MaterialAsset', Materials.unlit([1, 0, 0, 1]))] },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 6] } },
      { component: Camera, data: { aspect: 1, near: 0.1, far: 100, antialias: 0, bloom: 0 } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      {
        component: CubeCamera,
        data: {
          target: world.allocSharedRef('RenderTarget', cube),
          faceBudget: 1,
          updateIntent: 2,
        },
      },
    )
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = renderValue(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    renderValue(await receipt.completed);
    return receipt;
  };
  const directory = 'artifacts/scene-material-scaling/continuous-readback';
  mkdirSync(directory, { recursive: true });
  try {
    for (let frame = 0; frame < historyFrames; frame++) await draw();
    const ticket = renderValue(renderer.requestTargetReadback(cube, { mipLevel: 0, layer: 5 }));
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const receipt = await draw();
    (await recorder.frameBoundary()).unwrap();
    writeFileSync(`${directory}/readback.rhitape`, (await capture).unwrap().bytes);
    writeFileSync(`${directory}/inspection.json`, JSON.stringify(renderer.inspect(), null, 2));
    const observed = renderValue(
      await renderer.observe(receipt, { include: ['target-readbacks'], targetReadbacks: [ticket] }),
    );
    const readback = observed.targetReadbacks?.[0];
    expect(readback).toBeDefined();
    if (readback === undefined) throw new Error('cube face readback missing');
    expect(readback.frameId).toBe(receipt.frameId);
    expect(readback.deviceGeneration).toBe(renderer.inspect().frame.deviceGeneration);
    expect(readback.bytes[16 * readback.bytesPerRow + 16 * 4]).toBeGreaterThan(200);
    writeFileSync(`${directory}/face-minus-z.rgba`, readback.bytes);
    expect(errors).toEqual([]);
  } finally {
    lease.dispose();
    renderValue(await renderer.dispose());
    surface?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
