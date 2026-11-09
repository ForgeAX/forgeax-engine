import { describe, expect, it } from 'vitest';
import type { RhiCallEvent, Tape } from '../protocol/types';
import {
  steadyBlocker,
  steadyRetainedHandles,
  textureCopies,
  withSteadyCopyUsage,
} from '../replay/timing-steady';

function tapeWith(bootstrap: Tape['bootstrap'], events: Tape['events'] = []): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 0 },
    bootstrap,
    events,
    blobs: [],
  };
}

const storage: Tape['bootstrap'][number] = {
  handleId: 'buf:1',
  kind: 'buffer',
  create: { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 64, usage: 0x80 | 0x4 } },
  initialData: [],
};

describe('steady replay restore', () => {
  it('adds copy usages to mutable buffers and single-sample textures only', () => {
    const buffer = withSteadyCopyUsage(storage.create as unknown as RhiCallEvent);
    expect(buffer).toMatchObject({ desc: { usage: 0x80 | 0x4 | 0x8 } });
    const staging = {
      kind: 'createBuffer',
      handleId: 'buf:2',
      desc: { size: 4, usage: 0x1 | 0x8 },
    } as RhiCallEvent;
    expect(withSteadyCopyUsage(staging)).toBe(staging);
    const target = {
      kind: 'createTexture',
      handleId: 'tex:1',
      desc: { size: [4, 4], format: 'rgba8unorm', usage: 0x10 },
    } as RhiCallEvent;
    expect(withSteadyCopyUsage(target)).toMatchObject({ desc: { usage: 0x10 | 0x1 | 0x2 } });
    const msaa = {
      kind: 'createTexture',
      handleId: 'tex:2',
      desc: { size: [4, 4], format: 'rgba8unorm', usage: 0x10, sampleCount: 4 },
    } as RhiCallEvent;
    expect(withSteadyCopyUsage(msaa)).toBe(msaa);
  });

  it('copies every mip whole, rounding to the block size, with array layers or 3D depth', () => {
    expect(textureCopies({ size: [10, 6, 3], format: 'rgba8unorm', mipLevelCount: 3 })).toEqual([
      { mipLevel: 0, width: 10, height: 6, depthOrArrayLayers: 3 },
      { mipLevel: 1, width: 5, height: 3, depthOrArrayLayers: 3 },
      { mipLevel: 2, width: 2, height: 1, depthOrArrayLayers: 3 },
    ]);
    expect(
      textureCopies({ size: [8, 8, 8], format: 'r8unorm', mipLevelCount: 2, dimension: '3d' })?.[1],
    ).toEqual({ mipLevel: 1, width: 4, height: 4, depthOrArrayLayers: 4 });
    expect(textureCopies({ size: [6, 6], format: 'bc1-rgba-unorm' })?.[0]).toMatchObject({
      width: 8,
      height: 8,
    });
    expect(textureCopies({ size: [4, 4], format: 'not-a-format' })).toBeUndefined();
  });

  it('keeps every bootstrap handle', () => {
    const kept = steadyRetainedHandles(tapeWith([storage]), new Set(['pipe:1']));
    expect([...kept].sort()).toEqual(['buf:1', 'pipe:1']);
  });

  it('falls back when events destroy bootstrap objects or uploads map for writing', () => {
    expect(steadyBlocker(tapeWith([storage]), new Set())).toBeUndefined();
    expect(
      steadyBlocker(tapeWith([storage], [{ kind: 'destroyBuffer', handleId: 'buf:1' }]), new Set()),
    ).toMatch(/destroys bootstrap resource buf:1/);
    const upload: Tape['bootstrap'][number] = {
      ...storage,
      handleId: 'buf:3',
      create: { kind: 'createBuffer', handleId: 'buf:3', desc: { size: 4, usage: 0x2 | 0x4 } },
    };
    expect(steadyBlocker(tapeWith([upload]), new Set())).toMatch(/mappable for writing/);
  });
});
