import { encodeTape, tapeDigest, type V7Tape } from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createCliRhiDebugOperationContext,
  discoverRhiDebugOperations,
  runRhiDebugOperation,
} from '../commands';
import type { RhiDebugOperationContext } from '../rhi-debug/operations';

const emptyTape: V7Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
  bootstrap: [],
  events: [],
  blobs: [],
};

const computeTape: V7Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 7, blobCount: 0 },
  bootstrap: [],
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

async function nullReplayBackend() {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(device.error.hint);
  return ok({ device: device.value, createShaderModule, release: () => {} });
}

function artifactContext(bytes: Uint8Array): RhiDebugOperationContext {
  const artifact = {
    kind: 'rhi-tape' as const,
    digest: tapeDigest(bytes),
    source: 'rhi.capture',
  };
  return {
    captureFrame: async () => ok({ ...artifact, bytes }),
    readArtifact: async () => ({ ok: true as const, value: bytes }),
  };
}

describe('DevKit RHI debug cold start', () => {
  it('starts from discovery and carries one capture artifact into summary', async () => {
    const encoded = encodeTape(emptyTape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const artifact = {
      kind: 'rhi-tape' as const,
      digest: tapeDigest(encoded.value),
      source: 'rhi.capture',
    };
    const operations = discoverRhiDebugOperations();
    expect(operations.map((operation) => operation.name)).toEqual([
      'rhi.capture',
      'rhi.summary',
      'rhi.inspect',
      'rhi.read',
      'rhi.timing',
    ]);
    const context = {
      captureFrame: async () => ok({ ...artifact, bytes: encoded.value }),
      readArtifact: async () => ({ ok: true as const, value: encoded.value }),
    };
    const capture = await runRhiDebugOperation('rhi.capture', {}, context);
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    const summary = await runRhiDebugOperation('rhi.summary', { artifact: capture.value }, context);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.artifact.digest).toBe(capture.value.digest);
    expect(summary.value.summary.works).toEqual([]);
  });

  it('routes capture-unavailable through the standalone CLI recovery contract', async () => {
    const result = await runRhiDebugOperation(
      'rhi.capture',
      {},
      createCliRhiDebugOperationContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('capture-unavailable');
      expect(result.error.detail).toMatchObject({
        stage: 'capture',
        cause: expect.stringContaining('recorder-enabled live host'),
      });
    }
  });

  it('routes an old artifact through strict version recovery', async () => {
    const oldArtifact = new TextEncoder().encode(JSON.stringify({ formatVersion: 5 }));
    const result = await runRhiDebugOperation(
      'rhi.summary',
      {
        artifact: {
          kind: 'rhi-tape',
          digest: tapeDigest(oldArtifact),
          source: 'legacy-source',
        },
      },
      artifactContext(oldArtifact),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('tape-version-unsupported');
  });

  it('routes capability mismatch and unsupported pixel readback by error code', async () => {
    const capabilityTape: V7Tape = {
      ...emptyTape,
      header: { ...emptyTape.header, rhiCaps: { textureCompressionBc: true }, eventCount: 1 },
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
    };
    const capabilityBytes = encodeTape(capabilityTape);
    expect(capabilityBytes.ok).toBe(true);
    if (!capabilityBytes.ok) return;
    const capabilityContext: RhiDebugOperationContext = {
      ...artifactContext(capabilityBytes.value),
      createReplayBackend: nullReplayBackend,
    };
    const capability = await runRhiDebugOperation(
      'rhi.inspect',
      {
        artifact: {
          kind: 'rhi-tape',
          digest: tapeDigest(capabilityBytes.value),
          source: 'rhi.capture',
        },
        workIndex: 0,
      },
      capabilityContext,
    );
    expect(capability.ok).toBe(false);
    if (!capability.ok) expect(capability.error.code).toBe('replay-capability-mismatch');

    const encoded = encodeTape(computeTape);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const readbackContext: RhiDebugOperationContext = {
      ...artifactContext(encoded.value),
      createReplayBackend: nullReplayBackend,
    };
    const readback = await runRhiDebugOperation(
      'rhi.inspect',
      {
        artifact: {
          kind: 'rhi-tape',
          digest: tapeDigest(encoded.value),
          source: 'rhi.capture',
        },
        workIndex: 0,
        fields: ['pixels'],
      },
      readbackContext,
    );
    expect(readback.ok).toBe(false);
    if (!readback.ok) expect(readback.error.code).toBe('readback-unsupported');
  });
});
