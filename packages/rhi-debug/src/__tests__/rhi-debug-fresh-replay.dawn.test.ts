/// <reference types="@webgpu/types" />

import type { RhiDevice, RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { decodeTape } from '../protocol/codec';
import { readbackTexturePixels } from '../readback';
import {
  type CreateShaderModuleFn,
  type DebugRhiInstance,
  wrap,
  wrapCreateShaderModule,
} from '../recorder';
import { assembleTape } from '../recorder/assemble';
import { openReplay, type ReplayBackend } from '../replay/session';
import { runQuerySetReplayFixture } from './query-set-replay-fixture';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: CreateShaderModuleFn;
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';
const WIDTH = 32;
const HEIGHT = 32;

function normalizedPixelDelta(left: Uint8Array, right: Uint8Array): number {
  if (left.byteLength !== right.byteLength || left.byteLength === 0) return 1;
  let total = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    total += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return total / (left.byteLength * 255);
}

const VERTEX_SHADER = `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(0.0, 0.7), vec2<f32>(-0.7, -0.7), vec2<f32>(0.7, -0.7));
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.8, 0.2, 1.0);
}`;

async function loadDawn(): Promise<DawnPack> {
  return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
}

async function makeRecording(pack: DawnPack): Promise<{
  readonly recorder: DebugRhiInstance;
  readonly device: RhiDevice;
  readonly texture: import('@forgeax/engine-rhi').Texture;
}> {
  const recorder = wrap(pack.rhi);
  const createShaderModule = wrapCreateShaderModule(pack.createShaderModule, recorder);
  const adapter = await recorder.requestAdapter();
  expect(adapter.ok).toBe(true);
  if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
  const deviceResult = await adapter.value.requestDevice();
  expect(deviceResult.ok).toBe(true);
  if (!deviceResult.ok) throw new Error(`Dawn device admission failed: ${deviceResult.error.code}`);
  const device = deviceResult.value;
  const rawDevice =
    (device as RhiDevice & { readonly _realDevice?: RhiDevice })._realDevice ?? device;
  const armed = recorder.arm(1);
  expect(armed.ok).toBe(true);
  if (!armed.ok) throw new Error(armed.error.hint);

  const textureResult = device.createTexture({
    size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: 0x11,
  });
  expect(textureResult.ok).toBe(true);
  if (!textureResult.ok) throw new Error(textureResult.error.hint);
  const texture = textureResult.value;
  const viewResult = device.createTextureView(texture, {});
  expect(viewResult.ok).toBe(true);
  if (!viewResult.ok) throw new Error(viewResult.error.hint);
  const vertex = await createShaderModule(rawDevice, { code: VERTEX_SHADER });
  expect(vertex.ok).toBe(true);
  if (!vertex.ok) throw new Error(vertex.error.hint);
  const fragment = await createShaderModule(rawDevice, { code: FRAGMENT_SHADER });
  expect(fragment.ok).toBe(true);
  if (!fragment.ok) throw new Error(fragment.error.hint);
  const bindGroupLayout = device.createBindGroupLayout({ entries: [] });
  expect(bindGroupLayout.ok).toBe(true);
  if (!bindGroupLayout.ok) throw new Error(bindGroupLayout.error.hint);
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout.value] });
  expect(pipelineLayout.ok).toBe(true);
  if (!pipelineLayout.ok) throw new Error(pipelineLayout.error.hint);
  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout.value,
    vertex: { module: vertex.value, entryPoint: 'main', buffers: [] },
    fragment: { module: fragment.value, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  } as never);
  expect(pipeline.ok).toBe(true);
  if (!pipeline.ok) throw new Error(pipeline.error.hint);
  const encoderResult = device.createCommandEncoder({});
  expect(encoderResult.ok).toBe(true);
  if (!encoderResult.ok) throw new Error(encoderResult.error.hint);
  encoderResult.value.pushDebugGroup('frame');
  const pass = encoderResult.value.beginRenderPass({
    colorAttachments: [
      {
        view: viewResult.value,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  } as never);
  pass.setPipeline(pipeline.value);
  pass.pushDebugGroup('outer');
  pass.pushDebugGroup('inner');
  pass.draw(3, 1, 0, 0);
  pass.popDebugGroup();
  pass.popDebugGroup();
  pass.end();
  encoderResult.value.popDebugGroup();
  const command = encoderResult.value.finish();
  expect(command.ok).toBe(true);
  if (!command.ok) throw new Error(command.error.hint);
  const submitted = device.queue.submit([command.value]);
  expect(submitted.ok).toBe(true);
  if (!submitted.ok) throw new Error(submitted.error.hint);
  await device.queue.onSubmittedWorkDone();
  return { recorder, device, texture };
}

describe.skipIf(SKIP_DAWN)('RHI debug v7 fresh-device evidence', () => {
  it('records, encodes, strictly decodes, and replays pixels through nested debug groups on a fresh Dawn device', async () => {
    const pack = await loadDawn();
    const recording = await makeRecording(pack);
    const baseline = await readbackTexturePixels(
      recording.device,
      recording.texture,
      WIDTH,
      HEIGHT,
    );
    recording.recorder.onFrameEnd();
    const assembled = assembleTape(recording.recorder);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error(assembled.error.hint);
    const decoded = decodeTape(assembled.value.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.hint);
    expect(decoded.value.header.formatVersion).toBe(7);
    expect(decoded.value.events.some((event) => event.kind === 'draw')).toBe(true);

    const replayAdapter = await pack.rhi.requestAdapter();
    expect(replayAdapter.ok).toBe(true);
    if (!replayAdapter.ok)
      throw new Error(`fresh Dawn adapter failed: ${replayAdapter.error.code}`);
    const replayDevice = await replayAdapter.value.requestDevice();
    expect(replayDevice.ok).toBe(true);
    if (!replayDevice.ok) throw new Error(`fresh Dawn device failed: ${replayDevice.error.code}`);
    const backend: ReplayBackend = {
      device: replayDevice.value,
      createShaderModule: pack.createShaderModule,
    };
    const session = await openReplay(decoded.value, backend);
    expect(session.ok).toBe(true);
    if (!session.ok) throw new Error(session.error.hint);
    const inspection = await session.value.inspectWork(0, ['pixels']);
    expect(
      inspection.ok,
      inspection.ok
        ? undefined
        : `${inspection.error.code}: ${JSON.stringify(inspection.error.detail)}`,
    ).toBe(true);
    if (!inspection.ok) throw new Error(inspection.error.hint);
    const replayPixels = inspection.value.attachment?.bytes;
    expect(replayPixels).toBeDefined();
    if (replayPixels === undefined) throw new Error('fresh replay did not return attachment bytes');
    expect(inspection.value.attachment?.provenance.selectedWorkIndex).toBe(0);
    expect(inspection.value.attachment?.provenance.resourceId).toBeDefined();
    expect(normalizedPixelDelta(baseline, replayPixels)).toBeLessThanOrEqual(0.01);
    expect((await session.value.dispose()).ok).toBe(true);
  }, 60_000);

  it('captures and replays an occlusion QuerySet with an eight-byte readback', async () => {
    const pack = await loadDawn();
    const recorder = wrap(pack.rhi);
    const recordingShaderModule = wrapCreateShaderModule(pack.createShaderModule, recorder);
    const adapter = await recorder.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) throw new Error(`QuerySet Dawn adapter failed: ${adapter.error.code}`);
    const deviceResult = await adapter.value.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok)
      throw new Error(`QuerySet Dawn device failed: ${deviceResult.error.code}`);
    const armed = recorder.arm(1);
    expect(armed.ok).toBe(true);
    if (!armed.ok) throw new Error(armed.error.hint);
    const evidence = await runQuerySetReplayFixture({
      runner: 'dawn',
      device: deviceResult.value,
      createShaderModule: recordingShaderModule,
      replayCreateShaderModule: pack.createShaderModule,
      finishCapture: async () => {
        recorder.onFrameEnd();
        const assembled = assembleTape(recorder);
        if (!assembled.ok) throw new Error(assembled.error.hint);
        return assembled.value;
      },
      createFreshDevice: async () => {
        const freshAdapter = await pack.rhi.requestAdapter();
        if (!freshAdapter.ok) throw new Error(freshAdapter.error.hint);
        const freshDevice = await freshAdapter.value.requestDevice();
        if (!freshDevice.ok) throw new Error(freshDevice.error.hint);
        return freshDevice.value;
      },
    });
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
