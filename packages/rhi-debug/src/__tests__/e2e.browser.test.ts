/// <reference types="@webgpu/types" />

import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { decodeTape } from '../protocol/codec';
import type { Tape } from '../protocol/types';
import { attachRecorder, type RecordableBackend } from '../recorder/session';
import { openReplay } from '../replay/session';
import { runQuerySetReplayFixture } from './query-set-replay-fixture';

const GPU_AVAILABLE = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
const SIZE = 64;

const VERTEX_SHADER = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-0.8, -0.8),
    vec2<f32>(0.8, -0.8),
    vec2<f32>(0.0, 0.8),
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;

const FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

@fragment
fn main() -> @location(0) vec4<f32> {
  return textureSample(sourceTexture, sourceSampler, vec2<f32>(0.5, 0.5));
}`;

interface CapturedBrowserTape {
  readonly backend: RecordableBackend;
  readonly device: RhiDevice;
  readonly tape: Tape;
}

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
  label: string,
): T {
  if (result.ok) return result.value;
  const error = result.error as {
    readonly code?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  throw new Error(
    `${label}: ${String(error.code ?? 'unknown')} ${String(error.hint ?? '')} ${JSON.stringify(error.detail ?? null)}`,
  );
}

async function loadBackend(): Promise<RecordableBackend> {
  const backend = await import('@forgeax/engine-rhi-webgpu');
  return backend as unknown as RecordableBackend;
}

async function captureBrowserTape(): Promise<CapturedBrowserTape> {
  const backend = await loadBackend();
  const attachment = must(attachRecorder(backend), 'attachRecorder');
  const adapter = must(await attachment.backend.rhi.requestAdapter(), 'requestAdapter');
  const device = must(await adapter.requestDevice(), 'requestDevice');
  const capture = attachment.captureFrame();
  must(await attachment.frameBoundary(), 'capture snapshot boundary');

  const renderTarget = must(
    device.createTexture({
      size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x11,
    }),
    'create render target',
  );
  const renderTargetView = must(
    device.createTextureView(renderTarget, {}),
    'create render target view',
  );
  const sourceTexture = must(
    device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: 0x06,
    }),
    'create source texture',
  );
  const sourceView = must(device.createTextureView(sourceTexture, {}), 'create source view');
  const sampler = must(device.createSampler({}), 'create sampler');
  const vertex = must(
    await attachment.backend.createShaderModule(device, { code: VERTEX_SHADER }),
    'create vertex shader',
  );
  const fragment = must(
    await attachment.backend.createShaderModule(device, { code: FRAGMENT_SHADER }),
    'create fragment shader',
  );
  const bindGroupLayout = must(
    device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x02, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: 0x02, sampler: { type: 'filtering' } },
      ],
    }),
    'create bind group layout',
  );
  const bindGroup = must(
    device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: sourceView } },
        { binding: 1, resource: { kind: 'sampler', value: sampler } },
      ],
    } as never),
    'create bind group',
  );
  const pipelineLayout = must(
    device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    'create pipeline layout',
  );
  const pipeline = must(
    device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: vertex, entryPoint: 'main', buffers: [] },
      fragment: { module: fragment, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as never),
    'create render pipeline',
  );

  const textureData = new Uint8Array([255, 32, 16, 255]);
  must(
    device.queue.writeTexture(
      { texture: sourceTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as never,
      textureData,
      { offset: 0, bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    ),
    'write source texture',
  );
  const encoder = must(device.createCommandEncoder({}), 'create command encoder');
  encoder.pushDebugGroup('frame');
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: renderTargetView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  } as never);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup, []);
  pass.pushDebugGroup('outer');
  pass.pushDebugGroup('inner');
  pass.draw(3, 1, 0, 0);
  pass.popDebugGroup();
  pass.popDebugGroup();
  pass.end();
  encoder.popDebugGroup();
  const command = must(encoder.finish(), 'finish command encoder');
  must(device.queue.submit([command]), 'submit command buffer');
  await device.queue.onSubmittedWorkDone();
  must(await attachment.frameBoundary(), 'capture recording boundary');
  const encoded = must(await capture, 'capture frame');
  const decoded = must(decodeTape(encoded.bytes), 'strict v7 decode');
  await attachment.dispose();
  return { backend, device, tape: decoded };
}

function hasVisibleRgb(pixels: Uint8Array): boolean {
  for (let index = 0; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) > 4 || (pixels[index + 1] ?? 0) > 4 || (pixels[index + 2] ?? 0) > 4) {
      return true;
    }
  }
  return false;
}

describe.skipIf(!GPU_AVAILABLE)('M4 browser capture and replay gate', () => {
  it('captures one raw v7 tape, indexes binding/work state, replays it on a fresh device, and reads a lit RT', async () => {
    const captured = await captureBrowserTape();
    const model = buildFrameModel(captured.tape);
    expect(captured.tape.header.formatVersion).toBe(7);
    expect(captured.tape.events.length).toBeGreaterThan(0);
    expect(model.works.some((work) => work.kind === 'draw' || work.kind === 'drawIndexed')).toBe(
      true,
    );
    expect(captured.tape.events.some((event) => event.kind === 'setBindGroup')).toBe(true);
    expect(model.works.length).toBeGreaterThan(0);

    const adapter = must(await captured.backend.rhi.requestAdapter(), 'fresh requestAdapter');
    const freshDevice = must(await adapter.requestDevice(), 'fresh requestDevice');
    const session = must(
      await openReplay(captured.tape, {
        device: freshDevice,
        createShaderModule: captured.backend.createShaderModule,
      }),
      'open fresh replay session',
    );
    const work = must(await session.inspectWork(0, ['bindings', 'pixels']), 'inspect work index 0');
    expect(work.workIndex).toBe(0);
    expect(work.passIndex).toBeGreaterThanOrEqual(0);
    expect(work.attachment?.kind).toBe('texture');
    expect(work.attachment?.width).toBe(SIZE);
    expect(work.attachment?.height).toBe(SIZE);
    expect(work.attachment?.provenance.selectedWorkIndex).toBe(0);
    expect(work.attachment?.provenance.resourceId).toBeDefined();
    expect(work.attachment?.provenance.subresource).toBeNull();
    expect(hasVisibleRgb(work.attachment?.bytes ?? new Uint8Array())).toBe(true);
    await session.dispose();
  }, 60_000);

  it('makes a missing texture binding fail the fresh replay path', async () => {
    const captured = await captureBrowserTape();
    const falsifiedEvents = captured.tape.events.map((event) =>
      event.kind === 'setBindGroup'
        ? { ...event, bindGroupHandleId: 'binding:falsified-texture' }
        : event,
    );
    expect(falsifiedEvents.some((event) => event.kind === 'setBindGroup')).toBe(true);
    const falsifiedTape: Tape = {
      ...captured.tape,
      header: { ...captured.tape.header, eventCount: falsifiedEvents.length },
      events: falsifiedEvents,
    };
    const adapter = must(await captured.backend.rhi.requestAdapter(), 'falsifier requestAdapter');
    const device = must(await adapter.requestDevice(), 'falsifier requestDevice');
    const replay = await openReplay(falsifiedTape, {
      device,
      createShaderModule: captured.backend.createShaderModule,
    });
    if (replay.ok) {
      const result = await replay.value.inspectWork(0, ['pixels']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBeDefined();
      await replay.value.dispose();
    } else {
      expect(replay.error.code).toBeDefined();
    }
  }, 60_000);

  it('captures and replays an occlusion QuerySet with an eight-byte readback', async () => {
    const backend = await loadBackend();
    const attachment = must(attachRecorder(backend), 'attachRecorder query set');
    const adapter = must(await attachment.backend.rhi.requestAdapter(), 'query set requestAdapter');
    const device = must(await adapter.requestDevice(), 'query set requestDevice');
    const capture = attachment.captureFrame();
    must(await attachment.frameBoundary(), 'query set capture snapshot boundary');
    const evidence = await runQuerySetReplayFixture({
      runner: 'browser',
      device,
      createShaderModule: attachment.backend.createShaderModule,
      replayCreateShaderModule: backend.createShaderModule,
      finishCapture: async () => {
        must(await attachment.frameBoundary(), 'query set capture recording boundary');
        return must(await capture, 'query set capture frame');
      },
      createFreshDevice: async () => {
        const freshAdapter = must(await backend.rhi.requestAdapter(), 'query set fresh adapter');
        return must(await freshAdapter.requestDevice(), 'query set fresh device');
      },
    });
    await attachment.dispose();
    expect(evidence, JSON.stringify(evidence.errorReceipts)).toMatchObject({
      status: 'available',
      tapeFormatVersion: 7,
      resolveDestinationOffset: 256,
      originalQueryValues: expect.arrayContaining([expect.any(String), '0']),
      originalResultHalfWords: [15360, 0, 0, 15360, 0, 0, 0, 15360],
      freshQueryValues: ['1', '0'],
      errorReceipts: [],
      deviceLost: null,
    });
    expect(evidence.originalQueryValues[0]).not.toBe('0');
    expect(evidence.originalColorBytes.some((byte) => byte > 0)).toBe(true);
    expect(evidence.eventKinds).toEqual(
      expect.arrayContaining([
        'createQuerySet',
        'beginRenderPass',
        'beginOcclusionQuery',
        'endOcclusionQuery',
        'resolveQuerySet',
        'submit',
        'destroyQuerySet',
      ]),
    );
    expect(evidence.querySetHandleId).toBeDefined();
    expect(evidence.resolveDestinationHandleId).toBeDefined();
  }, 60_000);
});
