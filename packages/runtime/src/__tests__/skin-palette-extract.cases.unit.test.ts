// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { mat4 } from '@forgeax/engine-math';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSkinPaletteAllocator } from '../../../render/src/systems/skin-palette-allocator';

afterEach(() => vi.restoreAllMocks());
{
  // --- from skin-palette-extract.test.ts ---

  // We test the allocator logic directly by mocking the RhiDevice.
  // The createSkinPaletteAllocator function takes a real RhiDevice,
  // but we can test allocateSlice and writeJointPalette through the
  // public API after a real device is provided.
  // For unit-testing grow/overflow logic, we test the allocator helper
  // functions extracted from the implementation.

  const MAX_BINDING = 128 * 1024 * 1024; // 128 MiB

  describe('skin palette allocator', () => {
    function mockDevice(capacity: number = MAX_BINDING) {
      const buffers: Array<{ size: number }> = [];
      const written: Array<{ offset: number; data: Float32Array }> = [];
      return {
        device: {
          createBuffer: (desc: { size: number; usage: number; mappedAtCreation: boolean }) => {
            if (desc.size > capacity) {
              return { ok: false, error: new Error('limit-exceeded') };
            }
            const buf = { size: desc.size, _id: buffers.length };
            buffers.push(buf);
            return { ok: true, value: buf };
          },
          queue: {
            writeBuffer: (_buf: unknown, offset: number, data: Float32Array) => {
              written.push({ offset, data });
              return { ok: true };
            },
            onSubmittedWorkDone: async () => undefined,
          },
          destroyBuffer: () => ({ ok: true, value: undefined }),
        } as unknown as Parameters<typeof createSkinPaletteAllocator>[0],
        buffers,
        written,
      };
    }

    it('allocateSlice returns correct byteOffset and jointCount', () => {
      const { device } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      const slice = alloc.allocateSlice(5);
      expect(slice.jointCount).toBe(5);
      expect(slice.byteOffset).toBe(0);
    });

    it('consecutive allocations stack offsets rounded up to 256-byte alignment', () => {
      const { device } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      const s1 = alloc.allocateSlice(3);
      expect(s1.jointCount).toBe(3);
      expect(s1.byteOffset).toBe(0);
      const s2 = alloc.allocateSlice(2);
      expect(s2.jointCount).toBe(2);
      // 3 joints * 64 = 192, rounded up to the 256-byte dynamic-offset
      // alignment (WebGPU minStorageBufferOffsetAlignment) -> 256, NOT 192.
      expect(s2.byteOffset).toBe(256);
    });

    // Regression for the hellforge crash: a skinned char with 33 joints made
    // the 1st slice's tight footprint 33*64 = 2112, which is not a multiple of
    // 256 (2112 = 256 * 8.25). The 2nd slice then bound at dynOffset 2112 and
    // tripped `Dynamic Offset[1] (2112) is not 256 byte aligned` at draw time.
    // Every slice's byteOffset must be 256-aligned regardless of joint count.
    it('every slice byteOffset stays 256-aligned even for non-aligned joint counts', () => {
      const { device } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, 262144);
      // Joint counts whose *64 footprint is NOT a multiple of 256:
      // 33*64=2112, 17*64=1088, 5*64=320 — all misaligned pre-fix.
      const offsets = [33, 17, 5, 40].map((jc) => alloc.allocateSlice(jc).byteOffset);
      expect(offsets[0]).toBe(0);
      for (const off of offsets) {
        expect(off % 256).toBe(0);
      }
      // Offsets must also be strictly increasing (no overlap after rounding).
      for (let i = 1; i < offsets.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: fixed-length map above
        expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
      }
    });

    it('resetForFrame rewinds cursor', () => {
      const { device } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      alloc.allocateSlice(10);
      alloc.resetForFrame();
      const s = alloc.allocateSlice(1);
      expect(s.byteOffset).toBe(0);
    });

    it('grow allocates buffer lazily on first request', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // M6: allocator.buffer field retired in favour of per-slice
      // `slice.buffer` (uniform fallback path needs per-entity buffers).
      // Lazy allocation surface is now: 0 buffers before first
      // allocateSlice, >=1 buffer after.
      expect(buffers.length).toBe(0);
      const slice = alloc.allocateSlice(1);
      expect(slice.buffer).toBeDefined();
      expect(buffers.length).toBe(1);
      // Initial capacity = MAX_JOINTS * 64 = 255 * 64 = 16320 (storage
      // path's first grow step; uniform fallback would also start at
      // exactly 16320 since each pool entry equals one binding window).
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[0]!.size).toBe(255 * 64);
    });

    it('grow at 1.5x when binding window exceeds capacity', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // First alloc (offset=0): needed = 0 + bindingWindowBytes (16320)
      // -> grow to 16320 exactly (initial = 255 * 64).
      alloc.allocateSlice(255);
      expect(buffers.length).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[0]!.size).toBe(16320);
      // Second alloc (offset=255*64=16320): needed = 16320 + 16320 = 32640.
      // 1.5x grow: 16320 -> 24576 -> 36864 (smallest aligned >= 32640).
      alloc.allocateSlice(100);
      expect(buffers.length).toBe(2);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[1]!.size).toBe(36864);
    });

    // M6 regression gate: the bug that this fix repairs reproduces here as
    // a SkinPaletteOverflowError under the old allocator (cap=16320, grow
    // gated on `cursor + jointCount * 64`). Under the new allocator the
    // 2nd entity would need `offset=1536 + window=16320 = 17856 B`, so a
    // cap of 16320 must reject during grow -- but a realistic device cap
    // (storage limit / uniform spec floor 64 KiB) must accept it.
    it('two skin entities at byteOffset 0 and 1536 stay within buffer (M6)', () => {
      const { device, buffers } = mockDevice();
      // 64 KiB == WebGPU spec floor for maxUniformBufferBindingSize.
      const alloc = createSkinPaletteAllocator(device, 65536);
      const s0 = alloc.allocateSlice(24); // Fox: 24 joints
      const s1 = alloc.allocateSlice(24);
      expect(s0.byteOffset).toBe(0);
      expect(s1.byteOffset).toBe(24 * 64); // 1536, matches the WebGPU error
      // The allocator must satisfy `buffer.size >= byteOffset + window`
      // for every slice so `setBindGroup(_, _, [_, dynOffset=1536])` with
      // an `entry.size = 16320` BG passes `dynOffset + entry.size <=
      // buffer.size` validation.
      const lastBuf = buffers[buffers.length - 1];
      expect(lastBuf?.size).toBeGreaterThanOrEqual(s1.byteOffset + 255 * 64);
    });

    it('overflow fails-fast with SkinPaletteOverflowError', () => {
      // Cap below one binding window (16320) -> first allocateSlice grows
      // and overflows.
      const { device } = mockDevice(1000);
      const alloc = createSkinPaletteAllocator(device, 1000);
      expect(() => alloc.allocateSlice(20)).toThrow();
    });

    it('overflow fails-fast when 2nd entity would breach cap (M6)', () => {
      // Cap == one binding window. First entity (offset=0) fits, second
      // entity (offset=1536) would need 17856 B and must throw.
      const { device } = mockDevice(16320);
      const alloc = createSkinPaletteAllocator(device, 16320);
      alloc.allocateSlice(24); // offset=0, fits in 16320
      expect(() => alloc.allocateSlice(24)).toThrow(); // offset=1536, needs 17856 > 16320
    });

    // M6 uniform fallback path: each slice gets its OWN 16320 B UBO
    // (the cap=16384 storage-buffer-disabled browser case). Slice
    // byteOffset is always 0; slice.buffer is path-specific.
    it('uniform fallback: each entity gets its own buffer + byteOffset 0 (M6)', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, 16384, /* useStorageBuffer */ false);
      expect(alloc.useStorageBuffer).toBe(false);
      const s0 = alloc.allocateSlice(24);
      const s1 = alloc.allocateSlice(24);
      const s2 = alloc.allocateSlice(24);
      expect(s0.byteOffset).toBe(0);
      expect(s1.byteOffset).toBe(0);
      expect(s2.byteOffset).toBe(0);
      expect(s0.buffer).not.toBe(s1.buffer);
      expect(s1.buffer).not.toBe(s2.buffer);
      expect(s0.buffer).not.toBe(s2.buffer);
      // Three entities -> three distinct UBOs of size = bindingWindowBytes.
      expect(buffers.length).toBe(3);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[0]!.size).toBe(16320);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[1]!.size).toBe(16320);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[2]!.size).toBe(16320);
    });

    it('uniform fallback: pool reuses buffers across frames (M6)', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, 16384, false);
      // Frame 1: 3 entities -> 3 buffers minted.
      const f1s0 = alloc.allocateSlice(10);
      const f1s1 = alloc.allocateSlice(10);
      const f1s2 = alloc.allocateSlice(10);
      expect(buffers.length).toBe(3);
      // Frame 2: reset + same-shape walk -> pool round-robin, no new
      // createBuffer calls. Slices reuse the exact same buffer objects.
      alloc.resetForFrame();
      const f2s0 = alloc.allocateSlice(10);
      const f2s1 = alloc.allocateSlice(10);
      const f2s2 = alloc.allocateSlice(10);
      expect(buffers.length).toBe(3); // unchanged
      expect(f2s0.buffer).toBe(f1s0.buffer);
      expect(f2s1.buffer).toBe(f1s1.buffer);
      expect(f2s2.buffer).toBe(f1s2.buffer);
    });

    it('CPU premul writes correct mat4 values', () => {
      const { device, written } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // Identity joint_world * identity IBM = identity
      const jw = mat4.create();
      mat4.identity(jw);
      // IBM: identity matrix
      const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const slice = alloc.allocateSlice(1);
      alloc.writeJointPalette(slice, [ibm], [jw]);
      expect(written.length).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(written[0]!.offset).toBe(slice.byteOffset);
      // Expected: identity mat4 in column-major order
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const payload = written[0]!.data;
      expect(payload[0]).toBeCloseTo(1); // col 0 row 0
      expect(payload[1]).toBeCloseTo(0);
      expect(payload[2]).toBeCloseTo(0);
      expect(payload[3]).toBeCloseTo(0);
      expect(payload[4]).toBeCloseTo(0); // col 1 row 0
      expect(payload[5]).toBeCloseTo(1);
      expect(payload[15]).toBeCloseTo(1); // col 3 row 3
    });

    it('CPU premul: joint_world * IBM multiplication is correct', () => {
      const { device, written } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // joint_world: translate (2, 0, 0)
      const jw = mat4.create();
      mat4.translate(jw, mat4.identity(mat4.create()), [2, 0, 0]);
      // IBM: identity
      const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const slice = alloc.allocateSlice(1);
      alloc.writeJointPalette(slice, [ibm], [jw]);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const payload = written[0]!.data;
      // Column 3 should have translation (2, 0, 0, 1)
      // Column-major: element 12 = col 3 row 0 = tx
      expect(payload[12]).toBeCloseTo(2);
      expect(payload[13]).toBeCloseTo(0);
      expect(payload[14]).toBeCloseTo(0);
      expect(payload[15]).toBeCloseTo(1);
    });

    // feat-20260601 w12/w13: skin joint world matrices now flow from the resolved
    // `Transform.world` column array view (a raw 16-float `Float32Array`, written
    // by propagateTransforms) straight into the allocator's `readonly Mat4[]`
    // jointWorlds parameter -- zero recompose from decomposed TRS. The allocator
    // contract is unchanged; this guards that a bare Transform.world-shaped
    // Float32Array premultiplies against the IBM exactly like a `mat4.create()`.
    it('accepts a Transform.world-shaped Float32Array as a joint world matrix', () => {
      const { device, written } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // A Transform.world view is a plain 16-float column-major Float32Array.
      // Here: translation (0, 3, 0) -- the shape a `world._getArrayView(joint,
      // Transform, 'world')` read returns after propagate.
      const jointWorldView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
      const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const slice = alloc.allocateSlice(1);
      alloc.writeJointPalette(
        slice,
        [ibm],
        [jointWorldView as unknown as Parameters<typeof alloc.writeJointPalette>[2][number]],
      );

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const payload = written[0]!.data;
      expect(payload[12]).toBeCloseTo(0);
      expect(payload[13]).toBeCloseTo(3);
      expect(payload[14]).toBeCloseTo(0);
      expect(payload[15]).toBeCloseTo(1);
    });
  });
}
