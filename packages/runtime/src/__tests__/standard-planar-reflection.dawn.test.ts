import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createPlaneGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  perspective,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createServer, loadConfigFromFile } from 'vite';
import { expect, it } from 'vitest';
import { surfaceEvidenceGuid } from '../../../../apps/preview/src/surface-standard-evidence-identity';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

const SIZE = 64;

/**
 * An unlit red box stands on a polished metal floor whose cooked Standard
 * material opts into `planarReflection`. With the camera's PlanarReflection the
 * floor shows the box's mirror image; without it, or on a rough floor, the
 * unlit floor keeps the black environment. With a Renderer-owned mirror that
 * generates mipmaps, the rough floor keeps the reflection but samples a blurred
 * mip: lower variance than the polished floor, more energy than the fade. The
 * floor renders forward on both paths and both lanes.
 */
it('mirrors the PlanarReflection capture on an opted-in Standard floor', {
  timeout: 240_000,
}, async () => {
  process.env.FORGEAX_SURFACE_ONLY = '1';
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    resolve('apps/preview/vite.config.ts'),
  );
  if (loaded === null) throw new Error('Preview configuration missing');
  const server = await createServer({
    ...loaded.config,
    configFile: false,
    root: resolve('apps/preview'),
    logLevel: 'error',
    server: { ...loaded.config.server, host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  if (baseUrl === undefined) throw new Error('Preview URL unavailable');
  const binding = createStandaloneRuntimeAssetBinding('preview');
  const liveBinding = {
    ...binding,
    catalogUrl: new URL(binding.catalogUrl, baseUrl).href,
    importUrlBase: new URL(binding.importUrlBase, baseUrl).href,
    packageUrlBase: new URL(binding.packageUrlBase, baseUrl).href,
  };
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const nativeErrors: string[] = [];
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        if (device !== options.device)
          options.device.addEventListener('uncapturederror', (event) =>
            nativeErrors.push(event.error.message),
          );
        device = options.device;
        target?.destroy();
        target = options.device.createTexture({
          size: [SIZE, SIZE],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {},
      {
        shaderManifestUrl: new URL('shaders/manifest.json', baseUrl).href,
        importTransport: createDevImportTransport(liveBinding),
      },
    ),
  );
  const { renderer } = host;
  host.assets.configureRuntimeBinding(liveBinding);
  const load = async (name: string) =>
    (
      await host.assets.load(
        host.assets.parseGuid(surfaceEvidenceGuid(`material/${name}`)),
        'material',
      )
    ).unwrap();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const [red, mirror, rough] = await Promise.all([
      load('planar-red'),
      load('planar-mirror'),
      load('planar-rough-mirror'),
    ]);
    const world = new World({ assets: host.assets });
    const assets = testAssets(world);
    const eye = [0, 1.6, 4];
    const camera = world
      .spawn(
        {
          component: Transform,
          data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0.2, -1], [0, 1, 0]) },
        },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 40 }),
            antialias: 0,
            bloom: 0,
            tonemap: 1,
            clearColor: [0, 0, 0, 1],
          } as never,
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0.75, -1.5] } },
        {
          component: MeshFilter,
          data: { assetHandle: assets.create(createBoxGeometry(1, 1.5, 1).unwrap()).unwrap() },
        },
        {
          component: MeshRenderer,
          data: { materials: [red] },
        },
      )
      .unwrap();
    const floor = world
      .spawn(
        {
          component: Transform,
          data: { quat: quat.fromEuler(quat.create(), -Math.PI / 2, 0, 0, 'XYZ') },
        },
        {
          component: MeshFilter,
          data: { assetHandle: assets.create(createPlaneGeometry(30, 30).unwrap()).unwrap() },
        },
        { component: MeshRenderer, data: { materials: [mirror] } },
      )
      .unwrap();
    const reflection = renderValue(
      renderer.createRenderTarget({
        shape: '2d',
        width: SIZE,
        height: SIZE,
        format: 'rgba16float',
        sampleCount: 1,
        mipLevels: 1,
        sampled: true,
        readback: false,
      }),
    );
    const lease = renderValue(renderer.attach(world));
    const readFrame = async () => {
      if (device === undefined || target === undefined) throw new Error('no target');
      const bytesPerRow = 256;
      const buffer = device.createBuffer({ size: bytesPerRow * SIZE, usage: 0x0001 | 0x0008 });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [SIZE, SIZE, 1]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(0x0001);
      const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      const bgra = target.format.startsWith('bgra');
      let count = 0;
      // Red channel statistics over the lower half, where the floor and its mirror image lie.
      const floor: number[] = [];
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          const o = y * bytesPerRow + x * 4;
          const r = bytes[o + (bgra ? 2 : 0)] as number;
          const g = bytes[o + 1] as number;
          const b = bytes[o + (bgra ? 0 : 2)] as number;
          if (r > 40 && r > 2 * g && r > 2 * b) count++;
          if (y >= SIZE / 2) floor.push(r);
        }
      const mean = floor.reduce((sum, r) => sum + r, 0) / floor.length;
      const variance = floor.reduce((sum, r) => sum + (r - mean) ** 2, 0) / floor.length;
      return { count, mean, variance };
    };
    type Planar = 'none' | 'game' | 'owned-mips';
    let current: Planar = 'none';
    const frameStats = async (planar: Planar, material: typeof mirror, direct: boolean) => {
      if (planar !== current && world.hasComponent(camera, PlanarReflection))
        world.removeComponent(camera, PlanarReflection).unwrap();
      if (planar !== current && planar !== 'none')
        world
          .addComponent(camera, {
            component: PlanarReflection,
            data:
              planar === 'game'
                ? { target: world.allocSharedRef('RenderTarget', reflection) }
                : { resolutionScale: 1, generateMipmaps: true },
          })
          .unwrap();
      current = planar;
      world.set(floor, MeshRenderer, { materials: [material] } as never).unwrap();
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      for (let i = 0; i < 4; i++)
        await drawReadyFrame(renderer, {
          leases: [lease],
          camera: { lease },
          environment: { lease },
          ...(direct ? { geometryLane: 'direct' as const } : {}),
        });
      return readFrame();
    };
    const frame = async (planar: boolean, material: typeof mirror, direct: boolean) =>
      (await frameStats(planar ? 'game' : 'none', material, direct)).count;
    const profile = renderer.inspect().profile;
    for (const renderPath of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...profile, renderPath, ssao: false }));
      for (const direct of [true, false]) {
        const label = `${renderPath}/${direct ? 'direct' : 'gpu-driven'}`;
        const box = await frame(false, mirror, direct);
        const mirrored = await frame(true, mirror, direct);
        const roughFloor = await frame(true, rough, direct);
        expect(box, `${label} the box is visible`).toBeGreaterThan(40);
        // The mirror image below the box at least doubles the red coverage.
        expect(mirrored, `${label} the floor mirrors the box`).toBeGreaterThan(box * 1.6);
        expect(roughFloor, `${label} a rough floor keeps the environment`).toBeLessThan(box * 1.2);
        const faded = await frameStats('game', rough, direct);
        const smooth = await frameStats('owned-mips', mirror, direct);
        const blurred = await frameStats('owned-mips', rough, direct);
        expect(smooth.count, `${label} the owned mirror reflects the box`).toBeGreaterThan(
          box * 1.6,
        );
        expect(blurred.mean, `${label} a mipped rough floor keeps the mirror`).toBeGreaterThan(
          faded.mean + 1,
        );
        expect(blurred.variance, `${label} the rough mip is blurred`).toBeLessThan(
          smooth.variance * 0.75,
        );
      }
    }
    expect(errors).toEqual([]);
    expect(nativeErrors).toEqual([]);
  } finally {
    unsubscribe();
    renderValue(await renderer.dispose());
    target?.destroy();
    await server.close();
  }
});
