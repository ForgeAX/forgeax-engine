import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Camera,
  CameraView,
  CubeCamera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { EquirectAsset } from '@forgeax/engine-types';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import type { RenderableSnapshot } from '../../../render/src/render-system-extract';
import { PersistentRenderScene } from '../../../render/src/scene/render-scene';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';

async function presentedPixels(canvas: HTMLCanvasElement): Promise<number[]> {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = surface.getContext('2d');
  if (context === null) throw new Error('2D readback is required for pixel assertions');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return Array.from(context.getImageData(0, 0, surface.width, surface.height).data);
}

function redMeshPixels(pixels: readonly number[]): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    if (
      red !== undefined &&
      green !== undefined &&
      blue !== undefined &&
      red > green * 1.25 &&
      green > blue
    )
      count++;
  }
  return count;
}

it.each([
  'shared',
  'skybox',
  'skylight',
  'solid',
  'shared-taa',
  'shared-output',
  'shared-first',
  'shared-view-first',
  'shared-capture-first',
  'shared-vfx-first',
  'shared-vfx-taa',
] as const)('keeps %s environment presentation pending through the real IBL completion fence', async (mode) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  document.body.append(canvas);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedFinalFence = false;
  const errors: string[] = [];
  const submissions: string[][] = [];
  const originalRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await requestDevice(descriptor);
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const finalBuffers = new WeakSet<GPUCommandBuffer>();
      const labelsByBuffer = new WeakMap<GPUCommandBuffer, string[]>();
      const createEncoder = device.createCommandEncoder.bind(device);
      device.createCommandEncoder = (descriptor) => {
        const encoder = createEncoder(descriptor);
        let finalStage = false;
        const labels: string[] = [];
        const begin = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (descriptor) => {
          if (descriptor.label) labels.push(descriptor.label);
          if (descriptor.label === 'ibl-brdf-lut') finalStage = true;
          return begin(descriptor);
        };
        const beginCompute = encoder.beginComputePass.bind(encoder);
        encoder.beginComputePass = (descriptor) => {
          if (descriptor?.label) labels.push(descriptor.label);
          return beginCompute(descriptor);
        };
        const finish = encoder.finish.bind(encoder);
        encoder.finish = (descriptor) => {
          const buffer = finish(descriptor);
          if (finalStage) finalBuffers.add(buffer);
          labelsByBuffer.set(buffer, labels);
          return buffer;
        };
        return encoder;
      };
      const submit = device.queue.submit.bind(device.queue);
      let finalSubmission = false;
      device.queue.submit = (commands) => {
        const buffers = Array.from(commands);
        finalSubmission = buffers.some((buffer) => finalBuffers.has(buffer));
        submissions.push(buffers.flatMap((buffer) => labelsByBuffer.get(buffer) ?? []));
        submit(buffers);
      };
      const done = device.queue.onSubmittedWorkDone.bind(device.queue);
      device.queue.onSubmittedWorkDone = async () => {
        const hold = finalSubmission;
        finalSubmission = false;
        await done();
        if (hold) {
          reachedFinalFence = true;
          await held;
        }
      };
      return device;
    };
    return adapter;
  };
  let renderer: Renderer | undefined;
  let loseDevice: (() => void) | undefined;
  const lifecycleErrors: unknown[] = [];
  let unsubscribeLifecycle: (() => void) | undefined;
  let detach: (() => void) | undefined;
  let transforms: (() => void) | undefined;
  let restoreTemporalObserver: (() => void) | undefined;
  const vfx = mode.startsWith('shared-vfx')
    ? createVfxRuntimeHost({ camera: { read: () => undefined } })
    : undefined;
  let detachVfx: (() => Promise<void>) | undefined;
  try {
    const host = await constructRuntimeRendererHost(
      canvas,
      {
        ...(vfx === undefined ? {} : { features: [vfx.feature] }),
        ...(mode === 'shared-view-first'
          ? {
              rhiInstrumentation: {
                deviceLost: () =>
                  new Promise((resolve) => {
                    loseDevice = () =>
                      resolve({
                        reason: 'unknown',
                        message: 'pending CameraView recovery witness',
                      });
                  }),
              },
            }
          : {}),
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!host.ok) throw host.error;
    renderer = host.value.renderer;
    if (mode === 'shared-view-first')
      unsubscribeLifecycle = renderer.subscribe((event) => {
        if (event.kind === 'error') lifecycleErrors.push(event.error);
      });
    const world = new World();
    transforms = registerPropagateTransforms(world);
    if (vfx !== undefined) {
      const attached = await vfx.attachWorld({ world, assets: host.value.assets });
      if (!attached.ok) throw attached.error;
      detachVfx = async () => {
        const detached = await vfx.detachWorld({ world });
        if (!detached.ok) throw detached.error;
      };
    }
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: mode.endsWith('-taa') ? ANTIALIAS_TAA : ANTIALIAS_NONE,
            tonemap: TONEMAP_ACES_FILMIC,
            exposure: mode === 'shared-output' ? 0.92 : 1,
          },
        },
      )
      .unwrap();
    if (mode === 'shared-view-first')
      world.addComponent(camera, { component: CameraView, data: { enabled: true } }).unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [0, -1, -1],
          intensity: 1,
        },
      })
      .unwrap();
    const source: EquirectAsset = {
      kind: 'equirect',
      width: 8,
      height: 4,
      format: 'rgba32float',
      colorSpace: 'linear',
      data: new Uint8Array(new Float32Array(8 * 4 * 4).fill(1).buffer),
    };
    const firstImage =
      mode === 'shared-first' ||
      mode === 'shared-view-first' ||
      mode === 'shared-capture-first' ||
      mode === 'shared-vfx-first';
    const mesh =
      mode.endsWith('-taa') || firstImage
        ? world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 0] } },
              {
                component: MeshFilter,
                data: {
                  assetHandle: testAssets(world)
                    .create(createPrimitiveMesh('cube').unwrap())
                    .unwrap(),
                },
              },
              {
                component: MeshRenderer,
                data: {
                  materials: [
                    testAssets(world)
                      .create(Materials.unlit([0.8, 0.2, 0.1, 1]))
                      .unwrap(),
                  ],
                },
              },
            )
            .unwrap()
        : undefined;
    let previousMeshX: number | undefined;
    const prepareTemporalFrame = PersistentRenderScene.prototype.prepareTemporalFrame;
    const temporalObserver = vi
      .spyOn(PersistentRenderScene.prototype, 'prepareTemporalFrame')
      .mockImplementation(function (this: PersistentRenderScene, renderables) {
        const row = (renderables as readonly RenderableSnapshot[]).find(
          (row) => row.entityKey === mesh,
        );
        previousMeshX = row?.temporal?.previousTransform.world[12];
        return prepareTemporalFrame.call(this, renderables);
      });
    restoreTemporalObserver = () => temporalObserver.mockRestore();
    const equirect = mode === 'solid' ? undefined : testAssets(world).create(source).unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    detach = () => lease.dispose();
    const draw = async () => {
      world.update(1 / 60).unwrap();
      if (!renderer) throw new Error('Renderer missing');
      const drawn = renderer.draw({
        leases: [lease],
        camera: { lease, entityKey: camera },
        environment: { lease },
      });
      if (!drawn.ok) throw drawn.error;
      const receipt = drawn.value;
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      return receipt.presentation;
    };
    if (mode === 'shared-capture-first') {
      const target = renderer.createRenderTarget({
        shape: 'cube',
        width: 32,
        height: 32,
        format: 'rgba8unorm',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: true,
      });
      if (!target.ok) throw target.error;
      world.addComponent(camera, { component: CameraView, data: { enabled: false } }).unwrap();
      const captureCamera = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 2] } },
          {
            component: CubeCamera,
            data: {
              target: world.allocSharedRef('RenderTarget', target.value),
              faceBudget: 1,
              updateIntent: 0,
            },
          },
        )
        .unwrap();
      const beforeCapture = submissions.length;
      await draw();
      expect(submissions.slice(beforeCapture).flat(), 'real capture must execute first').toContain(
        'cube-capture-face.0',
      );
      world.removeComponent(camera, CameraView).unwrap();
      world.despawn(captureCamera).unwrap();
    }
    const installEnvironment = () => {
      if (mode !== 'skybox')
        world
          .spawn({
            component: Skylight,
            data: { ...(equirect === undefined ? {} : { equirect }), intensity: 1 },
          })
          .unwrap();
      if (mode === 'skybox' || mode.startsWith('shared'))
        world
          .spawn({
            component: SkyboxBackground,
            data: { ...(equirect === undefined ? {} : { equirect }), mode: SKYBOX_MODE_CUBEMAP },
          })
          .unwrap();
    };
    let projectionStart = submissions.length;
    if (firstImage) installEnvironment();
    const deadline = performance.now() + 90_000;
    // The original startup can submit a fallback graph before the image POD
    // reaches residency. Exercise that same route instead of an empty history.
    let baseline = await draw();
    while (!firstImage && baseline !== 'ready' && performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      baseline = await draw();
    }
    expect(baseline, 'the first actual display graph must be accepted').toBe(
      firstImage ? 'pending' : 'ready',
    );
    const initialDisplay = firstImage
      ? submissions
          .slice(projectionStart)
          .filter((labels) => !labels.some((label) => label.startsWith('ibl-')))
      : [];
    if (firstImage)
      expect(
        initialDisplay.flat(),
        'pending image must not suppress the first geometry picture',
      ).toContain('main');
    const acceptedEpoch = renderer.inspect().temporal.epoch;
    const acceptedOutput = renderer.inspect().output;
    const acceptedPixels = mode === 'solid' ? undefined : await presentedPixels(canvas);
    if (firstImage) {
      if (!acceptedPixels) throw new Error('First display readback missing');
      expect(
        redMeshPixels(acceptedPixels),
        'the first pending display must contain actual red mesh pixels',
      ).toBeGreaterThan(16);
    }
    if (!firstImage) {
      projectionStart = submissions.length;
      installEnvironment();
    }

    if (mode !== 'solid') {
      while (!reachedFinalFence && performance.now() < deadline) {
        await draw();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      expect(reachedFinalFence, 'lazy projection must run through its actual final GPU stage').toBe(
        true,
      );
      if (mesh !== undefined) {
        world.set(mesh, Transform, { pos: [0.2, 0, 0] }).unwrap();
        await draw();
        world.set(mesh, Transform, { pos: [0.4, 0, 0] }).unwrap();
      }
      const beforeHeldDraw = submissions.length;
      expect(
        await draw(),
        'submitted clear/environment cannot qualify incomplete image lighting',
      ).toBe('pending');
      expect(
        submissions.length,
        'pending work still crosses the native submit barrier',
      ).toBeGreaterThan(beforeHeldDraw);
      const pendingSubmissions = submissions.slice(projectionStart);
      // One cube projection, six irradiance faces, ten PMREM levels × six faces, one LUT.
      expect(
        pendingSubmissions.filter((labels) => labels.some((label) => label.startsWith('ibl-'))),
      ).toHaveLength(68);
      expect(
        pendingSubmissions
          .filter((labels) => !labels.some((label) => label.startsWith('ibl-')))
          .slice(initialDisplay.length)
          .flat()
          .filter((label) => mode !== 'shared-view-first' || label !== 'camera-view-composite'),
        'fallback scene/shadow/post work must not delay the authored image',
      ).toEqual([]);
      expect(
        renderer.inspect().temporal.epoch,
        'pending draws retain accepted camera history',
      ).toBe(acceptedEpoch);
      expect(renderer.inspect().directionalShadow.error).toBeUndefined();
      if (vfx !== undefined)
        expect(renderer.inspect().featureDiagnostics).toContainEqual(
          expect.objectContaining({
            identity: vfx.feature.identity,
            status: 'active',
            latestError: undefined,
          }),
        );
      expect(renderer.inspect().output).toEqual(acceptedOutput);
      if (mode.endsWith('-taa'))
        expect(previousMeshX, 'undrawn transforms are not submitted history').toBe(0);
      expect(
        await presentedPixels(canvas),
        'pending image work retains the physical picture at unchanged size',
      ).toEqual(acceptedPixels);
      if (mode === 'shared-view-first' || mode === 'shared-first') {
        canvas.width = canvas.height = 48;
        const resizedStart = submissions.length;
        expect(await draw()).toBe('pending');
        expect(
          submissions.slice(resizedStart).flat(),
          'a resized output must be written before presentation',
        ).toContain('main');
        const resizedPixels = await presentedPixels(canvas);
        // Element screenshots include iframe scaling; the accepted GPU extent owns this size.
        expect(renderer.inspect().barrelDistortion.extent).toEqual({ width: 48, height: 48 });
        expect(redMeshPixels(resizedPixels)).toBeGreaterThan(16);
        const resizedEpoch = renderer.inspect().temporal.epoch;
        const resizedOutput = renderer.inspect().output;
        const stableResizeStart = submissions.length;
        expect(await draw()).toBe('pending');
        expect(
          submissions.slice(stableResizeStart).flat(),
          'the accepted resized picture only needs composition while the image is pending',
        ).toEqual(mode === 'shared-view-first' ? ['camera-view-composite'] : []);
        expect(await presentedPixels(canvas)).toEqual(resizedPixels);
        expect(renderer.inspect().temporal.epoch).toBe(resizedEpoch);
        expect(renderer.inspect().output).toEqual(resizedOutput);
      }
      if (mode === 'shared-view-first') {
        const generation = renderer.inspect().frame.deviceGeneration;
        if (loseDevice === undefined) throw new Error('Device-loss notification is required');
        loseDevice();
        while (renderer.inspect().state !== 'device-lost' && performance.now() < deadline)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(renderer.inspect().state).toBe('device-lost');
        expect(lifecycleErrors, JSON.stringify(lifecycleErrors)).toHaveLength(1);
        expect(lifecycleErrors[0]).toMatchObject({
          code: 'device-operation-failed',
          detail: { operation: 'renderer-event', cause: { code: 'device-lost' } },
        });
        const recovered = await renderer.recover();
        if (!recovered.ok) throw recovered.error;
        expect(renderer.inspect().frame.deviceGeneration).toBeGreaterThan(generation);
        const recoveredStart = submissions.length;
        expect(await draw()).toBe('pending');
        expect(
          submissions.slice(recoveredStart).flat(),
          'a new device cannot compose an unwritten CameraView output',
        ).toContain('main');
        const recoveredPixels = await presentedPixels(canvas);
        expect(renderer.inspect().barrelDistortion.extent).toEqual({ width: 48, height: 48 });
        expect(redMeshPixels(recoveredPixels)).toBeGreaterThan(16);
      }
    }
    const readyStart = submissions.length;
    release();
    let readyFrames = 0;
    while (readyFrames < 60 && performance.now() < deadline) {
      if ((await draw()) === 'ready') {
        if (mode.endsWith('-taa') && readyFrames === 0) expect(previousMeshX).toBe(0);
        if (mode.endsWith('-taa') && readyFrames === 1) expect(previousMeshX).toBeCloseTo(0.4);
        readyFrames++;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    expect(readyFrames).toBe(60);
    expect(submissions.slice(readyStart).flat()).toContain('main');
    if (mode.endsWith('-taa'))
      expect(renderer.inspect().temporal.epoch).toBeGreaterThan(acceptedEpoch);
    expect(reachedFinalFence).toBe(mode !== 'solid');
    if (mode === 'shared-view-first') expect(lifecycleErrors).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    release();
    detach?.();
    transforms?.();
    await detachVfx?.();
    await renderer?.dispose();
    unsubscribeLifecycle?.();
    restoreTemporalObserver?.();
    navigator.gpu.requestAdapter = originalRequestAdapter;
    canvas.remove();
  }
}, 120_000);
