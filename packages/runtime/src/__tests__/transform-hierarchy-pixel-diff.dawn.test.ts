import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { shaderManifestUrl } from './shader-manifest-url.fixture';
// transform-hierarchy-pixel-diff.dawn.test.ts -
// feat-20260531-render-consume-global-transform-hierarchy / M3 / w13.
//
// Dawn integration test mirroring the hello-transform-hierarchy smoke
// (apps/hello/transform-hierarchy/scripts/smoke-dawn.mjs): AC-08
// parent-moves-child-follows. Single World wires the consume path
// through renderer.attach, spawns a non-identity parent + a ChildOf
// child + a static reference sphere, then proves moving the PARENT moves the
// CHILD's rendered world position (the child gets no Transform write of its
// own between frames; the only change is the parent's resolved GlobalTransform.world
// mat4 propagated down the ChildOf edge). This is the vitest-dawn-project
// counterpart to the CI
// smoke step so `pnpm test:dawn` exercises the visual-evidence path
// (plan-strategy section 5.5 "Vitest dawn project" row).
//
// Follows the fxaa-pixel-diff.dawn.test.ts pattern for canvas mock,
// device capture, and pixel readback.

import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const WIDTH = 256;
const HEIGHT = 256;

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const PARENT_X_REST = -0.6;
const PARENT_X_MOVED = 1.0;
const TOTAL_PIXELS = WIDTH * HEIGHT;
const DIFF_THRESHOLD = Math.floor(TOTAL_PIXELS * 0.001);

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

async function doReadPixels(device: GPUDevice, renderTarget: GPUTexture): Promise<Uint8Array> {
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = WIDTH * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const buf = device.createBuffer({
    size: bytesPerRow * HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: buf, bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(MAP_MODE_READ);
  const mapped = buf.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  buf.unmap();
  buf.destroy();
  return bytes;
}

function diffCountOf(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) n++;
  }
  return n;
}

describe('feat-20260531 M3 w13: AC-08 parent moves -> child follows (dawn)', () => {
  it('moving the parent moves the ChildOf child rendered world position', async () => {
    const dawnAvailable = typeof globalThis.navigator?.gpu?.requestAdapter === 'function';
    if (!dawnAvailable)
      throw new Error('dawn-node navigator.gpu not injected; vitest.setup-webgpu.ts regressed');

    let sharedDevice: GPUDevice | undefined;
    const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
      globalThis.navigator.gpu,
    );
    globalThis.navigator.gpu.requestAdapter = async (opts) => {
      const rawAdapter = await originalRequestAdapter(opts);
      if (rawAdapter === null) return rawAdapter;
      const originalRequestDevice = rawAdapter.requestDevice.bind(rawAdapter);
      rawAdapter.requestDevice = async (desc) => {
        const dev = await originalRequestDevice(desc);
        if (sharedDevice === undefined) sharedDevice = dev;
        return dev;
      };
      return rawAdapter;
    };

    let renderTarget: GPUTexture | undefined;
    const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
      if (renderTarget !== undefined) return renderTarget;
      renderTarget = device.createTexture({
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      return renderTarget;
    };
    const mockCanvas = {
      width: WIDTH,
      height: HEIGHT,
      getContext(kind: string): unknown {
        if (kind !== 'webgpu') return null;
        return {
          configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
            ensureRenderTarget(desc.device, desc.format ?? 'rgba8unorm');
          },
          unconfigure() {},
          getCurrentTexture(): GPUTexture {
            if (renderTarget === undefined) {
              if (sharedDevice === undefined)
                throw new Error('render target requested before device captured');
              return ensureRenderTarget(sharedDevice, 'rgba8unorm');
            }
            return renderTarget;
          },
        };
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;

    let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
    try {
      host = await constructRuntimeRendererHost(
        mockCanvas,
        {},
        {
          shaderManifestUrl: ENGINE_MANIFEST_URL,
        },
      );
    } finally {
      globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
    }
    expect(host.ok).toBe(true);
    if (!host.ok) throw host.error;
    const { renderer } = host.value;
    expect(renderer.inspect().state).toBe('alive');
    const device = sharedDevice;
    if (device === undefined) throw new Error('GPUDevice not captured');

    // Single World wires the consume path through renderer.attach so the
    // child's resolved GlobalTransform.world mat4 is derived each frame. feat-20260614
    // M8: the material is a per-World column handle minted via allocSharedRef
    // (AssetRegistry has no handle concept).
    const world = new World();
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;

    const materialHandle = world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColor: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.4 },
    });

    const parent = world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [PARENT_X_REST, -0.4, 0],
            quat: [0, 0, 0, 1],
            scale: [0.4, 0.4, 0.4],
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 2.0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: ChildOf, data: { parent } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [1.4, 0, 0], quat: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4] },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();

    world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [-0.4, -0.6, -0.7],
          color: [1, 1, 1],
          intensity: 1.5,
        },
      })
      .unwrap();

    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 7] } },
        {
          component: Camera,
          data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } as Record<
            string,
            unknown
          > as never,
        },
      )
      .unwrap();

    // Frame A: parent at rest. world.update(1 / 60).unwrap() runs propagateTransforms.
    world.update(1 / 60).unwrap();
    await drawReadyFrame(renderer, {
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    await device.queue.onSubmittedWorkDone();
    if (renderTarget === undefined) throw new Error('renderTarget not configured');
    const pixelsA = await doReadPixels(device, renderTarget);

    // Stability: a second render of the rest scene must be pixel-stable.
    world.update(1 / 60).unwrap();
    await drawReadyFrame(renderer, {
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    await device.queue.onSubmittedWorkDone();
    const pixelsAA = await doReadPixels(device, renderTarget);
    expect(diffCountOf(pixelsA, pixelsAA)).toBe(0);

    // Frame B: move the PARENT only. propagate re-derives the child's world transform.
    const setRes = world.set(parent, Transform, { pos: [PARENT_X_MOVED, 0, 0] });
    expect(setRes.ok).toBe(true);
    world.update(1 / 60).unwrap();
    await drawReadyFrame(renderer, {
      leases: [attachment.value],
      camera: { lease: attachment.value },
      environment: { lease: attachment.value },
    });
    await device.queue.onSubmittedWorkDone();
    const pixelsB = await doReadPixels(device, renderTarget);

    // AC-08: the child followed the parent's world displacement.
    const diffCount = diffCountOf(pixelsA, pixelsB);
    expect(
      diffCount,
      `expected parent-move pixel diff > ${DIFF_THRESHOLD}; got ${diffCount}`,
    ).toBeGreaterThan(DIFF_THRESHOLD);
  });
});
