import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { Tape } from '../protocol/types';
import type { ReplayBackend } from '../replay/session';
import { openReplay } from '../replay/session';

function makeWorkTape(): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
    bootstrap: [],
    events: [
      {
        kind: 'createCommandEncoder',
        cmdHandleId: 'encoder:1',
        desc: {},
      },
      {
        kind: 'beginComputePass',
        cmdHandleId: 'encoder:1',
        passHandleId: 'pass:1',
        desc: {},
      },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:1',
        x: 1,
        y: 1,
        z: 1,
      },
      { kind: 'endComputePass', passHandleId: 'pass:1' },
      { kind: 'finish', cmdHandleId: 'encoder:1' },
      { kind: 'submit', cmdHandleIds: ['encoder:1'] },
      { kind: 'frameMark', frameIdx: 0 },
    ],
    blobs: [],
  };
}

async function makeBackend(): Promise<ReplayBackend> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(device.error.hint);
  return { device: device.value, createShaderModule };
}

describe('ReplaySession', () => {
  it('applies queue uploads through the selected command submission, without later work', async () => {
    const base = makeWorkTape();
    const upload = (offset: number, handleId = 'buffer:retained'): Tape['events'][number] => ({
      kind: 'writeBuffer',
      handleId,
      bufferOffset: offset,
      dataHash: 'payload',
      size: 4,
    });
    const textureUpload: Tape['events'][number] = {
      kind: 'writeTexture',
      destination: { textureHandleId: 'texture:1' },
      dataHash: 'payload',
      dataLayout: {},
      size: { width: 1, height: 1 },
    };
    const events: Tape['events'] = [
      { kind: 'createBuffer', handleId: 'buffer:retained', desc: { size: 32, usage: 8 } },
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: { size: [1, 1], format: 'rgba8unorm', usage: 2 },
      },
      ...base.events.slice(0, 3),
      upload(0),
      { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 99, y: 1, z: 1 },
      ...base.events.slice(3, 4),
      upload(4),
      ...base.events.slice(4, 5),
      upload(8),
      textureUpload,
      { kind: 'createBuffer', handleId: 'buffer:later', desc: { size: 4, usage: 8 } },
      upload(0, 'buffer:later'),
      ...base.events.slice(5, 6),
      upload(12),
      textureUpload,
    ];
    const backend = await makeBackend();
    const writes = vi.spyOn(backend.device.queue, 'writeBuffer');
    const textureWrites = vi.spyOn(backend.device.queue, 'writeTexture');
    const tape: Tape = {
      ...base,
      header: { ...base.header, eventCount: events.length, blobCount: 1 },
      events,
      blobs: [{ hash: 'payload', bytes: new Uint8Array([1, 2, 3, 4]), compression: 'none' }],
    };
    const replay = (await openReplay(tape, backend)).unwrap();
    try {
      (await replay.inspectWork(0, ['pipeline'])).unwrap();
      expect(writes.mock.calls.map((call) => call[1])).toEqual([0, 4, 8]);
      expect(textureWrites).toHaveBeenCalledTimes(1);
    } finally {
      writes.mockRestore();
      textureWrites.mockRestore();
      (await replay.dispose()).unwrap();
    }
  });

  it.each([
    'render',
    'compute',
  ] as const)('replays the recorded auto layout for a %s pipeline', async (kind) => {
    const tape: Tape = {
      ...makeWorkTape(),
      bootstrap: [
        {
          handleId: 'shader:auto',
          kind: 'shader-module',
          initialData: [],
          create: {
            kind: 'createShaderModule',
            handleId: 'shader:auto',
            wgslCode:
              kind === 'compute'
                ? '@compute @workgroup_size(1) fn main() {}'
                : '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }',
          },
        },
        {
          handleId: 'pipeline:auto',
          kind: 'pipeline',
          initialData: [],
          create:
            kind === 'compute'
              ? {
                  kind: 'createComputePipeline',
                  handleId: 'pipeline:auto',
                  layoutHandleId: 'layout:auto',
                  computeShaderModuleHandleId: 'shader:auto',
                  desc: { compute: { entryPoint: 'main' } },
                }
              : {
                  kind: 'createRenderPipeline',
                  handleId: 'pipeline:auto',
                  layoutHandleId: 'layout:auto',
                  vertexShaderModuleHandleId: 'shader:auto',
                  desc: { vertex: { entryPoint: 'main', buffers: [] } },
                },
        },
      ],
    };
    const opened = await openReplay(tape, await makeBackend());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const inspected = await opened.value.inspectWork(0);
      expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
    } finally {
      opened.value.dispose();
    }
  });

  it('does not require unused recorded optional capabilities', async () => {
    const backend = await makeBackend();
    vi.spyOn(backend.device, 'caps', 'get').mockReturnValue({
      ...backend.device.caps,
      firstInstanceIndirect: false,
      rg11b10ufloatRenderable: false,
    });
    const result = await openReplay(
      {
        ...makeWorkTape(),
        header: {
          ...makeWorkTape().header,
          rhiCaps: {
            rgba16floatRenderable: true,
            rg11b10ufloatRenderable: true,
            float32Filterable: true,
            firstInstanceIndirect: true,
            textureImport: false,
            externalTexture: false,
            textureCompressionBc: true,
            textureCompressionEtc2: true,
            textureCompressionAstc: true,
            storageBuffer: true,
            timestampQuery: true,
          },
        },
      },
      backend,
    );
    expect(result.ok).toBe(true);
    if (result.ok) (await result.value.dispose()).unwrap();
  });

  it.each([
    'drawIndirect',
    'drawIndexedIndirect',
  ] as const)('requires captured firstInstanceIndirect support for %s', async (kind) => {
    const backend = await makeBackend();
    vi.spyOn(backend.device, 'caps', 'get').mockReturnValue({
      ...backend.device.caps,
      firstInstanceIndirect: false,
    });
    const events: Tape['events'] = [
      { kind: 'createBuffer', handleId: 'buffer:indirect', desc: { size: 20, usage: 0x100 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1', desc: {} },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'encoder:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind,
        passHandleId: 'pass:1',
        indirectBufferHandleId: 'buffer:indirect',
        indirectOffset: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      { kind: 'finish', cmdHandleId: 'encoder:1' },
      { kind: 'submit', cmdHandleIds: ['encoder:1'] },
    ];
    const result = await openReplay(
      {
        header: {
          formatVersion: 7,
          rhiCaps: { firstInstanceIndirect: true },
          eventCount: events.length,
          blobCount: 0,
        },
        bootstrap: [],
        events,
        blobs: [],
      },
      backend,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'replay-capability-mismatch',
        detail: { cause: expect.stringContaining('firstInstanceIndirect') },
      },
    });
  });

  it('requires captured RG11B10Float rendering support for a render attachment', async () => {
    const backend = await makeBackend();
    vi.spyOn(backend.device, 'caps', 'get').mockReturnValue({
      ...backend.device.caps,
      rg11b10ufloatRenderable: false,
    });
    const result = await openReplay(
      {
        header: {
          formatVersion: 7,
          rhiCaps: { rg11b10ufloatRenderable: true },
          eventCount: 1,
          blobCount: 0,
        },
        bootstrap: [],
        events: [
          {
            kind: 'createTexture',
            handleId: 'texture:1',
            desc: { size: [4, 4], format: 'rg11b10ufloat', usage: 0x10 },
          },
        ],
        blobs: [],
      },
      backend,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'replay-capability-mismatch',
        detail: { cause: expect.stringContaining('rg11b10ufloatRenderable') },
      },
    });
  });

  it('requires a recorded compression capability when the tape uses its format', async () => {
    const result = await openReplay(
      {
        header: {
          formatVersion: 7,
          rhiCaps: { textureCompressionBc: true },
          eventCount: 1,
          blobCount: 0,
        },
        bootstrap: [],
        events: [
          {
            kind: 'createTexture',
            handleId: 'texture:compressed',
            desc: {
              size: { width: 4, height: 4, depthOrArrayLayers: 1 },
              format: 'bc1-rgba-unorm',
              usage: 0x04,
            },
          },
        ],
        blobs: [],
      },
      await makeBackend(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('replay-capability-mismatch');
  });

  it('replays a depth-only render pipeline without requiring a fragment shader', async () => {
    const tape: Tape = {
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
      bootstrap: [
        {
          handleId: 'shader:vertex',
          kind: 'shader-module',
          create: {
            kind: 'createShaderModule',
            handleId: 'shader:vertex',
            wgslCode: '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(); }',
          },
          initialData: [],
        },
        {
          handleId: 'layout:empty',
          kind: 'binding',
          create: {
            kind: 'createBindGroupLayout',
            handleId: 'layout:empty',
            desc: { entries: [] },
          },
          initialData: [],
        },
        {
          handleId: 'pipeline-layout:empty',
          kind: 'binding',
          create: {
            kind: 'createPipelineLayout',
            handleId: 'pipeline-layout:empty',
            bglHandleIds: ['layout:empty'],
          },
          initialData: [],
        },
        {
          handleId: 'pipeline:depth-only',
          kind: 'pipeline',
          create: {
            kind: 'createRenderPipeline',
            handleId: 'pipeline:depth-only',
            desc: { vertex: { entryPoint: 'main', buffers: [] } },
            layoutHandleId: 'pipeline-layout:empty',
            vertexShaderModuleHandleId: 'shader:vertex',
          },
          initialData: [],
        },
      ],
      events: makeWorkTape().events,
      blobs: [],
    };
    const result = await openReplay(tape, await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await result.value.inspectWork(0)).ok).toBe(true);
  });

  it('replays a work index on a caller-provided fresh backend', async () => {
    const result = await openReplay(makeWorkTape(), await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inspection = await result.value.inspectWork(0);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.value.workIndex).toBe(0);
    expect(inspection.value.eventIndex).toBe(2);
    expect(inspection.value.attachment).toBeUndefined();
    expect('stepTo' in result.value).toBe(false);
    expect('commitThroughDraw' in result.value).toBe(false);
  });

  it('returns selected-work facts for every inspection selector', async () => {
    const result = await openReplay(makeWorkTape(), await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const inspection = await result.value.inspectWork(0, ['bindings', 'pipeline']);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.value.pipeline).toBeDefined();
    expect(inspection.value.bindings).toBeDefined();
    expect(inspection.value.vertexBuffers).toBeDefined();
    expect(inspection.value.indexBuffer).toBeDefined();
    expect(inspection.value.shaders).toBeDefined();
    expect(inspection.value.resourceIds).toBeDefined();
  });

  it('resets internally when selecting an earlier work and rejects invalid positions', async () => {
    const tape = makeWorkTape();
    const withSecondWork: Tape = {
      ...tape,
      header: { ...tape.header, eventCount: tape.events.length + 1 },
      events: [
        ...tape.events.slice(0, 3),
        { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 2, y: 1, z: 1 },
        ...tape.events.slice(3),
      ],
    };
    const result = await openReplay(withSecondWork, await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((await result.value.inspectWork(1)).ok).toBe(true);
    const earlier = await result.value.inspectWork(0);
    expect(earlier.ok).toBe(true);
    if (!earlier.ok) return;
    expect(earlier.value.workIndex).toBe(0);

    const invalid = await result.value.inspectWork(2);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('replay-position-invalid');
  });

  it('returns a structured terminal error after dispose and keeps the session closed', async () => {
    const result = await openReplay(makeWorkTape(), await makeBackend());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((await result.value.dispose()).ok).toBe(true);
    const reused = await result.value.inspectWork(0);
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe('replay-position-invalid');
  });
});
