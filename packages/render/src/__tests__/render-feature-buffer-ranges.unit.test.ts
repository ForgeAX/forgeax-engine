import { rhi } from '@forgeax/engine-rhi-null';
import { type BindGroupLayoutEntry, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';

async function fixture(
  entries: readonly BindGroupLayoutEntry[] = [
    { binding: 0, visibility: 4, buffer: { type: 'storage', minBindingSize: 16 } },
  ],
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const limits = vi.spyOn(device, 'limits', 'get').mockReturnValue({
    ...device.limits,
    minUniformBufferOffsetAlignment: 64,
    minStorageBufferOffsetAlignment: 32,
  });
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const session = owner.beginFeature('buffer-ranges', 0);
  const program = session
    .prepareProgram('program', {
      wgsl: 'synthetic',
      entryPoints: ['main'],
      bindings: [{ entries }],
    })
    .unwrap();
  return {
    device,
    session,
    program,
    dispose() {
      owner.dispose().unwrap();
      limits.mockRestore();
    },
  };
}

describe('RenderFeature buffer ranges', () => {
  it('revalidates mutable ranges before reusing an admitted binding entry', async () => {
    const f = await fixture();
    const groups = vi.spyOn(f.device, 'createBindGroup');
    try {
      const buffer = f.session.prepareBuffer('mutable', { size: 512, usage: ['storage'] }).unwrap();
      let size = 32;
      const entry = {
        binding: 0,
        buffer,
        get size() {
          return size;
        },
      };
      const prepare = () =>
        f.session.prepareBindings('mutable', { program: f.program, entries: [entry] });
      const accepted = prepare().unwrap();
      size = 15;
      expect(prepare().ok).toBe(false);
      size = 1024;
      expect(prepare().ok).toBe(false);
      size = 32;
      expect(prepare().unwrap()).toBe(accepted);
      expect(groups).toHaveBeenCalledOnce();
      const borrowed = f.session
        .prepareBindings('mutable', {
          program: f.program,
          entries: [
            { binding: 0, resource: { kind: 'buffer', reference: buffer }, offset: 0, size: 32 },
          ],
        })
        .unwrap();
      expect(borrowed).toBe(accepted);
      expect(groups).toHaveBeenCalledOnce();
    } finally {
      groups.mockRestore();
      f.dispose();
    }
  });

  it('preserves whole-buffer bindings and forwards ranges for owned and prepared buffers', async () => {
    const f = await fixture();
    const groups = vi.spyOn(f.device, 'createBindGroup');
    const external = f.device.createBuffer({ size: 512, usage: 0x0080 }).unwrap();
    try {
      const owned = f.session.prepareBuffer('owned', { size: 512, usage: ['storage'] }).unwrap();
      const physical = f.session.resolveBuffer(owned)?.buffer;
      f.session
        .prepareBindings('whole', { program: f.program, entries: [{ binding: 0, buffer: owned }] })
        .unwrap();
      expect(Array.from(groups.mock.calls[0]?.[0].entries ?? [])[0]?.resource).toEqual({
        kind: 'buffer',
        value: { buffer: physical },
      });
      const prepared = f.session
        .prepareBufferResource('external', external, { size: 512, usage: ['storage'] })
        .unwrap();
      f.session
        .prepareBindings('slice', {
          program: f.program,
          entries: [
            {
              binding: 0,
              resource: { kind: 'buffer', reference: prepared },
              offset: 64,
              size: 32,
            },
          ],
        })
        .unwrap();
      expect(Array.from(groups.mock.calls[1]?.[0].entries ?? [])[0]?.resource).toEqual({
        kind: 'buffer',
        value: { buffer: external, offset: 64, size: 32 },
      });
      f.session
        .prepareBindings('remaining', {
          program: f.program,
          entries: [{ binding: 0, buffer: owned, offset: 32 }],
        })
        .unwrap();
      expect(Array.from(groups.mock.calls[2]?.[0].entries ?? [])[0]?.resource).toEqual({
        kind: 'buffer',
        value: { buffer: physical, offset: 32 },
      });
    } finally {
      groups.mockRestore();
      f.dispose();
      f.device.destroyBuffer(external).unwrap();
    }
  });

  it('includes effective offsets, sizes and binding order in warm binding equality', async () => {
    const f = await fixture([
      { binding: 0, visibility: 4, buffer: { type: 'storage' } },
      { binding: 1, visibility: 4, buffer: { type: 'storage' } },
    ]);
    const groups = vi.spyOn(f.device, 'createBindGroup');
    try {
      const buffer = f.session.prepareBuffer('arena', { size: 512, usage: ['storage'] }).unwrap();
      const bind = (offset: number, size: number, reverse = false) => {
        const entries = [
          { binding: 0, buffer, offset, size },
          { binding: 1, buffer, offset: 256, size: 32 },
        ];
        return f.session
          .prepareBindings('views', {
            program: f.program,
            entries: reverse ? entries.reverse() : entries,
          })
          .unwrap();
      };
      const first = bind(0, 32);
      expect(bind(0, 32)).toBe(first);
      const moved = bind(32, 32);
      expect(moved).not.toBe(first);
      const resized = bind(32, 64);
      expect(resized).not.toBe(moved);
      expect(bind(32, 64, true)).not.toBe(resized);
      expect(groups).toHaveBeenCalledTimes(4);
    } finally {
      groups.mockRestore();
      f.dispose();
    }
  });

  it('validates safe ranges, actual device alignment and reflected minimum binding size', async () => {
    const f = await fixture([
      { binding: 0, visibility: 4, buffer: { type: 'uniform', minBindingSize: 64 } },
      { binding: 1, visibility: 4, buffer: { type: 'storage', minBindingSize: 16 } },
    ]);
    const groups = vi.spyOn(f.device, 'createBindGroup');
    try {
      const uniform = f.session
        .prepareBuffer('uniform', { size: 512, usage: ['uniform'] })
        .unwrap();
      const storage = f.session
        .prepareBuffer('storage', { size: 512, usage: ['storage'] })
        .unwrap();
      for (const range of [
        { offset: -1, size: 64 },
        { offset: 0.5, size: 64 },
        { offset: NaN, size: 64 },
        { offset: Number.MAX_SAFE_INTEGER + 1, size: 64 },
        { offset: 0, size: 0 },
        { offset: 0, size: -1 },
        { offset: 0, size: 64.5 },
        { offset: 0, size: Number.MAX_SAFE_INTEGER + 1 },
        { offset: 512, size: 64 },
        { offset: 448, size: 128 },
        { offset: 32, size: 64 },
        { offset: 64, size: 32 },
      ])
        expect(
          f.session.prepareBindings('invalid', {
            program: f.program,
            entries: [{ binding: 0, buffer: uniform, ...range }],
          }).ok,
        ).toBe(false);
      for (const range of [
        { offset: 16, size: 16 },
        { offset: 32, size: 15 },
        { offset: 32, size: 12 },
      ])
        expect(
          f.session.prepareBindings('invalid-storage', {
            program: f.program,
            entries: [{ binding: 1, buffer: storage, ...range }],
          }).ok,
        ).toBe(false);
      expect(groups).not.toHaveBeenCalled();
      f.session
        .prepareBindings('valid', {
          program: f.program,
          entries: [
            { binding: 0, buffer: uniform, offset: 64, size: 64 },
            { binding: 1, buffer: storage, offset: 32, size: 16 },
          ],
        })
        .unwrap();
      expect(groups).toHaveBeenCalledOnce();
    } finally {
      groups.mockRestore();
      f.dispose();
    }
  });

  it('keeps range aliases on one physical graph dependency across dispatch bindings', async () => {
    const f = await fixture([
      { binding: 0, visibility: 4, buffer: { type: 'storage' } },
      { binding: 1, visibility: 4, buffer: { type: 'read-only-storage' } },
    ]);
    try {
      const arena = f.session.prepareBuffer('arena', { size: 512, usage: ['storage'] }).unwrap();
      const bind = (name: string, offset: number) =>
        f.session
          .prepareBindings(name, {
            program: f.program,
            entries: [
              { binding: 0, buffer: arena, offset, size: 32 },
              { binding: 1, buffer: arena, offset: offset + 32, size: 32 },
            ],
          })
          .unwrap();
      const first = bind('first', 0),
        second = bind('second', 128);
      const work = f.session
        .resolveComputePass('buffer-ranges', {
          program: f.program,
          bindings: first,
          dispatches: [
            { entryPoint: 'main', workgroups: [1] },
            { entryPoint: 'main', bindings: second, workgroups: [1] },
          ],
        })
        .unwrap();
      expect(work.dispatches).toHaveLength(2);
      expect(work.buffers).toEqual([
        {
          name: 'arena',
          buffer: f.session.resolveBuffer(arena)?.buffer,
          size: 512,
          physicalUsage: 0x0080 | 0x0008,
          access: 'storage-read-write',
        },
      ]);
    } finally {
      f.dispose();
    }
  });

  it('writes original data then ordered range uploads while retaining one allocation', async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.device.queue, 'writeBuffer');
    const allocations = vi.spyOn(f.device, 'createBuffer');
    try {
      const tail = new Uint32Array([10, 11]);
      const first = f.session
        .prepareBuffer('arena', {
          size: 16,
          usage: ['storage'],
          data: new Uint32Array([1, 2, 3, 4]),
          uploads: [
            { offset: 4, data: new Uint32Array([9]) },
            { offset: 8, data: new DataView(tail.buffer) },
          ],
        })
        .unwrap();
      expect(writes.mock.calls.map((call) => call[1])).toEqual([0, 4, 8]);
      expect(
        writes.mock.calls.map((call) => {
          const data = call[2];
          if (!ArrayBuffer.isView(data)) throw new Error('Missing byte view');
          return [...new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4)];
        }),
      ).toEqual([[1, 2, 3, 4], [9], [10, 11]]);
      expect(
        f.session
          .prepareBuffer('arena', {
            size: 16,
            usage: ['storage'],
            uploads: [{ offset: 12, data: new Uint32Array([12]) }],
          })
          .unwrap(),
      ).toBe(first);
      expect(writes.mock.calls.map((call) => call[1])).toEqual([0, 4, 8, 12]);
      expect(allocations).toHaveBeenCalledOnce();
    } finally {
      writes.mockRestore();
      allocations.mockRestore();
      f.dispose();
    }
  });

  it('rejects invalid upload batches before any allocation or partial write', async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.device.queue, 'writeBuffer');
    const allocations = vi.spyOn(f.device, 'createBuffer');
    try {
      for (const upload of [
        { offset: -4, data: new Uint32Array(1) },
        { offset: 0.5, data: new Uint32Array(1) },
        { offset: NaN, data: new Uint32Array(1) },
        { offset: Number.MAX_SAFE_INTEGER + 1, data: new Uint32Array(1) },
        { offset: 2, data: new Uint32Array(1) },
        { offset: 16, data: new Uint32Array(1) },
        { offset: 12, data: new Uint32Array(2) },
        { offset: 0, data: new Uint8Array(3) },
      ])
        expect(
          f.session.prepareBuffer('invalid', {
            size: 16,
            usage: ['storage'],
            data: new Uint32Array(4),
            uploads: [{ offset: 0, data: new Uint32Array([1]) }, upload],
          }).ok,
        ).toBe(false);
      expect(
        f.session.prepareBuffer('invalid-data', {
          size: 16,
          usage: ['storage'],
          uploads: [{ offset: 0, data: new Uint8Array(3) }],
        }).ok,
      ).toBe(false);
      expect(writes).not.toHaveBeenCalled();
      expect(allocations).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
      allocations.mockRestore();
      f.dispose();
    }
  });
});
