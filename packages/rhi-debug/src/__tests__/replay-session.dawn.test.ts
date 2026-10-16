/// <reference types="@webgpu/types" />

import type { RhiInstance } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { BootstrapResource, Tape } from '../protocol/types';
import { openReplay, type ReplayBackend } from '../replay/session';

interface DawnPack {
  readonly rhi: RhiInstance;
  readonly createShaderModule: ReplayBackend['createShaderModule'];
}

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';
const WIDTH = 32;
const HEIGHT = 32;

const VERTEX_SHADER = `
@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(0.0, 0.7), vec2<f32>(-0.7, -0.7), vec2<f32>(0.7, -0.7));
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
@fragment
fn main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}`;

async function loadDawn(): Promise<DawnPack> {
  return (await import('@forgeax/engine-rhi-webgpu')) as unknown as DawnPack;
}

async function freshDevice(pack: DawnPack) {
  const adapter = await pack.rhi.requestAdapter();
  expect(adapter.ok).toBe(true);
  if (!adapter.ok) throw new Error(`Dawn admission failed: ${adapter.error.code}`);
  const device = await adapter.value.requestDevice();
  expect(device.ok).toBe(true);
  if (!device.ok) throw new Error(`Dawn device admission failed: ${device.error.code}`);
  return device.value;
}

function bootstrap(
  handleId: string,
  kind: BootstrapResource['kind'],
  create: Record<string, unknown>,
  initialData: BootstrapResource['initialData'] = [],
): BootstrapResource {
  return { handleId, kind, create, initialData };
}

function triangleTape(layout: 'explicit' | 'auto' = 'explicit'): Tape {
  const bootstrapResources: BootstrapResource[] = [
    bootstrap(
      'texture:rt',
      'texture',
      {
        kind: 'createTexture',
        handleId: 'texture:rt',
        desc: {
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: 'rgba8unorm',
          dimension: '2d',
          mipLevelCount: 1,
          sampleCount: 1,
          usage: 0x13,
        },
      },
      [{ hash: 'texture-seed', byteOffset: 0, byteLength: WIDTH * HEIGHT * 4 }],
    ),
    bootstrap('texture-view:rt', 'texture-view', {
      kind: 'createTextureView',
      sourceHandleId: 'texture:rt',
      resultHandleId: 'texture-view:rt',
      desc: {},
    }),
    bootstrap('shader:vertex', 'shader-module', {
      kind: 'createShaderModule',
      handleId: 'shader:vertex',
      wgslCode: VERTEX_SHADER,
    }),
    bootstrap('shader:fragment', 'shader-module', {
      kind: 'createShaderModule',
      handleId: 'shader:fragment',
      wgslCode: FRAGMENT_SHADER,
    }),
    bootstrap('layout:empty', 'binding', {
      kind: 'createBindGroupLayout',
      handleId: 'layout:empty',
      desc: { entries: [] },
    }),
    bootstrap('pipeline-layout:empty', 'binding', {
      kind: 'createPipelineLayout',
      handleId: 'pipeline-layout:empty',
      bglHandleIds: ['layout:empty'],
    }),
    bootstrap('pipeline:triangle', 'pipeline', {
      kind: 'createRenderPipeline',
      handleId: 'pipeline:triangle',
      desc: {
        vertex: { entryPoint: 'main', buffers: [] },
        fragment: { entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      },
      layoutHandleId: layout === 'auto' ? 'layout:auto' : 'pipeline-layout:empty',
      vertexShaderModuleHandleId: 'shader:vertex',
      fragmentShaderModuleHandleId: 'shader:fragment',
    }),
  ];
  const events = [
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder:frame', desc: {} },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'encoder:frame',
      passHandleId: 'pass:frame',
      desc: {
        colorAttachments: [
          { view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'load', storeOp: 'store' },
        ],
      },
      colorAttachmentViewHandleIds: ['texture-view:rt'],
      colorAttachmentResolveTargetHandleIds: [undefined],
      depthStencilViewHandleId: undefined,
    },
    { kind: 'setPipeline', passHandleId: 'pass:frame', pipelineHandleId: 'pipeline:triangle' },
    {
      kind: 'draw',
      passHandleId: 'pass:frame',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'pass:frame' },
    { kind: 'finish', cmdHandleId: 'encoder:frame' },
    { kind: 'submit', cmdHandleIds: ['encoder:frame'] },
    { kind: 'frameMark', frameIdx: 0 },
  ] as unknown as Tape['events'];
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 1 },
    bootstrap: bootstrapResources,
    events,
    blobs: [
      {
        hash: 'texture-seed',
        bytes: new Uint8Array(WIDTH * HEIGHT * 4).fill(23),
        compression: 'none',
      },
    ],
  };
}

function msaaTriangleTape(): Tape {
  const tape = triangleTape();
  const bootstrapResources = tape.bootstrap.map((resource) => {
    if (resource.handleId === 'texture:rt') {
      const desc = resource.create.desc as Record<string, unknown>;
      return bootstrap('texture:msaa', 'texture', {
        ...resource.create,
        handleId: 'texture:msaa',
        desc: { ...desc, sampleCount: 4, usage: 0x10 },
      });
    }
    if (resource.handleId === 'texture-view:rt') {
      return bootstrap('texture-view:msaa', 'texture-view', {
        ...resource.create,
        sourceHandleId: 'texture:msaa',
        resultHandleId: 'texture-view:msaa',
      });
    }
    if (resource.handleId === 'pipeline:triangle') {
      const desc = resource.create.desc as Record<string, unknown>;
      return bootstrap('pipeline:triangle', 'pipeline', {
        ...resource.create,
        desc: { ...desc, multisample: { count: 4 } },
      });
    }
    return resource;
  });
  bootstrapResources.push(
    bootstrap('texture:resolve', 'texture', {
      kind: 'createTexture',
      handleId: 'texture:resolve',
      desc: {
        size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
        usage: 0x11,
      },
    }),
    bootstrap('texture-view:resolve', 'texture-view', {
      kind: 'createTextureView',
      sourceHandleId: 'texture:resolve',
      resultHandleId: 'texture-view:resolve',
      desc: {},
    }),
  );

  const events = tape.events.map((event) => {
    if (event.kind === 'beginRenderPass') {
      return {
        ...event,
        desc: {
          ...event.desc,
          colorAttachments: [
            {
              view: null,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        },
        colorAttachmentViewHandleIds: ['texture-view:msaa'],
        colorAttachmentResolveTargetHandleIds: ['texture-view:resolve'],
      };
    }
    return event;
  }) as Tape['events'];

  return {
    ...tape,
    header: { ...tape.header, blobCount: 0 },
    bootstrap: bootstrapResources,
    events,
    blobs: [],
  };
}

describe.skipIf(SKIP_DAWN)('ReplaySession Dawn contract', () => {
  it.each([
    0x84, 0x184, 0x06,
  ])('restores captured buffer bytes without COPY_DST (usage %i)', async (usage) => {
    const pack = await loadDawn();
    const expected = new Uint8Array([17, 31, 63, 127, 5, 9, 13, 21]);
    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 1 },
      bootstrap: [
        bootstrap(
          'buffer:seed',
          'buffer',
          {
            kind: 'createBuffer',
            handleId: 'buffer:seed',
            desc: { size: expected.length, usage },
          },
          [{ hash: 'seed', byteOffset: 0, byteLength: expected.length }],
        ),
      ],
      events: [],
      blobs: [{ hash: 'seed', bytes: expected, compression: 'none' }],
    };
    const replay = (
      await openReplay(tape, {
        device: await freshDevice(pack),
        createShaderModule: pack.createShaderModule,
      })
    ).unwrap();
    try {
      expect((await replay.readResource('buffer:seed')).unwrap().bytes).toEqual(expected);
      expect(tape.bootstrap[0]?.create.desc).toEqual({ size: expected.length, usage });
    } finally {
      (await replay.dispose()).unwrap();
    }
  });

  it.each([
    'explicit',
    'auto',
  ] as const)('replays a triangle with %s layout and returns attachment bytes through inspectWork', async (layout) => {
    const pack = await loadDawn();
    const tape = triangleTape(layout);
    const first = await openReplay(tape, {
      device: await freshDevice(pack),
      createShaderModule: pack.createShaderModule,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.hint);
    const baseline = await first.value.inspectWork(0, ['pixels']);
    expect(
      baseline.ok,
      baseline.ok ? undefined : `${baseline.error.code}: ${JSON.stringify(baseline.error.detail)}`,
    ).toBe(true);
    if (!baseline.ok) throw new Error(baseline.error.hint);
    expect(baseline.value.attachment?.bytes.byteLength).toBe(WIDTH * HEIGHT * 4);
    expect(baseline.value.attachment?.bytes.slice(0, 4)).toEqual(new Uint8Array([23, 23, 23, 23]));
    expect(baseline.value.attachment?.provenance.resourceId).toBe('texture-view:rt');
    expect(baseline.value.attachment?.provenance.selectedWorkIndex).toBe(0);
    expect(baseline.value.attachment?.provenance.subresource).toBeNull();

    const selected = await first.value.readResourceAtWork('texture-view:rt', 0);
    expect(
      selected.ok,
      selected.ok ? undefined : `${selected.error.code}: ${JSON.stringify(selected.error.detail)}`,
    ).toBe(true);
    if (!selected.ok) throw new Error(selected.error.hint);
    expect(selected.value.provenance.selectedWorkIndex).toBe(0);
    expect(selected.value.bytes).toEqual(baseline.value.attachment?.bytes);
    const bootstrap = await first.value.readResource('texture-view:rt');
    if (!bootstrap.ok) throw new Error(bootstrap.error.hint);
    expect(bootstrap.value.provenance.selectedWorkIndex).toBeUndefined();
    expect(selected.value.bytes).not.toEqual(bootstrap.value.bytes);

    const second = await openReplay(tape, {
      device: await freshDevice(pack),
      createShaderModule: pack.createShaderModule,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.hint);
    const replay = await second.value.inspectWork(0, ['pixels']);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    expect(replay.value.attachment?.bytes).toEqual(baseline.value.attachment?.bytes);
    expect((await first.value.dispose()).ok).toBe(true);
    expect((await second.value.dispose()).ok).toBe(true);
  }, 60_000);

  it('resolves an MSAA attachment for pixels and rejects direct MSAA readback', async () => {
    const pack = await loadDawn();
    const replayResult = await openReplay(msaaTriangleTape(), {
      device: await freshDevice(pack),
      createShaderModule: pack.createShaderModule,
    });
    expect(replayResult.ok).toBe(true);
    if (!replayResult.ok) throw new Error(replayResult.error.hint);

    try {
      const first = await replayResult.value.inspectWork(0, ['pixels']);
      expect(
        first.ok,
        first.ok ? undefined : `${first.error.code}: ${JSON.stringify(first.error.detail)}`,
      ).toBe(true);
      if (!first.ok) throw new Error(first.error.hint);
      const attachment = first.value.attachment;
      expect(attachment?.provenance.resourceId).toBe('texture-view:resolve');
      expect(attachment?.provenance.selectedWorkIndex).toBe(0);
      expect(attachment?.provenance.subresource).toBeNull();
      const centerOffset = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 4;
      expect(attachment?.bytes.slice(centerOffset, centerOffset + 4)).toEqual(
        new Uint8Array([255, 0, 0, 255]),
      );

      const repeated = await replayResult.value.inspectWork(0, ['pixels']);
      expect(repeated.ok).toBe(true);
      if (!repeated.ok) throw new Error(repeated.error.hint);
      expect(repeated.value.attachment?.bytes).toEqual(attachment?.bytes);
      expect(repeated.value.attachment?.provenance.resourceId).toBe('texture-view:resolve');
      expect(repeated.value.attachment?.provenance.selectedWorkIndex).toBe(0);
      expect(repeated.value.attachment?.provenance.subresource).toBeNull();

      const directMsaa = await replayResult.value.readResource('texture:msaa');
      expect(directMsaa.ok).toBe(false);
      if (directMsaa.ok) throw new Error('MSAA texture readback unexpectedly succeeded');
      expect(directMsaa.error.code).toBe('readback-unsupported');
      expect(directMsaa.error.detail).toMatchObject({ resourceId: 'texture:msaa' });
    } finally {
      expect((await replayResult.value.dispose()).ok).toBe(true);
    }
  }, 60_000);

  it('reports the first shader factory failure on a real Dawn device', async () => {
    const pack = await loadDawn();
    const device = await freshDevice(pack);
    const failingBackend: ReplayBackend = {
      device,
      createShaderModule: async () =>
        err(
          new RhiError({
            code: 'shader-compile-failed',
            expected: 'shader compilation succeeds',
            hint: 'test factory failure',
          }),
        ),
    };
    const replay = await openReplay(triangleTape(), failingBackend);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error.hint);
    const inspection = await replay.value.inspectWork(0);
    expect(inspection.ok).toBe(false);
    if (!inspection.ok) {
      expect(inspection.error.code).toBe('replay-event-failed');
      if (inspection.error.code === 'replay-event-failed') {
        expect(inspection.error.detail?.kind).toBe('createShaderModule');
        expect(inspection.error.detail?.stage).toBe('create');
      }
    }
    expect((await replay.value.dispose()).ok).toBe(true);
  }, 60_000);
});
