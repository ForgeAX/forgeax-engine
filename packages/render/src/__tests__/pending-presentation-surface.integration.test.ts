import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { RenderPipelineDescriptor, RhiCanvasContext, RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

// A WebGPU canvas texture acquired in a frame that encodes nothing presents as
// transparent black, replacing the last picture with the page background. A
// frame that only submits the preparation barrier must leave the surface alone.
it('keeps the canvas surface untouched while scene pipelines are still compiling', async () => {
  const device: RhiDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const releases: (() => void)[] = [];
  let hold = true;
  const create = device.createRenderPipeline.bind(device);
  device.createRenderPipelineAsync = vi.fn(async (descriptor: RenderPipelineDescriptor) => {
    const result = create(descriptor);
    if (hold) await new Promise<void>((resolve) => releases.push(resolve));
    return result;
  });
  let acquisitions = 0;
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    {
      rhi: {
        ...rhi,
        requestAdapter: async () =>
          ok({
            features: new Set<GPUFeatureName>(),
            limits: {},
            requestDevice: async () => ok(device),
          }),
        acquireCanvasContext: (canvas: Parameters<typeof rhi.acquireCanvasContext>[0]) => {
          const context = rhi.acquireCanvasContext(canvas);
          if (!context.ok) return context;
          const surface: RhiCanvasContext = context.value;
          const current = surface.getCurrentTexture.bind(surface);
          surface.getCurrentTexture = () => {
            acquisitions++;
            return current();
          };
          return context;
        },
      } as typeof rhi,
    },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await host.initialization).ok).toBe(true);
  const renderer = exposeRenderer(host);
  try {
    const assets = host.assetRegistry;
    const world = new World({ assets });
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: { assetHandle: assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap() },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [
              assets
                .create(Materials.standard({ baseColor: [0.8, 0.5, 0.2, 1], roughness: 0.6 }))
                .unwrap(),
            ],
          },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 8] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            bloom: BLOOM_DISABLED,
          },
        },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [-0.5, -0.9, -0.7], intensity: 3 },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      if (!drawn.ok) throw drawn.error;
      const receipt = drawn.value;
      expect((await receipt.completed).ok).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return receipt;
    };

    const pending = await draw();
    expect(pending.presentation).toBe('pending');
    expect(pending.presentationPendingReason?.code).toMatch(/pipeline-preparation/);
    expect(acquisitions).toBe(0);
    expect((await draw()).presentation).toBe('pending');
    expect(acquisitions).toBe(0);

    hold = false;
    for (const resolve of releases.splice(0)) resolve();
    let ready = false;
    for (let frame = 0; frame < 30 && !ready; frame++) {
      const before = acquisitions;
      const receipt = await draw();
      ready = receipt.presentation === 'ready';
      expect(acquisitions - before).toBe(ready ? 1 : 0);
    }
    expect(ready).toBe(true);
  } finally {
    hold = false;
    for (const resolve of releases.splice(0)) resolve();
    await renderer.dispose();
  }
});
