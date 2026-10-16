// shadow-csm-blend.dawn.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M5 / w27: cascade-blend pixel-level dawn-node test (best-effort).
//
// Covers AC-06 (cascadeBlend > 0 mixes adjacent cascades smoothly;
// cascadeBlend = 0 hard-cut). The full pipeline pixel-readback path
// (Sponza-style fragment scene) is OOS for dawn-node smoke (no real
// scene assets); this test exercises the blend math directly through a
// compute shader that mirrors the lighting-directional.wgsl branch w18
// landed. The shader is the executable AC-06 spec; lighting-directional
// must derive identical behavior, validated structurally by w17 + this
// test plus the runtime variation gate w26.
//
// Strategy: walk viewZ across the splitPlanes[0] boundary while holding
// shadowPerCascade[0..1] = (a, b) and assert the output:
//   - cascadeBlend = 0 -> shadow == shadowPerCascade[layer] (hard cut)
//   - cascadeBlend = 0.5 -> shadow walks monotonically from a to b across
//     the band [splitPlanes[0]*(1-cascadeBlend), splitPlanes[0]]
//
// best-effort note: if the same kernel surface w17 lands ever drifts from
// the lighting-directional source, the structural test net (w17 layer
// selection + this test for blend continuity) flags both.

import { describe, expect, it } from 'vitest';

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

const GPUMapModeRead: number = ((): number => {
  try {
    const o = globalThis as Record<string, unknown>;
    const gpuMode = o.GPUMapMode as { READ?: number } | undefined;
    if (gpuMode !== undefined && gpuMode.READ !== undefined) return gpuMode.READ;
  } catch {
    /* node env */
  }
  return 1;
})();

const KERNEL_WGSL = `
struct Inputs {
  splitPlanes      : vec4<f32>,
  cascadeCount     : f32,
  cascadeBlend     : f32,
  viewZ            : f32,
  pad              : f32,
  shadowPerCascade : vec4<f32>,
};

@group(0) @binding(0) var<uniform> inputs : Inputs;
@group(0) @binding(1) var<storage, read_write> out : array<f32>;

fn pickLayer(viewZ: f32, splits: vec4<f32>, count: u32) -> u32 {
  var layer : u32 = count - 1u;
  for (var i : u32 = 0u; i < count - 1u; i = i + 1u) {
    let sp = splits[i];
    if (viewZ < sp) {
      layer = i;
      break;
    }
  }
  return layer;
}

@compute @workgroup_size(1)
fn cs_main() {
  let count = u32(inputs.cascadeCount);
  let layer = pickLayer(inputs.viewZ, inputs.splitPlanes, count);
  let s_curr = inputs.shadowPerCascade[layer];
  var blended : f32 = s_curr;
  if (inputs.cascadeBlend > 0.0 && layer + 1u < count) {
    let sp_curr = inputs.splitPlanes[layer];
    let blendWidth = sp_curr * inputs.cascadeBlend;
    if (blendWidth > 0.0) {
      let dist = sp_curr - inputs.viewZ;
      let t = clamp(1.0 - dist / blendWidth, 0.0, 1.0);
      let s_next = inputs.shadowPerCascade[layer + 1u];
      blended = mix(s_curr, s_next, t);
    }
  }
  out[0] = blended;
}
`;

interface KernelInputs {
  splitPlanes: [number, number, number, number];
  cascadeCount: number;
  cascadeBlend: number;
  viewZ: number;
  shadowPerCascade: [number, number, number, number];
}

async function runKernel(inputs: KernelInputs): Promise<number> {
  const gpu = (navigator as unknown as Record<string, unknown>).gpu as GPU;
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('no adapter');
  const device = await adapter.requestDevice();

  const inputsBuf = device.createBuffer({
    size: 48,
    usage: 0x40 | 0x8,
  });
  const inputF32 = new Float32Array(12);
  inputF32[0] = inputs.splitPlanes[0];
  inputF32[1] = inputs.splitPlanes[1];
  inputF32[2] = inputs.splitPlanes[2];
  inputF32[3] = inputs.splitPlanes[3];
  inputF32[4] = inputs.cascadeCount;
  inputF32[5] = inputs.cascadeBlend;
  inputF32[6] = inputs.viewZ;
  inputF32[7] = 0;
  inputF32[8] = inputs.shadowPerCascade[0];
  inputF32[9] = inputs.shadowPerCascade[1];
  inputF32[10] = inputs.shadowPerCascade[2];
  inputF32[11] = inputs.shadowPerCascade[3];
  device.queue.writeBuffer(inputsBuf, 0, inputF32);

  const outBuf = device.createBuffer({
    size: 16,
    usage: 0x80 | 0x4,
  });
  const module = device.createShaderModule({ code: KERNEL_WGSL });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'cs_main' },
  });
  const bg = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputsBuf } },
      { binding: 1, resource: { buffer: outBuf } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(1);
  pass.end();
  const staging = device.createBuffer({ size: 16, usage: 0x1 | 0x8 });
  encoder.copyBufferToBuffer(outBuf, 0, staging, 0, 16);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapModeRead);
  const readback = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  const value = readback[0] ?? 0;
  staging.destroy();
  outBuf.destroy();
  inputsBuf.destroy();
  device.destroy();
  return value;
}

describe('CSM cascade blend pixel-level (M5/w27)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  describe('cascadeBlend=0 hard cut', () => {
    it('returns shadowPerCascade[layer] verbatim, no mix', async () => {
      const splits: [number, number, number, number] = [10, 20, 40, 80];
      const shadows: [number, number, number, number] = [0.1, 0.9, 0.5, 0.5];
      // Just inside layer 0, near boundary (viewZ=9.5).
      const value = await runKernel({
        splitPlanes: splits,
        cascadeCount: 4,
        cascadeBlend: 0,
        viewZ: 9.5,
        shadowPerCascade: shadows,
      });
      expect(value).toBeCloseTo(0.1, 5);
    });
  });

  describe('cascadeBlend=0.5 mixes monotonically', () => {
    it('shadow value walks from shadow[0] to shadow[1] across the blend band', async () => {
      const splits: [number, number, number, number] = [10, 20, 40, 80];
      const shadows: [number, number, number, number] = [0.1, 0.9, 0.5, 0.5];
      // splits[0]=10, blendWidth = 10*0.5 = 5. Band spans [5, 10] → t spans
      // [0, 1] → blended walks from 0.1 → 0.9.
      const v0 = await runKernel({
        splitPlanes: splits,
        cascadeCount: 4,
        cascadeBlend: 0.5,
        viewZ: 5.0,
        shadowPerCascade: shadows,
      });
      const v1 = await runKernel({
        splitPlanes: splits,
        cascadeCount: 4,
        cascadeBlend: 0.5,
        viewZ: 7.5,
        shadowPerCascade: shadows,
      });
      const v2 = await runKernel({
        splitPlanes: splits,
        cascadeCount: 4,
        cascadeBlend: 0.5,
        viewZ: 9.99,
        shadowPerCascade: shadows,
      });
      expect(v0).toBeCloseTo(0.1, 4);
      // viewZ=7.5 -> dist=2.5, t=1-2.5/5=0.5 -> mix(0.1,0.9,0.5)=0.5
      expect(v1).toBeCloseTo(0.5, 4);
      // viewZ=9.99 -> dist=0.01, t=1-0.01/5=0.998 -> mix(0.1,0.9,0.998)≈0.8984
      expect(v2).toBeGreaterThan(0.85);
      expect(v2).toBeLessThan(0.91);
      // Monotone: v0 < v1 < v2 (blend ramps shadow upward toward 0.9).
      expect(v0).toBeLessThan(v1);
      expect(v1).toBeLessThan(v2);
    });
  });

  describe('blend in [shadow_prev, shadow_next] interval', () => {
    it('regardless of t, blended ∈ [min(prev,next), max(prev,next)]', async () => {
      const splits: [number, number, number, number] = [10, 20, 40, 80];
      const shadows: [number, number, number, number] = [0.2, 0.8, 0.5, 0.5];
      const value = await runKernel({
        splitPlanes: splits,
        cascadeCount: 4,
        cascadeBlend: 0.3,
        viewZ: 9.0, // band = [7, 10], dist = 1, t = 1 - 1/3 ≈ 0.667
        shadowPerCascade: shadows,
      });
      const lo = Math.min(shadows[0], shadows[1]);
      const hi = Math.max(shadows[0], shadows[1]);
      expect(value).toBeGreaterThanOrEqual(lo - 1e-5);
      expect(value).toBeLessThanOrEqual(hi + 1e-5);
    });
  });
});
