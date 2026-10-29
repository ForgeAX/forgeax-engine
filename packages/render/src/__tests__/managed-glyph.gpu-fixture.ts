import { World } from '@forgeax/engine-ecs';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { loadRhiPack } from '../assembly/backend-contract';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { samplerContribution } from '../assets/asset-decoders';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera, MeshFilter, MeshRenderer } from '../components';
import { GlyphText } from '../components/glyph-text';
import { createRenderPublisher } from '../publication/publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';

/** Font and atlas edits reach native Glyph drawing through local and serialized publications. */
export async function verifyRuntimeGlyph(mode: 'local' | 'worker', url: string) {
  let device: GPUDevice | undefined,
    target: GPUTexture | undefined,
    format: GPUTextureFormat = 'rgba8unorm';
  const failures: unknown[] = [];
  const context = {
    configure(descriptor: GPUCanvasConfiguration) {
      device = descriptor.device;
      format = descriptor.format;
      device.addEventListener('uncapturederror', (event) => failures.push(event.error));
      target?.destroy();
      target = device.createTexture({
        size: [64, 64],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: descriptor.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      if (target === undefined) throw new Error('Missing target');
      return target;
    },
    unconfigure() {},
  };
  const identity = { source: 'native-glyph', epoch: 1 };
  let lose: (() => void) | undefined;
  const implementation = await createRenderer(
    { width: 64, height: 64, getContext: (kind: string) => (kind === 'webgpu' ? context : null) },
    mode === 'worker' ? { publicationSource: identity } : {},
    { shaderManifestUrl: url },
    loadRhiPack(webgpu, {
      deviceLost: () =>
        new Promise((resolve) => {
          lose = () => resolve({ reason: 'unknown', message: 'native Glyph recovery regression' });
        }),
    }),
  );
  implementation.onError((error) => failures.push(error));
  const initialized = await implementation.initialization;
  assert(initialized.ok, initialized.ok ? undefined : JSON.stringify(initialized.error));
  const renderer = exposeRenderer(implementation);
  const assets = implementation.assetRegistry,
    world = new World({ assets });
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  registerPropagateTransforms(world);
  const attached = mode === 'local' ? renderer.attach(world) : undefined;
  if (attached !== undefined) assert(attached.ok);
  const lease = attached?.value;
  const publisher = mode === 'worker' ? createRenderPublisher(world, assets, identity) : undefined;
  const atlas = assets
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      mips: { kind: 'none' },
      data: new Uint8Array([255, 255, 255, 255]),
    })
    .unwrap();
  const sampler = assets
    .create({ kind: 'sampler', minFilter: 'nearest', magFilter: 'nearest' })
    .unwrap();
  const metric = (width: number) => ({
    advance: width,
    bearingX: 0,
    bearingY: 0,
    size: { w: width, h: 1 },
    region: { x: 0, y: 0, w: 1, h: 1 },
  });
  const font = assets
    .create({
      kind: 'font',
      atlas,
      sampler,
      glyphs: { 65: metric(0.5) },
      common: {
        lineHeight: 1,
        base: 0,
        distanceRange: 1,
        pxRange: 1,
        atlasWidth: 1,
        atlasHeight: 1,
      },
    })
    .unwrap();
  const label = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: GlyphText,
        data: { fontHandle: font, text: 'A', fontSize: 1, color: [1, 0, 0, 1] },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0.5, 0.5, 5] } },
      {
        component: Camera,
        data: {
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
          near: 0.1,
          far: 10,
          aspect: 1,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  let readyFrames = 0;
  const read = async () => {
    for (let i = 0; i < 10; i++) {
      world.update(1 / 60).unwrap();
      await completeReadyFrame(async () => {
        const candidate = publisher?.prepare(readyFrames / 60).unwrap();
        const packet = candidate === undefined ? undefined : structuredClone(candidate.packet);
        candidate?.accept();
        const request =
          packet !== undefined
            ? { publication: encodeRenderPublication(packet) }
            : (() => {
                assert(lease);
                return { leases: [lease], camera: { lease }, environment: { lease } };
              })();
        const result = renderer.draw(request);
        assert(
          result.ok,
          result.ok ? undefined : `${JSON.stringify(result.error)}: ${JSON.stringify(failures)}`,
        );
        const receipt = result.value;
        const complete = await receipt.completed;
        assert(complete.ok);
        if (packet !== undefined)
          publisher
            ?.recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
            .unwrap();
        return receipt;
      });
      readyFrames++;
    }
    assert(device !== undefined && target !== undefined);
    const buffer = device.createBuffer({
      size: 64 * 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [64, 64]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(buffer.getMappedRange());
    const samples = [24, 40].map((x) => {
      const offset = 32 * 256 + x * 4;
      return [
        pixels[offset + (format.startsWith('bgra') ? 2 : 0)] ?? NaN,
        pixels[offset + 1] ?? NaN,
        pixels[offset + (format.startsWith('bgra') ? 0 : 2)] ?? NaN,
      ];
    });
    buffer.unmap();
    buffer.destroy();
    return samples;
  };
  const color = (actual: number[] | undefined, expected: number[]) => {
    assert(actual);
    for (let i = 0; i < 3; i++)
      expect(Math.abs((actual[i] ?? NaN) / 255 - (expected[i] ?? NaN))).toBeLessThanOrEqual(0.05);
  };
  try {
    const initial = await read();
    color(initial[0], [1, 0, 0]);
    color(initial[1], [0, 0, 0]);
    assets.update(font, { glyphs: { 65: metric(1) } }).unwrap();
    const widened = await read();
    color(widened[0], [1, 0, 0]);
    color(widened[1], [1, 0, 0]);
    assets.update(atlas, { data: new Uint8Array([0, 0, 0, 255]) }).unwrap();
    const empty = await read();
    color(empty[0], [0, 0, 0]);
    color(empty[1], [0, 0, 0]);
    assets.update(atlas, { data: new Uint8Array([255, 255, 255, 255]) }).unwrap();
    const restored = await read();
    color(restored[0], [1, 0, 0]);
    color(restored[1], [1, 0, 0]);
    expect(failures).toEqual([]);
    assert(lose);
    lose();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    const recovered = await renderer.recover();
    assert(recovered.ok, recovered.ok ? undefined : JSON.stringify(recovered.error));
    const recovery = await read();
    color(recovery[0], [1, 0, 0]);
    color(recovery[1], [1, 0, 0]);
    world.set(label, GlyphText, { color: [0, 1, 0, 1] }).unwrap();
    const tinted = await read();
    color(tinted[0], [0, 1, 0]);
    color(tinted[1], [0, 1, 0]);
    expect(readyFrames).toBe(60);
    expect(failures).toMatchObject([
      {
        code: 'device-lost',
        hint: 'device-lost reason: unknown; message: native Glyph recovery regression',
      },
    ]);
    expect(world.hasComponent(label, MeshFilter)).toBe(false);
    expect(world.hasComponent(label, MeshRenderer)).toBe(false);
  } finally {
    publisher?.dispose();
    assert((await renderer.dispose()).ok);
    target?.destroy();
  }
}
