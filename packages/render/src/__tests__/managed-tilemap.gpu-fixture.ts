import { World } from '@forgeax/engine-ecs';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { loadRhiPack } from '../assembly/backend-contract';
import { createRenderer } from '../assembly/factory';
import { CAMERA_PROJECTION_ORTHOGRAPHIC, Camera } from '../components';
import { Tilemap } from '../components/tilemap';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';

/** Complete native rendering and Worker pack/clone/admission path; exactly 60 ready frames. */
export async function verifyRuntimeTilemap(
  mode: 'local' | 'worker',
  sortScope: 0 | 1,
  url: string,
  save?: (name: string, bytes: Uint8Array) => Promise<void>,
) {
  let device: GPUDevice | undefined,
    target: GPUTexture | undefined,
    format: GPUTextureFormat = 'rgba8unorm';
  const failures: unknown[] = [];
  let lose: (() => void) | undefined;
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
  const identity = { source: 'native-tilemap', epoch: 1 };
  const recorder = attachRecorder(webgpu).unwrap();
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: (kind: string) => (kind === 'webgpu' ? context : null) },
    { ...(mode === 'worker' ? { publicationSource: identity } : {}) },
    { shaderManifestUrl: url },
    loadRhiPack(
      { ...recorder.backend },
      {
        resolveSurfaceDevice: (device) =>
          ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        deviceLost: () =>
          new Promise((resolve) => {
            lose = () => {
              recorder.deviceLost();
              resolve({ reason: 'unknown', message: 'native Tilemap recovery' });
            };
          }),
      },
    ),
  );
  renderer.onError((error) => {
    if (error.code !== 'device-lost') failures.push(error);
  });
  const initialized = await renderer.initialization;
  assert(initialized.ok);
  const assets = renderer.assetRegistry,
    world = new World({ assets });
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
      shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
      mips: { kind: 'none' },
      data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    })
    .unwrap();
  const tileset = assets
    .create({
      kind: 'tileset',
      atlases: [atlas],
      tileWidth: 1,
      tileHeight: 1,
      columns: 2,
      rows: 1,
      regions: [
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 1, y: 0, width: 1, height: 1 },
      ],
      tiles: [{ regionIndex: 0 }, { regionIndex: 1 }],
    })
    .unwrap();
  const map = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Tilemap,
        data: {
          tileset,
          cols: 2,
          rows: 1,
          chunkSize: 1,
          tileSize: [1, 1],
          tiles: [1, 2],
          sortScope,
        },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [1, 0.5, 5] } },
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
      const capture = save !== undefined && readyFrames === 9 ? recorder.captureFrame() : undefined;
      if (capture !== undefined) (await recorder.frameBoundary()).unwrap();
      await completeReadyFrame(async () => {
        const candidate = publisher?.prepare(readyFrames / 60).unwrap();
        const packet = candidate === undefined ? undefined : structuredClone(candidate.packet);
        candidate?.accept();
        const request =
          packet !== undefined
            ? { publication: packet }
            : (() => {
                assert(lease);
                return { leases: [lease] as const, camera: { lease }, environment: { lease } };
              })();
        const result = renderer.draw(request);
        assert(
          result.ok,
          result.ok ? undefined : `${result.error.message}: ${JSON.stringify(failures)}`,
        );
        const receipt = result.value;
        assert(receipt);
        const complete = await receipt.completed;
        assert(complete.ok);
        if (packet !== undefined)
          publisher?.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
        return receipt;
      });
      if (capture !== undefined) {
        (await recorder.frameBoundary()).unwrap();
        const tape = (await capture).unwrap();
        await save?.('initial.rhitape', tape.bytes);
        const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
        await save?.('initial-frame.json', new TextEncoder().encode(JSON.stringify(model)));
      }
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
    const samples = [16, 24, 48].map((x) => {
      const offset = 32 * 256 + x * 4;
      return [
        pixels[offset + (format.startsWith('bgra') ? 2 : 0)] ?? -1,
        pixels[offset + 1] ?? -1,
        pixels[offset + (format.startsWith('bgra') ? 0 : 2)] ?? -1,
      ];
    });
    buffer.unmap();
    buffer.destroy();
    if (save !== undefined)
      await save(`samples-${readyFrames}.json`, new TextEncoder().encode(JSON.stringify(samples)));
    return samples;
  };
  const color = (actual: number[] | undefined, expected: number[]) => {
    assert(actual);
    for (const [i, value] of actual.entries()) {
      const target = expected[i];
      assert(target !== undefined);
      expect(Math.abs(value / 255 - target)).toBeLessThanOrEqual(0.05);
    }
  };
  try {
    const initial = await read();
    color(initial[0], [1, 0, 0]);
    color(initial[2], [0, 1, 0]);
    assets
      .update(tileset, {
        regions: [
          { x: 1, y: 0, width: 1, height: 1 },
          { x: 1, y: 0, width: 1, height: 1 },
        ],
      })
      .unwrap();
    const changed = await read();
    color(changed[0], [0, 1, 0]);
    color(changed[2], [0, 1, 0]);
    assets.update(atlas, { data: new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255]) }).unwrap();
    const blue = await read();
    color(blue[0], [0, 0, 1]);
    color(blue[2], [0, 0, 1]);
    world.set(map, Tilemap, { tiles: [0, 2] }).unwrap();
    const removed = await read();
    color(removed[0], [0, 0, 0]);
    color(removed[2], [0, 0, 1]);
    lose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recovered = await renderer.recover();
    assert(recovered.ok, recovered.ok ? undefined : recovered.error.message);
    const restored = await read();
    color(restored[0], [0, 0, 0]);
    color(restored[2], [0, 0, 1]);
    world.set(map, Tilemap, { tileSize: [0.5, 1] }).unwrap();
    const resized = await read();
    color(resized[1], [0, 0, 1]);
    color(resized[2], [0, 0, 0]);
    expect(readyFrames).toBe(60);
    expect(failures).toEqual([]);
    expect(world.get(map, Tilemap).unwrap().tileset).toBe(tileset);
  } finally {
    publisher?.dispose();
    const disposed = renderer.dispose();
    assert(disposed.ok);
    target?.destroy();
  }
}
