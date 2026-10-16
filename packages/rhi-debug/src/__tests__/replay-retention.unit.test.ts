import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { digestBytes } from '../protocol/codec';
import type { BootstrapResource, RhiCallEvent, Tape } from '../protocol/types';
import { retainedReplayHandles } from '../replay/retention';

function resource(
  handleId: string,
  kind: BootstrapResource['kind'],
  create: Record<string, unknown>,
): BootstrapResource {
  return { handleId, kind, create: { handleId, ...create }, initialData: [] };
}

function tape(events: readonly Record<string, unknown>[]): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 0 },
    bootstrap: [
      resource('buffer:vertex', 'buffer', {
        kind: 'createBuffer',
        desc: { size: 16, usage: 0x28 },
      }),
      resource('buffer:storage', 'buffer', {
        kind: 'createBuffer',
        desc: { size: 16, usage: 0x88 },
      }),
      resource('buffer:uniform', 'buffer', {
        kind: 'createBuffer',
        desc: { size: 16, usage: 0x48 },
      }),
      resource('texture:albedo', 'texture', {
        kind: 'createTexture',
        desc: { format: 'rgba8unorm', usage: 0x06 },
      }),
      resource('texture:target', 'texture', {
        kind: 'createTexture',
        desc: { format: 'rgba8unorm', usage: 0x14 },
      }),
      resource('texture:depth', 'texture', {
        kind: 'createTexture',
        desc: { format: 'depth24plus', usage: 0x04 },
      }),
      {
        handleId: 'view:albedo',
        kind: 'texture-view',
        create: { kind: 'createTextureView', sourceHandleId: 'texture:albedo' },
        initialData: [],
      },
      {
        handleId: 'view:target',
        kind: 'texture-view',
        create: { kind: 'createTextureView', sourceHandleId: 'texture:target' },
        initialData: [],
      },
      resource('sampler:linear', 'sampler', { kind: 'createSampler', desc: {} }),
      resource('shader:main', 'shader-module', { kind: 'createShaderModule', wgslCode: '' }),
      resource('layout:main', 'binding', { kind: 'createBindGroupLayout', desc: {} }),
      resource('pipeline:main', 'pipeline', { kind: 'createRenderPipeline', desc: {} }),
      resource('group:static', 'binding', {
        kind: 'createBindGroup',
        layoutHandleId: 'layout:main',
        resourceHandleIds: ['view:albedo', 'sampler:linear', 'buffer:vertex'],
        entries: [],
      }),
      resource('group:frame', 'binding', {
        kind: 'createBindGroup',
        layoutHandleId: 'layout:main',
        resourceHandleIds: ['view:albedo', 'buffer:uniform'],
        entries: [],
      }),
    ],
    events: events as unknown as RhiCallEvent[],
    blobs: [],
  };
}

describe('replay retention', () => {
  it('retains only objects no recorded event can change', () => {
    const retained = retainedReplayHandles(
      tape([
        {
          kind: 'writeBuffer',
          handleId: 'buffer:uniform',
          bufferOffset: 0,
          dataHash: 'x',
          size: 4,
        },
        { kind: 'createComputePipeline', handleId: 'pipeline:compute', desc: {} },
      ]),
    );
    expect([...retained].sort()).toEqual(
      [
        'buffer:vertex',
        'group:static',
        'layout:main',
        'pipeline:compute',
        'pipeline:main',
        'sampler:linear',
        'shader:main',
        'texture:albedo',
        'view:albedo',
      ].sort(),
    );
  });

  it('drops a resource once a copy or destroy names it, and its views and bind groups with it', () => {
    const retained = retainedReplayHandles(
      tape([
        {
          kind: 'copyTextureToTexture',
          cmdHandleId: 'encoder:0',
          source: { textureHandleId: 'texture:target' },
          destination: { textureHandleId: 'texture:albedo' },
        },
      ]),
    );
    expect(retained.has('texture:albedo')).toBe(false);
    expect(retained.has('view:albedo')).toBe(false);
    expect(retained.has('group:static')).toBe(false);
    expect(retained.has('buffer:vertex')).toBe(true);
  });
});

describe('tape digest', () => {
  it('matches the portable SHA-256 for empty, small and multi-block inputs', () => {
    for (const length of [0, 1, 63, 64, 65, 1 << 20]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 31 + 7) & 0xff);
      expect(digestBytes(bytes)).toBe(`sha256:${bytesToHex(sha256(bytes))}`);
    }
  });
});
