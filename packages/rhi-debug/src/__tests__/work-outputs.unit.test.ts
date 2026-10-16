import { describe, expect, it } from 'vitest';
import { layoutEntryAccess, wgslBindingAccess } from '../binding-access';
import type { WorkEntry } from '../frame-model';
import { depthImage, toRgba8 } from '../image';
import type { Tape } from '../protocol/types';
import { validateTape } from '../protocol/validation';
import { workOutputs } from '../replay/outputs';

describe('binding access', () => {
  it('derives access from explicit layout entries', () => {
    const entry = (fields: object) => ({ binding: 0, visibility: 4, ...fields });
    expect(layoutEntryAccess(entry({ buffer: { type: 'storage' } }))).toBe('read-write');
    expect(layoutEntryAccess(entry({ buffer: { type: 'read-only-storage' } }))).toBe('read');
    expect(layoutEntryAccess(entry({ buffer: {} }))).toBe('read');
    expect(layoutEntryAccess(entry({ storageTexture: { format: 'r32float' } }))).toBe('write');
    expect(
      layoutEntryAccess(entry({ storageTexture: { format: 'r32float', access: 'read-write' } })),
    ).toBe('read-write');
    expect(layoutEntryAccess(entry({ texture: {} }))).toBe('read');
  });

  it('derives access from WGSL declarations for auto layouts', () => {
    const access = wgslBindingAccess([
      `@group(0) @binding(0) var<uniform> u: vec4f;
       @binding(1) @group(0) var<storage, read_write> rw: array<u32>;
       @group(1) @binding(0) var<storage> ro: array<u32>;
       @group(1) @binding(1) var out: texture_storage_2d_array<rgba16float, write>;
       @group(1) @binding(2) var io: texture_storage_2d<r32float, read_write>;
       @group(2) @binding(0) var t: texture_depth_2d_array;`,
      null,
    ]);
    expect(Object.fromEntries(access)).toEqual({
      '0:0': 'read',
      '0:1': 'read-write',
      '1:0': 'read',
      '1:1': 'write',
      '1:2': 'read-write',
      '2:0': 'read',
    });
  });
});

describe('workOutputs', () => {
  it('lists color, depth and writable storage outputs of one work', () => {
    const binding = (binding: number, access: string, resourceKind: string) => ({
      groupIndex: 0,
      binding,
      bindGroupId: 'group',
      resourceId: `res:${binding}`,
      resourceKind,
      bufferOffset: resourceKind === 'buffer' ? 0 : null,
      bufferSize: resourceKind === 'buffer' ? 64 : null,
      dynamicOffset: null,
      access,
    });
    const work = {
      workIndex: 2,
      attachments: {
        colorViewHandleIds: ['view:hdr', 'view:volume'],
        colorResolveViewHandleIds: ['view:resolved', null],
        colorDepthSlices: [null, 3],
        depthStencilViewHandleId: 'view:depth',
      },
      bindings: [
        binding(0, 'read', 'buffer'),
        binding(1, 'read-write', 'buffer'),
        binding(2, 'write', 'textureView'),
        binding(3, 'unknown', 'buffer'),
      ],
    } as unknown as WorkEntry;
    expect(workOutputs(work)).toEqual([
      { name: 'color0', role: 'color', request: { resourceId: 'view:resolved', workIndex: 2 } },
      {
        name: 'color1',
        role: 'color',
        request: {
          resourceId: 'view:volume',
          workIndex: 2,
          subresource: { mipLevel: 0, arrayLayer: 3 },
        },
      },
      {
        name: 'depth',
        role: 'depth',
        request: {
          resourceId: 'view:depth',
          workIndex: 2,
          subresource: { mipLevel: 0, arrayLayer: 0, aspect: 'depth-only' },
        },
      },
      {
        name: '@group(0)@binding(1)',
        role: 'storage-buffer',
        request: { resourceId: 'res:1', workIndex: 2, subresource: { offset: 0, size: 64 } },
      },
      {
        name: '@group(0)@binding(2)',
        role: 'storage-texture',
        request: { resourceId: 'res:2', workIndex: 2 },
      },
    ]);
  });
});

describe('depth images', () => {
  const raw = { width: 2, height: 1, data: new Float32Array([0.5, 0, 0, 1, 1, 0, 0, 1]) };

  it('broadcasts raw depth and linearizes perspective and orthographic projections', () => {
    expect([...depthImage(raw).data]).toEqual([0.5, 0.5, 0.5, 1, 1, 1, 1, 1]);
    expect(depthImage(raw, { near: 1, far: 3 }).data[0]).toBeCloseTo(1.5, 6);
    expect(depthImage(raw, { near: 0.1, far: Infinity, reverseZ: true }).data[0]).toBeCloseTo(
      0.2,
      6,
    );
    expect(depthImage(raw, { near: 2, far: 10, orthographic: true }).data[4]).toBe(10);
  });

  it("maps the finite RGB span to 0..255 with range 'auto'", () => {
    const linear = depthImage(raw, { near: 2, far: 10, orthographic: true });
    expect([...toRgba8(linear, { range: 'auto' })]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe('seed scope validation', () => {
  const resource = {
    handleId: 'buf:1',
    kind: 'buffer',
    create: { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 4, usage: 8 } },
    initialData: [],
  };
  const tape = (bootstrap: object): Tape =>
    ({
      header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
      bootstrap: [bootstrap],
      events: [],
      blobs: [],
    }) as unknown as Tape;

  it('accepts an omitted seed and rejects other markers or omitted seeds with bytes', () => {
    expect(validateTape(tape({ ...resource, seed: 'omitted' })).ok).toBe(true);
    expect(validateTape(tape({ ...resource, seed: 'partial' })).ok).toBe(false);
    expect(
      validateTape(
        tape({
          ...resource,
          seed: 'omitted',
          initialData: [{ hash: 'sha256:00', byteOffset: 0, byteLength: 4 }],
        }),
      ).ok,
    ).toBe(false);
  });
});
