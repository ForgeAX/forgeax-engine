import { mkdirSync, writeFileSync } from 'node:fs';
import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, type RenderError } from '@forgeax/engine-render';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import {
  EXTERNAL_TEXTURE_MATERIAL_GUID,
  externalTextureMaterialFixture,
} from '../../../../scripts/test/external-texture-material-fixture';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const SIZE = 64;
const EPSILON = Math.round(0.05 * 255);
const EVIDENCE = 'artifacts/pr-evidence/external-texture-video';
const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

function halves(device: GPUDevice, top: number[], bottom: number[], usage = 0x04 | 0x02) {
  const texture = device.createTexture({
    label: 'caller-owned',
    size: { width: 16, height: 16 },
    format: 'rgba8unorm',
    usage,
  });
  const bytes = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) bytes.set([...(y < 8 ? top : bottom), 255], (y * 16 + x) * 4);
  device.queue.writeTexture({ texture }, bytes, { bytesPerRow: 64 }, { width: 16, height: 16 });
  return texture;
}

async function readRgb(device: GPUDevice, texture: GPUTexture, x: number, y: number) {
  const buffer = device.createBuffer({ size: 256, usage: 0x0001 | 0x0008 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, origin: { x, y } },
    { buffer, bytesPerRow: 256 },
    { width: 1, height: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(0x0001);
  const px = [...new Uint8Array(buffer.getMappedRange().slice(0, 4))];
  buffer.destroy();
  return texture.format.startsWith('bgra') ? [px[2], px[1], px[0]] : [px[0], px[1], px[2]];
}

it('imports a caller GPUTexture on Dawn, binds it into texture_external, and reports video absence as data', {
  timeout: 120_000,
}, async () => {
  const probe = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const caps = {
    externalTexture: probe.caps.externalTexture,
    textureImport: probe.caps.textureImport,
  };
  expect(caps).toEqual({ externalTexture: false, textureImport: true });
  const foreign = renderValue(probe.nativeDevice());

  let target: GPUTexture | undefined;
  const canvas = {
    width: SIZE,
    height: SIZE,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target?.destroy();
        target = options.device.createTexture({
          size: [SIZE, SIZE],
          format: options.format,
          usage: 0x10 | 0x01,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: [externalTextureMaterialFixture()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (base === undefined) throw new Error('missing external texture fixture server');
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: webgpu.rhi },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const { renderer, assets } = host;
  const errors: RenderError[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error as RenderError);
  });
  const world = new World();
  const owner = await createWorldContext(world, [scenePlugin()]);
  const lease = renderValue(renderer.attach(world));
  try {
    assets.configurePackIndex(new URL('__external-texture-material/pack-index.json', base).href);
    const guid = assets.parseGuid(EXTERNAL_TEXTURE_MATERIAL_GUID);
    (await assets.loadByGuid<MaterialAsset>(guid)).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 10,
            antialias: 0,
            bloom: 0,
            tonemap: 0,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    const native = renderValue(renderer.nativeDevice());
    let destroyedByEngine = 0;
    const caller = halves(native, [255, 0, 0], [0, 0, 255]);
    const destroy = caller.destroy.bind(caller);
    caller.destroy = () => {
      destroyedByEngine += 1;
      destroy();
    };
    const handle = renderValue(
      await renderer.importTexture({ kind: 'gpu-texture', texture: caller }),
    );
    const source = world.allocSharedRef('ExternalTextureSource', handle.source);
    const material = world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      parent: guid,
      values: { videoTexture: source },
    });
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [3, 3, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const draw = async (count: number) => {
      for (let i = 0; i < count; i++) {
        world.update(1 / 60).unwrap();
        const receipt = renderValue(
          renderer.draw({
            leases: [lease],
            camera: { lease },
            environment: { lease },
            geometryLane: 'direct',
          }),
        );
        renderValue(await receipt.completed);
      }
    };
    await draw(60);
    if (target === undefined) throw new Error('canvas never configured');
    const top = await readRgb(native, target, SIZE / 2, SIZE / 4);
    const bottom = await readRgb(native, target, SIZE / 2, (SIZE * 3) / 4);
    const near = (actual: (number | undefined)[], expected: number[]) =>
      actual.every((v, i) => Math.abs((v ?? -999) - (expected[i] ?? 0)) <= EPSILON);
    expect(near(top, [255, 0, 0]), `top ${top}`).toBe(true);
    expect(near(bottom, [0, 0, 255]), `bottom ${bottom}`).toBe(true);

    renderValue(
      await handle.replace({
        kind: 'gpu-texture',
        texture: halves(native, [0, 255, 0], [255, 255, 255]),
      }),
    );
    await draw(2);
    const replacedTop = await readRgb(native, target, SIZE / 2, SIZE / 4);
    expect(near(replacedTop, [0, 255, 0]), `replaced ${replacedTop}`).toBe(true);

    const usage = await renderer.importTexture({
      kind: 'gpu-texture',
      texture: halves(native, [0, 0, 0], [0, 0, 0], 0x02),
    });
    const wrongDevice = await renderer.importTexture({
      kind: 'gpu-texture',
      texture: halves(foreign, [0, 0, 0], [0, 0, 0]),
    });
    const video = await renderer.importTexture({ kind: 'video', source: {} as VideoFrame });
    for (const [result, reason] of [
      [usage, 'usage'],
      [wrongDevice, 'device-mismatch'],
      [video, 'source-unsupported'],
    ] as const) {
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          code: 'external-texture-invalid',
          detail: { reason },
        });
    }

    renderValue(handle.release());
    await draw(2);
    expect(errors.map((e) => e.detail)).toEqual([
      { operation: 'bind', reason: 'released', generation: expect.any(Number) },
    ]);
    expect(destroyedByEngine).toBe(0);
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      `${EVIDENCE}/dawn-gpu-texture.json`,
      JSON.stringify(
        {
          backend: 'dawn-node',
          caps,
          frames: 64,
          epsilon: EPSILON,
          externalSlotPixels: { top, bottom, replacedTop },
          rejections: [usage, wrongDevice, video].map((r) => (r.ok ? null : r.error.detail)),
          stateErrors: errors.map((e) => e.detail),
          destroyedByEngine,
        },
        null,
        2,
      ),
    );
  } finally {
    lease.release?.();
    renderValue(await renderer.dispose());
    owner.dispose?.();
    target?.destroy();
    probe.destroy?.();
    await server.close();
  }
});
