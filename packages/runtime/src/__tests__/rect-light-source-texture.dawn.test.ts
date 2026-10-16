import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { Camera, Materials, MeshFilter, MeshRenderer, RectAreaLight } from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type FrameModel,
  halfToFloat,
  openReplay,
  type ReplaySession,
  replayDeviceRequest,
  type V7Tape as Tape,
  type WorkEntry,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
const SIZE = 64;
const METADATA_SENTINEL = 0xffffffff;
const LIGHT_Y = 1.5;
const HALF_WIDTH = 1.5;
const HALF_HEIGHT = 0.6;
const DOWN: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

function panel(): TextureAsset {
  const data = new Uint8Array(64 * 32 * 4);
  for (let i = 0; i < 64 * 32; i++) {
    data.set(i % 64 < 32 ? [230, 40, 30, 255] : [40, 210, 60, 255], i * 4);
  }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 64, height: 32 } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
    data,
  };
}

function descriptorField(model: FrameModel, id: string, field: string): unknown {
  const descriptor = model.resources.find((resource) => resource.resourceId === id)?.descriptor;
  return typeof descriptor === 'object' && descriptor !== null && !Array.isArray(descriptor)
    ? (descriptor as Record<string, unknown>)[field]
    : undefined;
}

/** The shared light-texture array: a 32-layer 2d-array view over a 9-mip rgba8unorm texture. */
function lightTextureId(model: FrameModel, work: WorkEntry): string {
  const matches = work.bindings.flatMap((binding) => {
    if (binding.resourceKind !== 'textureView' || binding.resourceId === null) return [];
    const view = descriptorField(model, binding.resourceId, 'desc') as
      | { arrayLayerCount?: number; dimension?: string }
      | undefined;
    const source = descriptorField(model, binding.resourceId, 'sourceHandleId');
    if (view?.dimension !== '2d-array' || view.arrayLayerCount !== 32) return [];
    if (typeof source !== 'string') return [];
    const texture = descriptorField(model, source, 'desc') as
      | { format?: string; mipLevelCount?: number }
      | undefined;
    return texture?.format === 'rgba8unorm' && texture.mipLevelCount === 9 ? [source] : [];
  });
  expect(matches).toHaveLength(1);
  return matches[0] as string;
}

/** Scan the lighting work's buffers for the one DirectLightSlot matching the rect light. */
async function rectSlotMetadata(replay: ReplaySession, work: WorkEntry): Promise<number> {
  const found: number[] = [];
  const buffers = new Set(
    work.bindings.flatMap((binding) =>
      binding.resourceKind === 'buffer' && binding.resourceId !== null ? [binding.resourceId] : [],
    ),
  );
  for (const id of buffers) {
    const bytes = (await replay.readResourceAtWork(id, work.workIndex)).unwrap().bytes;
    const floats = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 4),
    );
    const words = new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
    for (let base = 0; base + 20 <= floats.length; base += 4) {
      const near = (index: number, value: number) =>
        Math.abs((floats[base + index] ?? Number.NaN) - value) < 1e-4;
      if (
        near(0, 0) &&
        near(1, LIGHT_Y) &&
        near(2, 0) &&
        near(7, HALF_WIDTH) &&
        near(11, HALF_HEIGHT)
      ) {
        found.push(words[base + 19] ?? -1);
      }
    }
  }
  expect(found).toHaveLength(1);
  return found[0] as number;
}

function rgbaAt(bytes: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0];
}

/** Mean HDR rgb over the rows [24, 40) of columns [x0, x1) of an rgba16float image. */
function hdrMean(bytes: Uint8Array, bytesPerRow: number, x0: number, x1: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = 24; y < 40; y++)
    for (let x = x0; x < x1; x++) {
      for (let c = 0; c < 3; c++)
        sum[c] += halfToFloat(view.getUint16(y * bytesPerRow + x * 8 + c * 2, true));
      count++;
    }
  return sum.map((value) => value / count);
}

const asymmetry = (left: number[], right: number[]) =>
  Math.log((left[0] ?? 0) / Math.max(left[1] ?? 0, 1e-4)) -
  Math.log((right[0] ?? 0) / Math.max(right[1] ?? 0, 1e-4));

async function openFreshReplay(tape: Tape): Promise<{ replay: ReplaySession; raw: GPUDevice }> {
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(device);
  if (!raw) throw new Error('missing replay device');
  raw.pushErrorScope('validation');
  const replay = (
    await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  return { replay, raw };
}

it('captures the RectAreaLight source texture upload, slot metadata and lit pixels', {
  timeout: 180_000,
}, async () => {
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
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const { renderer } = host;
  const world = new World();
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const floor = world.allocSharedRef('MeshAsset', createPlaneGeometry(8, 8).unwrap());
    const material = Materials.standard({ baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.6 });
    world
      .spawn(
        { component: Transform, data: { quat: DOWN } },
        { component: MeshFilter, data: { assetHandle: floor } },
        {
          component: MeshRenderer,
          data: { materials: [world.allocSharedRef('MaterialAsset', material)] },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 4, 0], quat: DOWN } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20 } },
      )
      .unwrap();
    const texture = world.allocSharedRef('TextureAsset', panel());
    const lightData = {
      width: HALF_WIDTH * 2,
      height: HALF_HEIGHT * 2,
      intensity: 6,
      range: 10,
    };
    // Front (+Z) rotated to -Y faces the floor; local +X stays world +X.
    const light = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, LIGHT_Y, 0], quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
        },
        { component: RectAreaLight, data: lightData },
      )
      .unwrap();

    const capture = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      renderValue(renderer.requestObservation?.(['linear-hdr']));
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = renderValue(
        renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
      );
      renderValue(await receipt.completed);
      const live = renderValue(
        await renderer.observe(receipt, { include: ['linear-hdr'] }),
      ).observations?.find((item) => item.domain === 'linear-hdr');
      (await recorder.frameBoundary()).unwrap();
      if (live === undefined) throw new Error('missing live HDR pixels');
      const tape = decodeTape((await pending).unwrap().bytes).unwrap();
      const model = buildFrameModel(tape);
      const lighting = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) =>
          shader.source?.includes('rectSourceTextureRadiance'),
        ),
      );
      expect(lighting.length).toBeGreaterThan(0);
      return { tape, model, work: lighting[0] as WorkEntry, live };
    };
    const inspect = async (frame: Awaited<ReturnType<typeof capture>>) => {
      const { replay, raw } = await openFreshReplay(frame.tape);
      const pixels = (await replay.inspectWork(frame.work.workIndex, ['pixels'])).unwrap()
        .attachment;
      if (!pixels) throw new Error('missing lighting readback');
      expect(pixels.format).toBe('rgba16float');
      const metadata = await rectSlotMetadata(replay, frame.work);
      const left = hdrMean(pixels.bytes, SIZE * 8, 8, 24);
      const right = hdrMean(pixels.bytes, SIZE * 8, 40, 56);
      let liveDifference = 0;
      const liveView = new DataView(frame.live.bytes.buffer, frame.live.bytes.byteOffset);
      const replayView = new DataView(pixels.bytes.buffer, pixels.bytes.byteOffset);
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE * 4; x++) {
          const a = halfToFloat(
            liveView.getUint16(y * frame.live.metadata.bytesPerRow + x * 2, true),
          );
          const b = halfToFloat(replayView.getUint16(y * SIZE * 8 + x * 2, true));
          liveDifference = Math.max(liveDifference, Math.abs(a - b) / Math.max(1, Math.abs(a)));
        }
      return { replay, raw, metadata, left, right, liveDifference };
    };

    for (let i = 0; i < 4; i++) {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      renderValue(
        await renderValue(
          renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
        ).completed,
      );
    }

    // Bind the source inside the captured frame so its upload is part of the tape.
    world.set(light, RectAreaLight, { ...lightData, sourceTexture: texture }).unwrap();
    const textured = await capture();
    const arrayId = lightTextureId(textured.model, textured.work);
    const uploads = textured.model.commands.filter((command) => {
      const destination = (command.params as { destination?: { textureHandleId?: string } } | null)
        ?.destination;
      return command.kind === 'writeTexture' && destination?.textureHandleId === arrayId;
    });
    const mips = uploads.map(
      (command) => (command.params as { destination: { mipLevel: number } }).destination.mipLevel,
    );
    expect([...new Set(mips)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    const lit = await inspect(textured);
    try {
      expect(lit.metadata).not.toBe(METADATA_SENTINEL);
      expect(lit.metadata).toBeLessThan(32);
      const slice = { arrayLayer: lit.metadata };
      const mip0 = (
        await lit.replay.readResourceAtWork(arrayId, textured.work.workIndex, {
          mipLevel: 0,
          ...slice,
        })
      ).unwrap();
      expect([mip0.width, mip0.height]).toEqual([256, 256]);
      const red = rgbaAt(mip0.bytes, 256, 64, 128);
      const green = rgbaAt(mip0.bytes, 256, 192, 128);
      expect(red[0]).toBeGreaterThan(150);
      expect(red[1]).toBeLessThan(60);
      expect(green[1]).toBeGreaterThan(150);
      expect(green[0]).toBeLessThan(60);
      // The 1x1 tail averages both halves; a missing mip chain reads black.
      const tail = (
        await lit.replay.readResourceAtWork(arrayId, textured.work.workIndex, {
          mipLevel: 8,
          ...slice,
        })
      ).unwrap();
      const average = rgbaAt(tail.bytes, 1, 0, 0);
      expect(average[0]).toBeGreaterThan(60);
      expect(average[1]).toBeGreaterThan(60);
      expect(asymmetry(lit.left, lit.right)).toBeGreaterThan(0.3);
      expect(lit.liveDifference).toBeLessThanOrEqual(0.01);
      expect(await lit.raw.popErrorScope()).toBeNull();
    } finally {
      (await lit.replay.dispose()).unwrap();
      lit.raw.destroy();
    }

    // Falsifier: removing the source restores the sentinel and a balanced floor.
    world.set(light, RectAreaLight, { ...lightData, sourceTexture: 0 as never }).unwrap();
    const uniform = await capture();
    const plain = await inspect(uniform);
    try {
      expect(plain.metadata).toBe(METADATA_SENTINEL);
      expect(Math.abs(asymmetry(plain.left, plain.right))).toBeLessThan(0.05);
      expect(plain.liveDifference).toBeLessThanOrEqual(0.01);
      expect(await plain.raw.popErrorScope()).toBeNull();
    } finally {
      (await plain.replay.dispose()).unwrap();
      plain.raw.destroy();
    }
    expect(errors).toEqual([]);
  } finally {
    lease.dispose();
    renderValue(await renderer.dispose());
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
