import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { Camera, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
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

const SIZE = 32;

/**
 * A Pack-cooked transmission Standard program declares its dedicated backdrop
 * pair. On the default WebGPU limit of 16 sampled textures the material layout
 * and bindings must keep that declared pair, or pipeline creation fails with
 * "Binding doesn't exist in pbr-material-skylight-bgl".
 */
it('renders a cooked transmission material at a 16 sampled-texture limit', {
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
  // Cap the device at the WebGPU default every ordinary browser receives.
  const gpu = globalThis.navigator.gpu;
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = (descriptor) =>
      requestDevice({
        ...descriptor,
        requiredLimits: { ...descriptor?.requiredLimits, maxSampledTexturesPerShaderStage: 16 },
      });
    return adapter;
  };
  let target: GPUTexture | undefined;
  const nativeErrors: string[] = [];
  let observed: GPUDevice | undefined;
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        if (observed !== options.device)
          options.device.addEventListener('uncapturederror', (event) =>
            nativeErrors.push(event.error.message),
          );
        observed = options.device;
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
  const errors: unknown[] = [];
  let dispose: (() => Promise<unknown>) | undefined;
  try {
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
    dispose = () => renderer.dispose();
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    host.assets.configureRuntimeBinding(liveBinding);
    const glass = (
      await host.assets.load(
        host.assets.parseGuid(surfaceEvidenceGuid('material/cooked-glass')),
        'material',
      )
    ).unwrap();
    const world = new World({ assets: host.assets });
    const eye = [0, 0, 3];
    world
      .spawn(
        {
          component: Transform,
          data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]) },
        },
        {
          component: Camera,
          data: {
            ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 }),
            clearColor: [0.2, 0.3, 0.4, 1],
          } as never,
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world)
              .create(createBoxGeometry(1, 1, 1).unwrap())
              .unwrap(),
          },
        },
        { component: MeshRenderer, data: { materials: [glass] } },
      )
      .unwrap();
    const lease = renderValue(renderer.attach(world));
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    for (let i = 0; i < 4; i++)
      await drawReadyFrame(renderer, {
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
    expect(observed?.limits.maxSampledTexturesPerShaderStage).toBe(16);
    expect(errors).toEqual([]);
    expect(nativeErrors).toEqual([]);
  } finally {
    gpu.requestAdapter = originalRequestAdapter;
    if (dispose !== undefined) await dispose();
    target?.destroy();
    await server.close();
  }
});
