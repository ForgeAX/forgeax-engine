import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { decodeTape, encodeTape } from '../protocol/codec';
import type { RhiCallEvent, Tape } from '../protocol/types';
import { validateTape } from '../protocol/validation';
import type { ReplayBackend } from '../replay/session';
import { openReplay } from '../replay/session';

const events: readonly RhiCallEvent[] = [
  { kind: 'createQuerySet', handleId: 'query-set:1', desc: { type: 'occlusion', count: 1 } },
  { kind: 'createBuffer', handleId: 'buffer-1', desc: { size: 8, usage: 132 } },
  {
    kind: 'createCommandEncoder',
    cmdHandleId: 'encoder:1',
    desc: { label: 'occlusion-replay' },
  },
  {
    kind: 'beginRenderPass',
    cmdHandleId: 'encoder:1',
    passHandleId: 'render-pass:1',
    desc: { colorAttachments: [] },
    colorAttachmentViewHandleIds: [],
    occlusionQuerySetHandleId: 'query-set:1',
  },
  { kind: 'beginOcclusionQuery', passHandleId: 'render-pass:1', queryIndex: 0 },
  { kind: 'endOcclusionQuery', passHandleId: 'render-pass:1' },
  { kind: 'endRenderPass', passHandleId: 'render-pass:1' },
  {
    kind: 'resolveQuerySet',
    cmdHandleId: 'encoder:1',
    querySetHandleId: 'query-set:1',
    firstQuery: 0,
    queryCount: 1,
    destinationHandleId: 'buffer-1',
    destinationOffset: 0,
  },
  { kind: 'finish', cmdHandleId: 'encoder:1' },
  { kind: 'destroyQuerySet', handleId: 'query-set:1' },
];

function tape(tapeEvents: readonly RhiCallEvent[] = events): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: tapeEvents.length, blobCount: 0 },
    bootstrap: [],
    events: tapeEvents,
    blobs: [],
  };
}

function inspectTape(queryEvents: readonly RhiCallEvent[]): Tape {
  const inspectEvents: readonly RhiCallEvent[] = [
    {
      kind: 'createQuerySet',
      handleId: 'query-set:inspect',
      desc: { type: 'occlusion', count: 1 },
    },
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder:inspect', desc: {} },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'encoder:inspect',
      passHandleId: 'render-pass:inspect',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: [],
      occlusionQuerySetHandleId: 'query-set:inspect',
    },
    ...queryEvents,
    {
      kind: 'draw',
      passHandleId: 'render-pass:inspect',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'finish', cmdHandleId: 'encoder:inspect' },
    { kind: 'submit', cmdHandleIds: ['encoder:inspect'] },
  ];
  return tape(inspectEvents);
}

async function nullBackend(): Promise<ReplayBackend> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(device.error.hint);
  return { device: device.value, createShaderModule };
}

function bootstrapBufferTape(withInitialData: boolean): Tape {
  const bootstrap = {
    handleId: 'buffer:bootstrap',
    kind: 'buffer' as const,
    create: {
      kind: 'createBuffer',
      handleId: 'buffer:bootstrap',
      desc: { size: 4, usage: 0x204, mappedAtCreation: false },
    },
    initialData: withInitialData ? [{ hash: 'bootstrap-bytes', byteOffset: 0, byteLength: 4 }] : [],
  };
  const events: readonly RhiCallEvent[] = [
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder:bootstrap', desc: {} },
    {
      kind: 'beginComputePass',
      cmdHandleId: 'encoder:bootstrap',
      passHandleId: 'pass:bootstrap',
      desc: {},
    },
    { kind: 'dispatchWorkgroups', passHandleId: 'pass:bootstrap', x: 1, y: 1, z: 1 },
    { kind: 'endComputePass', passHandleId: 'pass:bootstrap' },
    { kind: 'finish', cmdHandleId: 'encoder:bootstrap' },
    { kind: 'submit', cmdHandleIds: ['encoder:bootstrap'] },
  ];
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 1 },
    bootstrap: [bootstrap],
    events,
    blobs: [
      {
        hash: 'bootstrap-bytes',
        bytes: new Uint8Array([1, 2, 3, 4]),
        compression: 'none',
      },
    ],
  };
}

async function trackingBackend(): Promise<{
  readonly backend: ReplayBackend;
  readonly usages: number[];
}> {
  const backend = await nullBackend();
  const usages: number[] = [];
  const device = backend.device as RhiDevice;
  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (desc) => {
    usages.push(desc.usage ?? 0);
    return createBuffer(desc);
  };
  return { backend, usages };
}

describe('QuerySet occlusion tape lifecycle', () => {
  it('round-trips create, attach, begin/end, resolve, and destroy events', () => {
    const encoded = encodeTape(tape());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeTape(encoded.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.events.map((event) => event.kind)).toEqual(
      events.map((event) => event.kind),
    );
    expect(validateTape(decoded.value).ok).toBe(true);
  });

  it('rejects query resolve before its QuerySet is created', () => {
    const invalid = tape([
      {
        kind: 'resolveQuerySet',
        cmdHandleId: 'encoder:1',
        querySetHandleId: 'query-set:missing',
        firstQuery: 0,
        queryCount: 1,
        destinationHandleId: 'buffer-1',
        destinationOffset: 0,
      },
    ]);
    const result = validateTape(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('tape-invalid');
  });

  it('rejects QuerySet use after disposal', () => {
    const invalid = tape([
      { kind: 'createQuerySet', handleId: 'query-set:1', desc: { type: 'occlusion', count: 1 } },
      { kind: 'destroyQuerySet', handleId: 'query-set:1' },
      { kind: 'destroyQuerySet', handleId: 'query-set:1' },
    ]);
    const result = validateTape(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('tape-invalid');
  });

  it('closes an active occlusion query before finalizing a selected work pass', async () => {
    const opened = await openReplay(
      inspectTape([
        { kind: 'beginOcclusionQuery', passHandleId: 'render-pass:inspect', queryIndex: 0 },
      ]),
      await nullBackend(),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const inspection = await opened.value.inspectWork(0);
    expect(inspection.ok).toBe(true);
  });

  it('finalizes a selected pass without inventing an occlusion query', async () => {
    const opened = await openReplay(inspectTape([]), await nullBackend());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const inspection = await opened.value.inspectWork(0);
    expect(inspection.ok).toBe(true);
  });

  it('returns a structured error for a mismatched occlusion-query closure', async () => {
    const opened = await openReplay(
      inspectTape([{ kind: 'endOcclusionQuery', passHandleId: 'render-pass:other' }]),
      await nullBackend(),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const inspection = await opened.value.inspectWork(0);
    expect(inspection.ok).toBe(false);
    if (!inspection.ok) expect(inspection.error.code).toBe('replay-event-failed');
  });

  it('keeps the captured usage when bootstrap initialData seeds through creation mapping', async () => {
    const tracked = await trackingBackend();
    const opened = await openReplay(bootstrapBufferTape(true), tracked.backend);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect((await opened.value.inspectWork(0)).ok).toBe(true);
    // Creation mapping restores the bytes without queue.writeBuffer, so the
    // replay must not mutate the captured usage with a replay-only COPY_DST.
    expect(tracked.usages).toEqual([0x204]);
  });

  it('does not add replay-only COPY_DST to an unseeded or already writable buffer', async () => {
    const unseeded = await trackingBackend();
    const openedUnseeded = await openReplay(bootstrapBufferTape(false), unseeded.backend);
    expect(openedUnseeded.ok).toBe(true);
    if (!openedUnseeded.ok) return;
    expect((await openedUnseeded.value.inspectWork(0)).ok).toBe(true);
    expect(unseeded.usages).toEqual([0x204]);

    const alreadyWritable = await trackingBackend();
    const tapeWithWritableBuffer = bootstrapBufferTape(true);
    const bootstrap = tapeWithWritableBuffer.bootstrap[0];
    if (bootstrap === undefined) return;
    const createBufferEvent = bootstrap.create as unknown as Extract<
      RhiCallEvent,
      { readonly kind: 'createBuffer' }
    >;
    const openedWritable = await openReplay(
      {
        ...tapeWithWritableBuffer,
        bootstrap: [
          {
            ...bootstrap,
            create: {
              ...createBufferEvent,
              desc: { ...createBufferEvent.desc, usage: 0x20c },
            },
          },
        ],
      },
      alreadyWritable.backend,
    );
    expect(openedWritable.ok).toBe(true);
    if (!openedWritable.ok) return;
    expect((await openedWritable.value.inspectWork(0)).ok).toBe(true);
    expect(alreadyWritable.usages).toEqual([0x20c]);
  });
});
