import { encodeTape, tapeDigest, type V7Tape } from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type ArtifactRef,
  type CapturedRhiTape,
  discoverRhiDebugOperations,
  type ReplayBackendLease,
  type RhiDebugOperationContext,
  renderRhiDebugHelp,
  runRhiDebugOperation,
} from '../rhi-debug/operations';
import type { CommandResult } from '../types';

const tape: V7Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
  bootstrap: [],
  events: [],
  blobs: [],
};

const workTape: V7Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
  bootstrap: [
    {
      handleId: 'buffer:probes',
      kind: 'buffer',
      create: { kind: 'createBuffer', handleId: 'buffer:probes', desc: { size: 64, usage: 0x8c } },
      initialData: [],
    },
  ],
  events: [
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1', desc: {} },
    { kind: 'beginComputePass', cmdHandleId: 'encoder:1', passHandleId: 'pass:1', desc: {} },
    { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 1, y: 1, z: 1 },
    { kind: 'endComputePass', passHandleId: 'pass:1' },
    { kind: 'finish', cmdHandleId: 'encoder:1' },
    { kind: 'submit', cmdHandleIds: ['encoder:1'] },
    { kind: 'frameMark', frameIdx: 0 },
  ],
  blobs: [],
};

function makeContext(bytes: Uint8Array): {
  readonly context: RhiDebugOperationContext;
  readonly artifact: ArtifactRef;
} {
  const artifact: ArtifactRef = {
    kind: 'rhi-tape',
    digest: tapeDigest(bytes),
    source: 'rhi.capture',
  };
  const captured: CapturedRhiTape = { ...artifact, bytes };
  const context: RhiDebugOperationContext = {
    captureFrame: async (): Promise<Result<CapturedRhiTape, never>> => ok(captured),
    readArtifact: async (ref) =>
      ref.digest === artifact.digest
        ? { ok: true, value: bytes }
        : {
            ok: false,
            error: {
              code: 'artifact-not-found',
              expected: 'the requested rhi-tape artifact to exist',
              hint: 'capture a new rhi-tape and pass its ArtifactRef unchanged',
              detail: { digest: ref.digest },
            },
          },
  };
  return { context, artifact };
}

const leases = { opened: 0, released: 0 };

async function createReplayBackend(): Promise<CommandResult<ReplayBackendLease>> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) {
    return {
      ok: false as const,
      error: {
        code: adapter.error.code,
        expected: adapter.error.expected,
        hint: adapter.error.hint,
        detail: { cause: adapter.error.detail ?? null },
      },
    };
  }
  const device = await adapter.value.requestDevice();
  if (!device.ok) {
    return {
      ok: false as const,
      error: {
        code: device.error.code,
        expected: device.error.expected,
        hint: device.error.hint,
        detail: { cause: device.error.detail ?? null },
      },
    };
  }
  leases.opened += 1;
  return ok({
    device: device.value,
    createShaderModule,
    release: () => {
      leases.released += 1;
    },
  });
}

describe('DevKit RHI debug operations', () => {
  it('discovers only the five canonical operations from an empty context', () => {
    expect(discoverRhiDebugOperations().map((operation) => operation.name)).toEqual([
      'rhi.capture',
      'rhi.summary',
      'rhi.inspect',
      'rhi.read',
      'rhi.timing',
    ]);
    const help = renderRhiDebugHelp();
    expect(help).toContain('rhi.capture');
    expect(help).toContain('rhi.summary');
    expect(help).toContain('rhi.inspect');
    expect(help).toContain('forgeax rhi read');
    expect(help).toContain('forgeax rhi timing');
    expect(help).toContain('"records":{"layout"');
    expect(help).toContain('FORGEAX_WEBGPU_NODE=wgpu-native');
    expect(help).not.toMatch(/legacy RHI debug command/);
  });

  it('hands one ArtifactRef digest from capture to summary', async () => {
    const encoded = encodeTape(tape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const { context } = makeContext(encoded.value);

    const captured = await runRhiDebugOperation('rhi.capture', {}, context);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    const summary = await runRhiDebugOperation(
      'rhi.summary',
      { artifact: captured.value },
      context,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.artifact).toEqual(captured.value);
    expect(summary.value.summary.works).toEqual([]);
  });

  it('rejects an artifact that changes kind or digest at the operation boundary', async () => {
    const encoded = encodeTape(tape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const { context, artifact } = makeContext(encoded.value);

    const invalid = await runRhiDebugOperation(
      'rhi.summary',
      { artifact: { ...artifact, kind: 'other' as 'rhi-tape' } },
      context,
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.code).toBe('artifact-kind-invalid');
  });

  it('inspects a workIndex through a real fresh rhi-null replay backend', async () => {
    const encoded = encodeTape(workTape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const { context, artifact } = makeContext(encoded.value);
    const inspectContext: RhiDebugOperationContext = { ...context, createReplayBackend };
    const result = await runRhiDebugOperation(
      'rhi.inspect',
      { artifact, workIndex: 0 },
      inspectContext,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.inspection.workIndex).toBe(0);
    const missingBuffer = await runRhiDebugOperation(
      'rhi.inspect',
      {
        artifact,
        workIndex: 0,
        buffer: {
          resourceId: 'buffer:missing',
          first: 0,
          count: 1,
          layout: { stride: 4, fields: [{ name: 'id', offset: 0, type: 'u32', components: 1 }] },
        },
      },
      inspectContext,
    );
    expect(missingBuffer).toMatchObject({ ok: false, error: { code: 'readback-failed' } });
  });

  it('routes rhi.read requests and keeps per-read failures inside one replay', async () => {
    const encoded = encodeTape(workTape);
    if (!encoded.ok) throw new Error(encoded.error.hint);
    const { context, artifact } = makeContext(encoded.value);
    const readContext: RhiDebugOperationContext = { ...context, createReplayBackend };
    const result = await runRhiDebugOperation(
      'rhi.read',
      {
        artifact,
        reads: [
          { binding: { group: 0, binding: 0 }, workIndex: 0 },
          { binding: { group: 0, binding: 0 } },
          { resourceId: 'buffer:probes', binding: { group: 0, binding: 0 } },
          { resourceId: 'buffer:probes', workIndex: 9 },
        ],
      },
      readContext,
    );
    if (!result.ok) throw new Error(result.error.hint);
    expect(result.value.artifact).toEqual(artifact);
    expect(result.value.reads.map((read) => (read.ok ? 'ok' : read.error.code))).toEqual([
      'readback-failed',
      'read-request-invalid',
      'read-request-invalid',
      'replay-position-invalid',
    ]);
    expect(
      await runRhiDebugOperation('rhi.read', { artifact, reads: [] }, readContext),
    ).toMatchObject({ ok: false, error: { code: 'read-request-invalid' } });
  });

  it('routes rhi.timing and reports a device without timestamps as a capability mismatch', async () => {
    const encoded = encodeTape(workTape);
    if (!encoded.ok) throw new Error(encoded.error.hint);
    const { context, artifact } = makeContext(encoded.value);
    expect(await runRhiDebugOperation('rhi.timing', { artifact }, context)).toMatchObject({
      ok: false,
      error: { code: 'replay-backend-unavailable' },
    });
    expect(
      await runRhiDebugOperation('rhi.timing', { artifact }, { ...context, createReplayBackend }),
    ).toMatchObject({ ok: false, error: { code: 'replay-capability-mismatch' } });
  });

  it('releases every fresh replay device it opens, including failed operations', async () => {
    const encoded = encodeTape(workTape);
    if (!encoded.ok) throw new Error(encoded.error.hint);
    const { context, artifact } = makeContext(encoded.value);
    const leased = { ...context, createReplayBackend };
    const before = { ...leases };
    await runRhiDebugOperation('rhi.inspect', { artifact, workIndex: 0 }, leased);
    await runRhiDebugOperation(
      'rhi.read',
      { artifact, reads: [{ resourceId: 'buffer:probes' }] },
      leased,
    );
    await runRhiDebugOperation('rhi.timing', { artifact }, leased);
    expect(leases.opened - before.opened).toBe(3);
    expect(leases.released - before.released).toBe(3);
  });
});
