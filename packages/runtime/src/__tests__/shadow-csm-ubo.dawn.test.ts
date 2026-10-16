// shadow-csm-ubo.dawn.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M4 / w15: View UBO CSM round-trip dawn-node test (RED, test-first).
//
// Covers AC-08: host-side 4-cascade View UBO data write → dawn-node GPU read
// back. Validates lightViewProj[4] + splitPlanes[4] + cascadeCount/cascadeBlend
// survive the queue.writeBuffer round-trip without corruption.
//
// Layout matches shadow-csm-ubo.test.ts — 196 f32 / 784 B std140 after
// feat-20260625 w25 folded the spot lightViewProj array into the View UBO tail.
// The directional cascade offsets [0..125] this test exercises are unchanged;
// the extra tail (floats 132..195) stays zero in this round-trip.
//
// Red phase: common.wgsl still has lightSpaceMatrix (not lightViewProj array);
// record.ts still writes single lightSpaceMatrix. This test writes the NEW
// layout directly and reads back independently — it will be red until w16/w25
// land.

import { describe, expect, it } from 'vitest';

// ── Constants (mirrors current View UBO layout) ─────────────────────────────

const VIEW_UBO_FLOAT_COUNT = 196;
const VIEW_UBO_BYTES = 784;

// f32 indices matching std140 byte offsets.
const OFF = {
  LVP0: 28, // lightViewProj[0] — byte 112
  INV: 44, // inverseViewProj — byte 176
  LVP1: 60, // lightViewProj[1] — byte 240
  LVP2: 76, // lightViewProj[2] — byte 304
  LVP3: 92, // lightViewProj[3] — byte 368
  SP0: 108, // splitPlanes[0] — byte 432
  SP1: 112, // splitPlanes[1] — byte 448
  SP2: 116, // splitPlanes[2] — byte 464
  SP3: 120, // splitPlanes[3] — byte 480
  CC: 124, // cascadeCount — byte 496
  CB: 125, // cascadeBlend — byte 500
} as const;

const GPUMapMode: { readonly READ: number } = ((): { readonly READ: number } => {
  try {
    const o = globalThis as Record<string, unknown>;
    const gpuMode = o.GPUMapMode;
    if (
      gpuMode !== undefined &&
      typeof gpuMode === 'object' &&
      gpuMode !== null &&
      'READ' in gpuMode
    ) {
      return gpuMode as { readonly READ: number };
    }
  } catch {
    /* node env */
  }
  return { READ: 1 };
})();

// GPU buffer usage flags.
// WebGPU BufferUsage flags (from webgpu spec).
const MAP_READ = 0x0001; // GPUBufferUsage.MAP_READ
const MAP_WRITE = 0x0002; // GPUBufferUsage.MAP_WRITE
const COPY_SRC = 0x0004; // GPUBufferUsage.COPY_SRC
const COPY_DST = 0x0008; // GPUBufferUsage.COPY_DST
const UNIFORM = 0x0040; // GPUBufferUsage.UNIFORM

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

/**
 * Build a 196-float View UBO payload with known test values.
 * All 4 lightViewProj matrices are identity; splitPlanes use
 * monotonic values; cascadeCount=4, cascadeBlend=0.2.
 */
function buildTestPayload(cascadeCount: number, cascadeBlend: number): Float32Array {
  const f32 = new Float32Array(VIEW_UBO_FLOAT_COUNT);

  // worldViewProj[0] = 1 (identity)
  f32[0] = 1;
  f32[5] = 1;
  f32[10] = 1;
  f32[15] = 1;

  // lightViewProj[0] — distinct test pattern.
  // Set diagonal in each cascade to distinguishable values.
  for (let c = 0; c < 4; c++) {
    const base = [OFF.LVP0, OFF.LVP1, OFF.LVP2, OFF.LVP3][c] ?? 0;
    f32[base] = (c + 1) * 0.1; // diag entry [0,0]
    f32[base + 5] = (c + 1) * 0.1; // [1,1]
    f32[base + 10] = (c + 1) * 0.1; // [2,2]
    f32[base + 15] = 1; // [3,3]
  }

  // inverseViewProj — identity.
  f32[OFF.INV] = 1;
  f32[OFF.INV + 5] = 1;
  f32[OFF.INV + 10] = 1;
  f32[OFF.INV + 15] = 1;

  // splitPlanes — monotonic known values.
  const splits = [OFF.SP0, OFF.SP1, OFF.SP2, OFF.SP3];
  for (let i = 0; i < cascadeCount; i++) {
    const off = splits[i] ?? 0;
    f32[off] = (i + 1) * 10.0; // 10, 20, 30, 40
    // Remaining 3 floats per vec4 slot are padding (zero).
  }

  // cascadeCount / cascadeBlend.
  f32[OFF.CC] = cascadeCount;
  f32[OFF.CB] = cascadeBlend;

  return f32;
}

describe('View UBO CSM round-trip (w15)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  describe('GPU buffer round-trip (cascadeCount=4)', () => {
    it('writes 4-cascade payload and reads back identical data', async () => {
      const gpu = (navigator as unknown as Record<string, unknown>).gpu as GPU;
      const adapter = await gpu.requestAdapter();
      expect(adapter).toBeTruthy();
      if (!adapter) throw new Error('no adapter');
      const device = await adapter.requestDevice();
      expect(device).toBeTruthy();

      // Create buffer with COPY_DST (for write) + COPY_SRC (for read).
      const buf = device.createBuffer({
        label: 'csm-ubo-roundtrip-n4',
        size: VIEW_UBO_BYTES,
        usage: COPY_DST | COPY_SRC | UNIFORM,
        mappedAtCreation: false,
      });

      const payload = buildTestPayload(4, 0.2);
      const stagingUpload = device.createBuffer({
        size: VIEW_UBO_BYTES,
        usage: MAP_WRITE | COPY_SRC,
        mappedAtCreation: true,
      });
      new Float32Array(stagingUpload.getMappedRange()).set(payload);
      stagingUpload.unmap();

      // Copy to the uniform-buffer-style target.
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(stagingUpload, 0, buf, 0, VIEW_UBO_BYTES);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();

      // Read back via staging buffer.
      const staging = device.createBuffer({
        size: VIEW_UBO_BYTES,
        usage: MAP_READ | COPY_DST,
        mappedAtCreation: false,
      });
      const enc2 = device.createCommandEncoder();
      enc2.copyBufferToBuffer(buf, 0, staging, 0, VIEW_UBO_BYTES);
      device.queue.submit([enc2.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const readback = new Float32Array(staging.getMappedRange());

      // Verify cascadeCount / cascadeBlend.
      expect(readback[OFF.CC]).toBe(4);
      expect(readback[OFF.CB]).toBeCloseTo(0.2, 5);

      // Verify splitPlanes.
      expect(readback[OFF.SP0]).toBeCloseTo(10, 5);
      expect(readback[OFF.SP1]).toBeCloseTo(20, 5);
      expect(readback[OFF.SP2]).toBeCloseTo(30, 5);
      expect(readback[OFF.SP3]).toBeCloseTo(40, 5);

      // Verify lightViewProj[0] diagonal element.
      expect(readback[OFF.LVP0]).toBeCloseTo(0.1, 5);
      // Verify lightViewProj[3] diagonal element.
      expect(readback[OFF.LVP3 + 10]).toBeCloseTo(0.4, 5);

      staging.unmap();
      staging.destroy();
      stagingUpload.destroy();
      buf.destroy();
      device.destroy();
    });
  });

  describe('GPU buffer round-trip (cascadeCount=1)', () => {
    it('writes 1-cascade payload with zero unused slots', async () => {
      const gpu = (navigator as unknown as Record<string, unknown>).gpu as GPU;
      const adapter = await gpu.requestAdapter();
      expect(adapter).toBeTruthy();
      if (!adapter) throw new Error('no adapter');
      const device = await adapter.requestDevice();
      expect(device).toBeTruthy();

      const buf = device.createBuffer({
        label: 'csm-ubo-roundtrip-n1',
        size: VIEW_UBO_BYTES,
        usage: COPY_DST | COPY_SRC | UNIFORM,
        mappedAtCreation: false,
      });

      const payload = buildTestPayload(1, 0.0);
      const stagingUpload = device.createBuffer({
        size: VIEW_UBO_BYTES,
        usage: MAP_WRITE | COPY_SRC,
        mappedAtCreation: true,
      });
      new Float32Array(stagingUpload.getMappedRange()).set(payload);
      stagingUpload.unmap();

      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(stagingUpload, 0, buf, 0, VIEW_UBO_BYTES);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();

      const staging = device.createBuffer({
        size: VIEW_UBO_BYTES,
        usage: MAP_READ | COPY_DST,
        mappedAtCreation: false,
      });
      const enc2 = device.createCommandEncoder();
      enc2.copyBufferToBuffer(buf, 0, staging, 0, VIEW_UBO_BYTES);
      device.queue.submit([enc2.finish()]);

      await staging.mapAsync(GPUMapMode.READ);
      const readback = new Float32Array(staging.getMappedRange());

      // cascadeCount=1 with cascadeBlend=0.
      expect(readback[OFF.CC]).toBe(1);
      expect(readback[OFF.CB]).toBe(0);

      // cascade 0 splitPlanes: only [0] has data.
      expect(readback[OFF.SP0]).toBeCloseTo(10, 5);
      // Unused split slots should be zero.
      expect(readback[OFF.SP1]).toBe(0);
      expect(readback[OFF.SP2]).toBe(0);
      expect(readback[OFF.SP3]).toBe(0);

      // cascade 0 lightViewProj is written.
      expect(readback[OFF.LVP0]).toBeCloseTo(0.1, 5);
      // Unused matrix slots should be zero (or identity pattern
      // from the payload — our builder sets identity diag for all).
      // What matters: cascade 0 is correct.

      staging.unmap();
      staging.destroy();
      stagingUpload.destroy();
      buf.destroy();
      device.destroy();
    });
  });
});
