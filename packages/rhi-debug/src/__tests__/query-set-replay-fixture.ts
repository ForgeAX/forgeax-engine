/// <reference types="@webgpu/types" />

import type { Buffer, MappedBuffer, RhiDevice } from '@forgeax/engine-rhi';
import { buildFrameModel } from '../frame-model';
import { decodeTape } from '../protocol/codec';
import type { Tape } from '../protocol/types';
import type { CreateShaderModuleFn, EncodedTape } from '../recorder';
import { openReplay } from '../replay/session';

export type QuerySetFixtureRunner = 'browser' | 'dawn';

export interface QuerySetFixtureHost {
  readonly runner: QuerySetFixtureRunner;
  readonly device: RhiDevice;
  readonly createShaderModule: CreateShaderModuleFn;
  readonly replayCreateShaderModule: CreateShaderModuleFn;
  readonly finishCapture: () => Promise<EncodedTape>;
  readonly createFreshDevice: () => Promise<RhiDevice>;
}

export interface QuerySetErrorReceipt {
  readonly operation: string;
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}

export interface QuerySetReplayFixtureEvidence {
  readonly runner: QuerySetFixtureRunner;
  readonly status: 'available' | 'unavailable' | 'failed';
  readonly tapeFormatVersion: number | null;
  readonly querySetHandleId: string | null;
  readonly resolveDestinationHandleId: string | null;
  readonly resolveDestinationOffset: number | null;
  readonly originalQueryValues: readonly string[];
  readonly originalResultHalfWords: readonly number[];
  readonly freshQueryValues: readonly string[];
  readonly originalColorBytes: readonly number[];
  readonly freshColorHalfWords: readonly number[];
  readonly eventKinds: readonly string[];
  readonly errorReceipts: readonly QuerySetErrorReceipt[];
  readonly deviceLost: { readonly reason: string; readonly message: string } | null;
}

const COLOR_WIDTH = 32;
const COLOR_HEIGHT = 32;
const QUERY_RESOLVE_OFFSET = 256;
const QUERY_BYTES = 8;
const QUERY_COUNT = 2;
const QUERY_RESOLVE_BUFFER_SIZE = QUERY_RESOLVE_OFFSET + QUERY_BYTES * QUERY_COUNT;
const READBACK_SIZE = 256;
const BUFFER_USAGE_MAP_READ_COPY_DST = 0x9;
const BUFFER_USAGE_QUERY_RESOLVE_COPY_SRC_STORAGE = 0x284;
const BUFFER_USAGE_COPY_DST_STORAGE = 0x88;
const TEXTURE_USAGE_RENDER_ATTACHMENT_COPY_SRC = 0x11;
const GPU_MAP_MODE_READ = 0x1;

const DRAW_VERTEX_SHADER = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-0.8, -0.8),
    vec2<f32>(0.8, -0.8),
    vec2<f32>(0.0, 0.8),
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;

const DRAW_FRAGMENT_SHADER = /* wgsl */ `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.8, 0.2, 1.0);
}`;

const QUERY_RESULT_FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> queryValues: array<u32>;

@fragment
fn main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let queryIndex = min(u32(position.x), 1u);
  let covered = select(0.0, 1.0, queryValues[queryIndex * 2u] > 0u);
  return vec4<f32>(covered, 0.0, 0.0, 1.0);
}`;

const RESULT_VERTEX_SHADER = /* wgsl */ `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;

class FixtureFailure extends Error {
  readonly receipt: QuerySetErrorReceipt;

  constructor(receipt: QuerySetErrorReceipt) {
    super(`${receipt.operation}: ${receipt.code}`);
    this.name = 'FixtureFailure';
    this.receipt = receipt;
  }
}

function asReceipt(operation: string, error: unknown): QuerySetErrorReceipt {
  const candidate = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  return {
    operation,
    code: typeof candidate.code === 'string' ? candidate.code : 'unknown-error',
    expected:
      typeof candidate.expected === 'string' ? candidate.expected : 'successful RHI operation',
    hint: typeof candidate.hint === 'string' ? candidate.hint : String(error),
    detail: candidate.detail ?? null,
  };
}

function unwrap<T>(
  operation: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw new FixtureFailure(asReceipt(operation, result.error));
  return result.value;
}

function call(operation: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    throw new FixtureFailure(asReceipt(operation, error));
  }
}

async function shader(
  createShaderModule: CreateShaderModuleFn,
  device: RhiDevice,
  operation: string,
  code: string,
) {
  return unwrap(operation, await createShaderModule(device, { code }));
}

function readBytes(mapped: MappedBuffer, operation: string, size: number): Uint8Array {
  const range = unwrap(`${operation}.getMappedRange`, mapped.getMappedRange(0, size));
  return new Uint8Array(range.slice(0));
}

async function readMappedBuffer(buffer: Buffer, operation: string, size: number) {
  const mapped = unwrap(`${operation}.mapAsync`, await buffer.mapAsync(GPU_MAP_MODE_READ, 0, size));
  const bytes = readBytes(mapped, operation, size);
  call(`${operation}.unmap`, () => mapped.unmap());
  return bytes;
}

function u64Values(bytes: Uint8Array): readonly string[] {
  const values: string[] = [];
  for (let offset = 0; offset + QUERY_BYTES <= bytes.byteLength; offset += QUERY_BYTES) {
    const low = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    const high = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    values.push(((BigInt(high) << 32n) | BigInt(low)).toString());
  }
  return values;
}

function tapeEventKinds(tape: Tape): readonly string[] {
  return [
    ...tape.bootstrap.map((resource) => {
      const create = resource.create as { readonly kind?: unknown };
      return typeof create.kind === 'string' ? create.kind : 'bootstrap';
    }),
    ...tape.events.map((event) => event.kind),
  ];
}

function eventHandle(tape: Tape, kind: string, field: string): string | null {
  const all = [
    ...tape.bootstrap.map((resource) => resource.create as Record<string, unknown>),
    ...tape.events,
  ];
  const event = all.find((candidate) => candidate.kind === kind) as
    | Record<string, unknown>
    | undefined;
  return typeof event?.[field] === 'string' ? event[field] : null;
}

function eventNumber(tape: Tape, kind: string, field: string): number | null {
  const event = tape.events.find((candidate) => candidate.kind === kind) as
    | Record<string, unknown>
    | undefined;
  return typeof event?.[field] === 'number' ? event[field] : null;
}

function freshHalfWords(bytes: Uint8Array): readonly number[] {
  const words = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.min(8, bytes.byteLength / 2));
  return Array.from(words);
}

async function executeFrame(
  device: RhiDevice,
  createShaderModule: CreateShaderModuleFn,
): Promise<{
  readonly queryValues: readonly string[];
  readonly colorBytes: Uint8Array;
  readonly resultHalfWords: readonly number[];
}> {
  const vertex = await shader(
    createShaderModule,
    device,
    'create.vertexShader',
    DRAW_VERTEX_SHADER,
  );
  const fragment = await shader(
    createShaderModule,
    device,
    'create.fragmentShader',
    DRAW_FRAGMENT_SHADER,
  );
  const queryFragment = await shader(
    createShaderModule,
    device,
    'create.queryResultFragmentShader',
    QUERY_RESULT_FRAGMENT_SHADER,
  );
  const resultVertex = await shader(
    createShaderModule,
    device,
    'create.resultVertexShader',
    RESULT_VERTEX_SHADER,
  );
  const drawLayout = unwrap(
    'create.drawBindGroupLayout',
    device.createBindGroupLayout({ entries: [] }),
  );
  const queryLayout = unwrap(
    'create.queryBindGroupLayout',
    device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x2, buffer: { type: 'read-only-storage' } }],
    }),
  );
  const drawPipelineLayout = unwrap(
    'create.drawPipelineLayout',
    device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
  );
  const queryPipelineLayout = unwrap(
    'create.queryPipelineLayout',
    device.createPipelineLayout({ bindGroupLayouts: [queryLayout] }),
  );
  const drawPipeline = unwrap(
    'create.drawPipeline',
    device.createRenderPipeline({
      layout: drawPipelineLayout,
      vertex: { module: vertex, entryPoint: 'main', buffers: [] },
      fragment: { module: fragment, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    } as never),
  );
  const queryPipeline = unwrap(
    'create.queryPipeline',
    device.createRenderPipeline({
      layout: queryPipelineLayout,
      vertex: { module: resultVertex, entryPoint: 'main', buffers: [] },
      fragment: { module: queryFragment, entryPoint: 'main', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    } as never),
  );
  const colorTexture = unwrap(
    'create.colorTexture',
    device.createTexture({
      size: { width: COLOR_WIDTH, height: COLOR_HEIGHT, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT_COPY_SRC,
    }),
  );
  const colorView = unwrap('create.colorView', device.createTextureView(colorTexture, {}));
  const queryTexture = unwrap(
    'create.queryTexture',
    device.createTexture({
      size: { width: QUERY_COUNT, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT_COPY_SRC,
    }),
  );
  const queryView = unwrap('create.queryView', device.createTextureView(queryTexture, {}));
  const querySet = unwrap(
    'create.querySet',
    device.createQuerySet({ type: 'occlusion', count: QUERY_COUNT }),
  );
  const queryResolveBuffer = unwrap(
    'create.queryResolveBuffer',
    device.createBuffer({
      size: QUERY_RESOLVE_BUFFER_SIZE,
      usage: BUFFER_USAGE_QUERY_RESOLVE_COPY_SRC_STORAGE,
      mappedAtCreation: false,
    }),
  );
  const queryStagingBuffer = unwrap(
    'create.queryStagingBuffer',
    device.createBuffer({
      size: READBACK_SIZE,
      usage: BUFFER_USAGE_MAP_READ_COPY_DST,
      mappedAtCreation: false,
    }),
  );
  const colorReadbackBuffer = unwrap(
    'create.colorReadbackBuffer',
    device.createBuffer({
      size: READBACK_SIZE * COLOR_HEIGHT,
      usage: BUFFER_USAGE_MAP_READ_COPY_DST,
      mappedAtCreation: false,
    }),
  );
  const queryGpuResultBuffer = unwrap(
    'create.queryGpuResultBuffer',
    device.createBuffer({
      size: QUERY_BYTES * QUERY_COUNT,
      usage: BUFFER_USAGE_COPY_DST_STORAGE,
      mappedAtCreation: false,
    }),
  );
  const resultReadbackBuffer = unwrap(
    'create.resultReadbackBuffer',
    device.createBuffer({
      size: READBACK_SIZE,
      usage: BUFFER_USAGE_MAP_READ_COPY_DST,
      mappedAtCreation: false,
    }),
  );
  const queryBindGroup = unwrap(
    'create.queryBindGroup',
    device.createBindGroup({
      layout: queryLayout,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: {
              buffer: queryGpuResultBuffer,
              size: QUERY_BYTES * QUERY_COUNT,
            },
          },
        },
      ],
    } as never),
  );
  const encoder = unwrap('create.commandEncoder', device.createCommandEncoder({}));
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: colorView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
    occlusionQuerySet: querySet,
  } as never);
  call('pass.setPipeline', () => pass.setPipeline(drawPipeline));
  call('pass.beginOcclusionQuery.0', () =>
    unwrap('pass.beginOcclusionQuery.0', pass.beginOcclusionQuery(0)),
  );
  call('pass.draw.0', () => pass.draw(3, 1, 0, 0));
  call('pass.endOcclusionQuery.0', () =>
    unwrap('pass.endOcclusionQuery.0', pass.endOcclusionQuery()),
  );
  call('pass.setScissorRect.zero', () => pass.setScissorRect(0, 0, 0, 0));
  call('pass.beginOcclusionQuery.1', () =>
    unwrap('pass.beginOcclusionQuery.1', pass.beginOcclusionQuery(1)),
  );
  call('pass.draw.1', () => pass.draw(3, 1, 0, 0));
  call('pass.endOcclusionQuery.1', () =>
    unwrap('pass.endOcclusionQuery.1', pass.endOcclusionQuery()),
  );
  call('pass.end', () => pass.end());
  call('encoder.resolveQuerySet', () =>
    unwrap(
      'encoder.resolveQuerySet',
      encoder.resolveQuerySet(querySet, 0, QUERY_COUNT, queryResolveBuffer, QUERY_RESOLVE_OFFSET),
    ),
  );
  call('encoder.copyQueryResolveToStaging', () =>
    encoder.copyBufferToBuffer(
      queryResolveBuffer,
      QUERY_RESOLVE_OFFSET,
      queryStagingBuffer,
      0,
      QUERY_BYTES * QUERY_COUNT,
    ),
  );
  call('encoder.copyColorToReadback', () =>
    encoder.copyTextureToBuffer(
      { texture: colorTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as never,
      {
        buffer: colorReadbackBuffer,
        offset: 0,
        bytesPerRow: READBACK_SIZE,
        rowsPerImage: COLOR_HEIGHT,
      } as never,
      { width: COLOR_WIDTH, height: COLOR_HEIGHT, depthOrArrayLayers: 1 },
    ),
  );
  const firstCommand = unwrap('encoder.finish.first', encoder.finish());
  unwrap('queue.submit.first', device.queue.submit([firstCommand]));
  await device.queue.onSubmittedWorkDone();

  const resultEncoder = unwrap('create.resultCommandEncoder', device.createCommandEncoder({}));
  call('resultEncoder.copyQueryResolveToGpuResult', () =>
    resultEncoder.copyBufferToBuffer(
      queryResolveBuffer,
      QUERY_RESOLVE_OFFSET,
      queryGpuResultBuffer,
      0,
      QUERY_BYTES * QUERY_COUNT,
    ),
  );
  const resultPass = resultEncoder.beginRenderPass({
    colorAttachments: [
      {
        view: queryView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  } as never);
  call('resultPass.setPipeline', () => resultPass.setPipeline(queryPipeline));
  call('resultPass.setBindGroup', () => resultPass.setBindGroup(0, queryBindGroup, []));
  call('resultPass.draw', () => resultPass.draw(3, 1, 0, 0));
  call('resultPass.end', () => resultPass.end());
  call('resultEncoder.copyResultToReadback', () =>
    resultEncoder.copyTextureToBuffer(
      { texture: queryTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as never,
      {
        buffer: resultReadbackBuffer,
        offset: 0,
        bytesPerRow: READBACK_SIZE,
        rowsPerImage: 1,
      } as never,
      { width: QUERY_COUNT, height: 1, depthOrArrayLayers: 1 },
    ),
  );
  const resultCommand = unwrap('resultEncoder.finish', resultEncoder.finish());
  unwrap('queue.submit.result', device.queue.submit([resultCommand]));
  await device.queue.onSubmittedWorkDone();
  const queryBytes = await readMappedBuffer(
    queryStagingBuffer,
    'queryStaging',
    QUERY_BYTES * QUERY_COUNT,
  );
  const colorBytes = await readMappedBuffer(
    colorReadbackBuffer,
    'colorReadback',
    READBACK_SIZE * COLOR_HEIGHT,
  );
  const resultBytes = await readMappedBuffer(resultReadbackBuffer, 'resultReadback', READBACK_SIZE);
  for (const [operation, resource, destroy] of [
    ['destroy.querySet', querySet, device.destroyQuerySet.bind(device)],
    ['destroy.colorTexture', colorTexture, device.destroyTexture.bind(device)],
    ['destroy.queryTexture', queryTexture, device.destroyTexture.bind(device)],
    ['destroy.queryResolveBuffer', queryResolveBuffer, device.destroyBuffer.bind(device)],
    ['destroy.queryStagingBuffer', queryStagingBuffer, device.destroyBuffer.bind(device)],
    ['destroy.queryGpuResultBuffer', queryGpuResultBuffer, device.destroyBuffer.bind(device)],
    ['destroy.colorReadbackBuffer', colorReadbackBuffer, device.destroyBuffer.bind(device)],
    ['destroy.resultReadbackBuffer', resultReadbackBuffer, device.destroyBuffer.bind(device)],
  ] as const) {
    call(operation, () => unwrap(operation, destroy(resource as never)));
  }
  return {
    queryValues: u64Values(queryBytes),
    colorBytes,
    resultHalfWords: freshHalfWords(resultBytes),
  };
}

export async function runQuerySetReplayFixture(
  host: QuerySetFixtureHost,
): Promise<QuerySetReplayFixtureEvidence> {
  let deviceLost: { reason: string; message: string } | null = null;
  void host.device.lost.then((loss) => {
    deviceLost = loss;
  });
  try {
    const original = await executeFrame(host.device, host.createShaderModule);
    const encoded = await host.finishCapture();
    const decoded = decodeTape(encoded.bytes);
    if (!decoded.ok) throw new FixtureFailure(asReceipt('decodeTape', decoded.error));
    const tape = decoded.value;
    const freshDevice = await host.createFreshDevice();
    const replay = unwrap(
      'openReplay',
      await openReplay(tape, {
        device: freshDevice,
        createShaderModule: host.replayCreateShaderModule,
      }),
    );
    const model = buildFrameModel(tape);
    const queryWork = model.works.at(-1);
    if (queryWork === undefined) {
      throw new FixtureFailure(
        asReceipt('buildFrameModel', new Error('query result draw work is missing')),
      );
    }
    const inspection = unwrap(
      'inspectWork.queryResult',
      await replay.inspectWork(queryWork.workIndex, ['pixels']),
    );
    const freshBytes = inspection.attachment?.bytes ?? new Uint8Array();
    const freshWords = freshHalfWords(freshBytes);
    await replay.dispose();
    return {
      runner: host.runner,
      status: 'available',
      tapeFormatVersion: tape.header.formatVersion,
      querySetHandleId: eventHandle(tape, 'createQuerySet', 'handleId'),
      resolveDestinationHandleId: eventHandle(tape, 'resolveQuerySet', 'destinationHandleId'),
      resolveDestinationOffset: eventNumber(tape, 'resolveQuerySet', 'destinationOffset'),
      originalQueryValues: original.queryValues,
      originalResultHalfWords: original.resultHalfWords,
      freshQueryValues: [freshWords[0] === 15360 ? '1' : '0', freshWords[4] === 15360 ? '1' : '0'],
      originalColorBytes: Array.from(original.colorBytes),
      freshColorHalfWords: freshWords,
      eventKinds: tapeEventKinds(tape),
      errorReceipts: [],
      deviceLost,
    };
  } catch (error) {
    const receipt = error instanceof FixtureFailure ? error.receipt : asReceipt('fixture', error);
    return {
      runner: host.runner,
      status: 'unavailable',
      tapeFormatVersion: null,
      querySetHandleId: null,
      resolveDestinationHandleId: null,
      resolveDestinationOffset: null,
      originalQueryValues: [],
      originalResultHalfWords: [],
      freshQueryValues: [],
      originalColorBytes: [],
      freshColorHalfWords: [],
      eventKinds: [],
      errorReceipts: [receipt],
      deviceLost,
    };
  }
}
