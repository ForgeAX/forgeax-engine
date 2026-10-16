import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createMeshSsboGrowController,
  meshSsboBufferBinding,
  writeMeshSsboBuffer,
} from '../assembly/mesh-ssbo-grow';
import { DeviceScope } from '../lifecycle';

function fixture(paged: boolean, uniformLimit?: number) {
  const bytes = new Map<Buffer, Uint8Array>();
  const destroyed: Buffer[] = [];
  const scope = DeviceScope.create(0, 'draw-buffer-test');
  let failAfter = Number.POSITIVE_INFINITY;
  const device = {
    limits: {
      maxStorageBufferBindingSize: 134217728,
      ...(uniformLimit === undefined ? {} : { maxUniformBufferBindingSize: uniformLimit }),
    },
    createBuffer: ({ size }: { size: number }) => {
      if (bytes.size >= failAfter) throw new Error('allocation failure');
      const buffer = {} as Buffer;
      bytes.set(buffer, new Uint8Array(size));
      return buffer;
    },
    destroyBuffer: (buffer: Buffer) => {
      destroyed.push(buffer);
    },
  };
  const queue = {
    writeBuffer: (
      buffer: Buffer,
      offset: number,
      data: Uint8Array,
      dataOffset = 0,
      size = data.byteLength - dataOffset,
    ) => {
      const destination = bytes.get(buffer);
      if (destination === undefined || offset + size > destination.length)
        throw new Error('write outside physical buffer');
      destination.set(data.subarray(dataOffset, dataOffset + size), offset);
      return ok(undefined);
    },
  } as unknown as RhiQueue;
  const controller = createMeshSsboGrowController({
    device,
    scope,
    errorRegistry: { fire: () => {} },
    initialSlotCount: 1024,
    materialStride: 1280,
    meshStride: 256,
    meshBindingSize: paged ? 10240 : 256,
    materialBindingSize: 1184,
    meshUsage: paged ? 72 : 136,
    materialUsage: 72,
    uniformPages: paged,
  });
  return {
    controller,
    queue,
    bytes,
    destroyed,
    scope,
    failNext: () => {
      failAfter = bytes.size + 1;
    },
  };
}

describe('bounded draw buffer pages', () => {
  it.each([
    [undefined, 16384],
    [0, 16384],
    [Number.NaN, 16384],
    [65536, 16384],
    [16384, 16384],
    [12288, 12288],
  ] as const)('allocates usable pages with uniform binding limit %s', (limit, ceiling) => {
    const f = fixture(true, limit);
    f.controller.initialBuild();
    expect(f.controller.state.meshSlotCount).toBeGreaterThan(0);
    expect(f.controller.growMeshSsbo(50, 50).ok).toBe(true);
    expect([...f.bytes.values()].every((value) => value.length <= ceiling)).toBe(true);
    for (const [stream, stride] of [
      [f.controller.state.mesh, 256],
      [f.controller.state.material, 1280],
    ] as const) {
      const payload = new Uint8Array(50 * stride).fill(17);
      writeMeshSsboBuffer(f.queue, stream, 0, payload);
      for (const slot of [0, 24, 25, 49]) {
        const binding = meshSsboBufferBinding(stream, slot * stride);
        expect(f.bytes.get(binding.buffer)?.[binding.byteOffset]).toBe(17);
      }
    }
    f.scope.dispose();
    expect(new Set(f.destroyed).size).toBe(f.bytes.size);
  });

  it('bounds backing allocations and preserves every byte of crossing mesh binding windows', () => {
    const f = fixture(true);
    f.controller.initialBuild();
    expect(f.controller.growMeshSsbo(50, 50).ok).toBe(true);
    expect([...f.bytes.values()].every((value) => value.length <= 16384)).toBe(true);
    const payload = Uint8Array.from(
      { length: 50 * 256 },
      (_, i) => (i * 31 + Math.floor(i / 256)) % 251,
    );
    writeMeshSsboBuffer(f.queue, f.controller.state.mesh, 0, payload);
    for (const slot of [0, 12, 24, 25, 49]) {
      const binding = meshSsboBufferBinding(f.controller.state.mesh, slot * 256);
      const actual = f.bytes
        .get(binding.buffer)
        ?.subarray(binding.byteOffset, binding.byteOffset + 10240);
      const expected = new Uint8Array(10240);
      expected.set(payload.subarray(slot * 256, slot * 256 + 10240));
      expect(actual).toEqual(expected);
    }
    const delta = new Uint8Array(256).fill(231);
    writeMeshSsboBuffer(f.queue, f.controller.state.mesh, 25 * 256, delta);
    for (const slot of [0, 24, 25]) {
      const binding = meshSsboBufferBinding(f.controller.state.mesh, slot * 256);
      expect(
        f.bytes
          .get(binding.buffer)
          ?.subarray(
            binding.byteOffset + (25 - slot) * 256,
            binding.byteOffset + (26 - slot) * 256,
          ),
      ).toEqual(delta);
    }
    f.scope.dispose();
    expect(new Set(f.destroyed).size).toBe(f.bytes.size);
  });

  it('keeps material page offsets aligned, and routes cross-page writes into the selected bindings', () => {
    const f = fixture(true);
    f.controller.initialBuild();
    f.controller.growMeshSsbo(30, 30);
    const payload = Uint8Array.from({ length: 30 * 1280 }, (_, i) => Math.floor(i / 1280));
    writeMeshSsboBuffer(f.queue, f.controller.state.material, 0, payload);
    const a = meshSsboBufferBinding(f.controller.state.material, 11 * 1280);
    const b = meshSsboBufferBinding(f.controller.state.material, 12 * 1280);
    expect(a.buffer).not.toBe(b.buffer);
    expect(b.byteOffset).toBe(0);
    for (const slot of [0, 11, 12, 23, 24, 29]) {
      const binding = meshSsboBufferBinding(f.controller.state.material, slot * 1280);
      expect(binding.byteOffset % 256).toBe(0);
      expect(
        f.bytes.get(binding.buffer)?.subarray(binding.byteOffset, binding.byteOffset + 1184),
      ).toEqual(new Uint8Array(1184).fill(slot));
    }
  });

  it('keeps storage in one arena with the true mesh stride', () => {
    const f = fixture(false);
    f.controller.initialBuild();
    expect(f.bytes.get(f.controller.state.mesh.buffer as Buffer)?.length).toBe(1024 * 256);
    expect(f.bytes.get(f.controller.state.material.buffer as Buffer)?.length).toBe(1024 * 1280);
    expect(meshSsboBufferBinding(f.controller.state.mesh, 20 * 256)).toEqual({
      buffer: f.controller.state.mesh.buffer,
      byteOffset: 20 * 256,
    });
  });

  it('does not publish a partial growth and destroys allocations from a failed candidate', () => {
    const f = fixture(true);
    f.controller.initialBuild();
    const slots = f.controller.state.meshSlotCount;
    const binding = meshSsboBufferBinding(f.controller.state.material, 0);
    f.failNext();
    expect(() => f.controller.growMeshSsbo(100, 100)).toThrow('allocation failure');
    expect(f.controller.state.meshSlotCount).toBe(slots);
    expect(meshSsboBufferBinding(f.controller.state.material, 0)).toEqual(binding);
    expect(f.destroyed).toHaveLength(1);
  });

  it.each([false, true])('grows only the demanded stream (paged=%s)', (paged) => {
    const f = fixture(paged);
    f.controller.initialBuild();
    const beforeMaterial = { ...f.controller.state.material };
    const materialSlots = f.controller.state.materialSlotCount;
    expect(f.controller.growMeshSsbo(4096, 1)).toEqual({ ok: true });
    expect(f.controller.state.meshSlotCount).toBe(4096);
    expect(f.controller.state.materialSlotCount).toBe(materialSlots);
    expect(f.controller.state.material.buffer).toBe(beforeMaterial.buffer);
    expect(f.controller.state.material.pages?.buffers).toBe(beforeMaterial.pages?.buffers);
    expect(f.controller.state.material.sizeInBytes).toBe(beforeMaterial.sizeInBytes);
    const mesh = { ...f.controller.state.mesh };
    expect(f.controller.growMeshSsbo(4096, 2048)).toEqual({ ok: true });
    expect(f.controller.state.materialSlotCount).toBe(2048);
    expect(f.controller.state.mesh.buffer).toBe(mesh.buffer);
    expect(f.controller.state.mesh.pages?.buffers).toBe(mesh.pages?.buffers);
    expect(f.controller.state.mesh.sizeInBytes).toBe(mesh.sizeInBytes);
    const allocations = f.bytes.size;
    expect(f.controller.growMeshSsbo(4096, 2048)).toEqual({ ok: true });
    expect(f.bytes.size).toBe(allocations);
    f.scope.dispose();
  });

  it.each([false, true])('rolls back both independent candidates (paged=%s)', (paged) => {
    const f = fixture(paged);
    f.controller.initialBuild();
    const before = {
      ...f.controller.state,
      mesh: { ...f.controller.state.mesh },
      material: { ...f.controller.state.material },
    };
    f.failNext();
    // One new mesh allocation/page succeeds, the material allocation fails.
    const meshSlots = paged ? before.meshSlotCount + 1 : 4096;
    expect(() => f.controller.growMeshSsbo(meshSlots, 2048)).toThrow('allocation failure');
    expect(f.controller.state).toEqual(before);
    for (const stream of ['mesh', 'material'] as const) {
      expect(f.controller.state[stream].buffer).toBe(before[stream].buffer);
      expect(f.controller.state[stream].pages?.buffers).toBe(before[stream].pages?.buffers);
    }
    expect(f.destroyed).toHaveLength(1);
    f.scope.dispose();
  });

  it('accounts for the binding tail when enforcing each stream ceiling', () => {
    const allocations: number[] = [];
    const errors: unknown[] = [];
    const controller = createMeshSsboGrowController({
      device: {
        limits: { maxStorageBufferBindingSize: 1024 },
        createBuffer: ({ size }) => {
          allocations.push(size);
          return {} as Buffer;
        },
      },
      errorRegistry: { fire: (error) => errors.push(error) },
      initialSlotCount: 1,
      meshStride: 256,
      meshBindingSize: 512,
      materialStride: 512,
      materialBindingSize: 768,
      meshUsage: 136,
      materialUsage: 72,
    });
    controller.initialBuild();
    expect(controller.growMeshSsbo(3, 1)).toEqual({ ok: true });
    expect(allocations).toEqual([512, 768, 1024]);
    const retained = { meshSlotCount: 3, materialSlotCount: 1 };
    expect(controller.growMeshSsbo(4, 1)).toEqual({
      ok: false,
      code: 'mesh-ssbo-ceiling-reached',
      degradedTo: retained,
    });
    expect(controller.growMeshSsbo(3, 2)).toEqual({
      ok: false,
      code: 'mesh-ssbo-ceiling-reached',
      degradedTo: retained,
    });
    expect(allocations).toEqual([512, 768, 1024]);
    expect(errors).toHaveLength(2);
  });
});
