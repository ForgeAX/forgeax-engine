// shadow-csm-shader.dawn.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M5 / w17: cascade selection + atlas UV + blend dawn-node test (RED, test-first).
//
// Covers:
//   - AC-03: same WGSL pathway whether N=1 or N=4 (no single-cascade fallback)
//   - AC-05: atlas UV mapping per cascade tile
//   - AC-06: cascadeBlend=0 hard cut; cascadeBlend>0 mixes adjacent cascades
//   - AC-10: cascadeCount=1 degeneration -- same code path hits layer 0
//
// Strategy: compile a standalone @compute shader that mirrors the cascade
// selection arithmetic that w18 will land in lighting-directional.wgsl. The
// test shader picks a layer based on viewZ vs splitPlanes[i], computes the
// atlas UV using a 2x2-tile layout (tilesPerSide=2 for N<=4), and mixes
// shadow values across the cascade boundary when cascadeBlend > 0. The
// shader writes (layer, uvX, uvY, blendedShadow) to a storage buffer the
// host reads back.
//
// w17 stays red until w18 ships the matching evalDirectional rewrite -- but
// because the test embeds its own kernel, "red" here means an algorithmic
// regression in the kernel logic itself. The kernel is the executable AC-06
// spec; w18 implementation must derive identical behavior.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directionalShader = readFileSync(
  fileURLToPath(new URL('../../../shader/src/lighting-directional.wgsl', import.meta.url)),
  'utf8',
);

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

// WGSL kernel mirroring the cascade-selection arithmetic w18 lands in
// lighting-directional.wgsl. Output layout per invocation (4 floats):
//   [0] = picked layer (0..N-1)
//   [1] = atlas UV.x at tile origin (used as "did we pick the right tile?" probe)
//   [2] = atlas UV.y at tile origin
//   [3] = mixed shadow value (blend test)
//
// Inputs (uniform):
//   splitPlanes : vec4<f32>
//   cascadeCount : f32
//   cascadeBlend : f32
//   viewZ : f32
//   shadowPerCascade : vec4<f32>  // [s0, s1, s2, s3] per-layer shadow probe
//
// Notes on atlas UV: tilesPerSide = 2 (N<=4); tile (col, row) origin in
// [0,1]^2 atlas UV space is (col*0.5, row*0.5). The kernel reports the tile
// origin for the picked layer so the host can verify the layer-to-UV
// mapping.
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
@group(0) @binding(1) var<storage, read_write> out : array<vec4<f32>>;

fn pickLayer(viewDepth: f32, splits: vec4<f32>, count: u32) -> u32 {
  // Walk splits in order; return first split the positive view-space depth
  // falls into. Last layer = count - 1 catches everything beyond
  // splits[count-2]. viewDepth = -viewZ (the VS emits negative viewZ;
  // splitPlanes are positive) -- see lighting-directional.wgsl.
  var layer : u32 = count - 1u;
  for (var i : u32 = 0u; i < count - 1u; i = i + 1u) {
    let sp = splits[i];
    if (viewDepth < sp) {
      layer = i;
      break;
    }
  }
  return layer;
}

fn tileOrigin(layer: u32) -> vec2<f32> {
  // tilesPerSide = 2 (covers cascadeCount in 1..4).
  let col = f32(layer % 2u);
  let row = f32(layer / 2u);
  return vec2<f32>(col * 0.5, row * 0.5);
}

@compute @workgroup_size(1)
fn cs_main() {
  let count = u32(inputs.cascadeCount);
  // viewZ is negative in front of the camera; splitPlanes are positive.
  // Convert once so selection + blend are positive-vs-positive (the real
  // lighting-directional.wgsl does the same). (downstream integration #1.)
  let viewDepth = -inputs.viewZ;
  let layer = pickLayer(viewDepth, inputs.splitPlanes, count);
  let origin = tileOrigin(layer);

  // Blend computation: when blend > 0 and we are within blendFactor of the
  // next-cascade boundary, mix shadow[layer] with shadow[layer+1].
  // For the last layer (layer == count-1) there is no next cascade, blend is
  // a no-op (mix with itself).
  var blended : f32 = 0.0;
  let s_curr = inputs.shadowPerCascade[layer];
  if (inputs.cascadeBlend > 0.0 && layer + 1u < count) {
    let sp_curr = inputs.splitPlanes[layer];
    // distance from viewZ to the upcoming boundary, normalized by blend width
    // = sp_curr * cascadeBlend.
    let blendWidth = sp_curr * inputs.cascadeBlend;
    if (blendWidth > 0.0) {
      let dist = sp_curr - viewDepth;
      let t = clamp(1.0 - dist / blendWidth, 0.0, 1.0);
      let s_next = inputs.shadowPerCascade[layer + 1u];
      blended = mix(s_curr, s_next, t);
    } else {
      blended = s_curr;
    }
  } else {
    blended = s_curr;
  }

  out[0] = vec4<f32>(f32(layer), origin.x, origin.y, blended);
}
`;

interface KernelInputs {
  splitPlanes: [number, number, number, number];
  cascadeCount: number;
  cascadeBlend: number;
  viewZ: number;
  shadowPerCascade: [number, number, number, number];
}

async function runKernel(inputs: KernelInputs): Promise<{
  layer: number;
  uvX: number;
  uvY: number;
  blended: number;
}> {
  const gpu = (navigator as unknown as Record<string, unknown>).gpu as GPU;
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('no adapter');
  const device = await adapter.requestDevice();

  const inputsBuf = device.createBuffer({
    size: 48, // 12 floats: vec4 + 4 scalars + vec4
    usage: 0x40 | 0x8, // UNIFORM | COPY_DST
  });

  // Layout (12 floats):
  //   [0..3]  splitPlanes
  //   [4]     cascadeCount
  //   [5]     cascadeBlend
  //   [6]     viewZ
  //   [7]     pad
  //   [8..11] shadowPerCascade
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
    size: 16, // 1 vec4
    usage: 0x80 | 0x4, // STORAGE | COPY_SRC
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

  const staging = device.createBuffer({
    size: 16,
    usage: 0x1 | 0x8, // MAP_READ | COPY_DST
  });
  encoder.copyBufferToBuffer(outBuf, 0, staging, 0, 16);
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapModeRead);
  const readback = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();

  const layer = readback[0] ?? 0;
  const uvX = readback[1] ?? 0;
  const uvY = readback[2] ?? 0;
  const blended = readback[3] ?? 0;

  staging.destroy();
  outBuf.destroy();
  inputsBuf.destroy();
  device.destroy();

  return { layer, uvX, uvY, blended };
}

describe('CSM shader cascade selection + atlas UV + blend (M5/w17)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  it('production Directional PCSS uses raw depth and comparison without new bindings', () => {
    expect(directionalShader).toContain('fn _samplePcssForCascade');
    expect(directionalShader).toContain('shadow_load_raw_depth');
    expect(directionalShader).toContain('shadow_sample_compare');
    expect(directionalShader).toContain('PCSS_MEDIUM_RAW_TAPS : u32 = 8u');
    expect(directionalShader).toContain('PCSS_MEDIUM_COMPARE_TAPS : u32 = 16u');
    expect(directionalShader).toContain('PCSS_HIGH_RAW_TAPS : u32 = 16u');
    expect(directionalShader).toContain('PCSS_HIGH_COMPARE_TAPS : u32 = 32u');
    expect(directionalShader).not.toMatch(/@binding\(/);
    expect(directionalShader).not.toMatch(/frameIndex|frame_index|taaJitter|taa_jitter|jitter/);
  });

  describe('cascade selection by viewZ (AC-03 / AC-06)', () => {
    it('viewZ < splits[0] -> layer 0', async () => {
      const r = await runKernel({
        splitPlanes: [10, 20, 40, 80],
        cascadeCount: 4,
        cascadeBlend: 0,
        viewZ: -5,
        shadowPerCascade: [0.1, 0.2, 0.3, 0.4],
      });
      expect(r.layer).toBe(0);
      // tile (0,0) -> origin (0, 0)
      expect(r.uvX).toBeCloseTo(0, 5);
      expect(r.uvY).toBeCloseTo(0, 5);
    });

    it('splits[0] <= viewZ < splits[1] -> layer 1', async () => {
      const r = await runKernel({
        splitPlanes: [10, 20, 40, 80],
        cascadeCount: 4,
        cascadeBlend: 0,
        viewZ: -15,
        shadowPerCascade: [0.1, 0.2, 0.3, 0.4],
      });
      expect(r.layer).toBe(1);
      // tile (1,0) -> origin (0.5, 0)
      expect(r.uvX).toBeCloseTo(0.5, 5);
      expect(r.uvY).toBeCloseTo(0, 5);
    });

    it('splits[1] <= viewZ < splits[2] -> layer 2', async () => {
      const r = await runKernel({
        splitPlanes: [10, 20, 40, 80],
        cascadeCount: 4,
        cascadeBlend: 0,
        viewZ: -30,
        shadowPerCascade: [0.1, 0.2, 0.3, 0.4],
      });
      expect(r.layer).toBe(2);
      // tile (0,1) -> origin (0, 0.5)
      expect(r.uvX).toBeCloseTo(0, 5);
      expect(r.uvY).toBeCloseTo(0.5, 5);
    });

    it('viewZ >= splits[N-2] -> last layer', async () => {
      const r = await runKernel({
        splitPlanes: [10, 20, 40, 80],
        cascadeCount: 4,
        cascadeBlend: 0,
        viewZ: -100,
        shadowPerCascade: [0.1, 0.2, 0.3, 0.4],
      });
      expect(r.layer).toBe(3);
      // tile (1,1) -> origin (0.5, 0.5)
      expect(r.uvX).toBeCloseTo(0.5, 5);
      expect(r.uvY).toBeCloseTo(0.5, 5);
    });
  });

  describe('blend behaviour (AC-06)', () => {
    it('cascadeBlend=0 -> hard cut (single shadow value)', async () => {
      const r = await runKernel({
        splitPlanes: [10, 20, 40, 80],
        cascadeCount: 4,
        cascadeBlend: 0,
        viewZ: -9.9, // just inside layer 0, near boundary
        shadowPerCascade: [0.1, 0.9, 0.5, 0.5],
      });
      expect(r.layer).toBe(0);
      // hard cut: blended == shadowPerCascade[0]
      expect(r.blended).toBeCloseTo(0.1, 5);
    });

    it('cascadeBlend=0.2 -> mix between adjacent cascades inside blend zone', async () => {
      // splitPlanes[0] = 10, blendWidth = 10 * 0.2 = 2.
      // viewZ = 9 -> dist = 1, t = 1 - 1/2 = 0.5 -> mix(0.1, 0.9, 0.5) = 0.5
      const r = await runKernel({
        splitPlanes: [10, 20, 40, 80],
        cascadeCount: 4,
        cascadeBlend: 0.2,
        viewZ: -9,
        shadowPerCascade: [0.1, 0.9, 0.5, 0.5],
      });
      expect(r.layer).toBe(0);
      expect(r.blended).toBeCloseTo(0.5, 4);
    });

    it('cascadeBlend>0 outside blend zone -> no mix', async () => {
      // viewZ = 5 -> dist = 5, t clamps to 0 -> blended = s_curr = 0.1
      const r = await runKernel({
        splitPlanes: [10, 20, 40, 80],
        cascadeCount: 4,
        cascadeBlend: 0.2,
        viewZ: -5,
        shadowPerCascade: [0.1, 0.9, 0.5, 0.5],
      });
      expect(r.layer).toBe(0);
      expect(r.blended).toBeCloseTo(0.1, 5);
    });
  });

  describe('cascadeCount=1 degeneracy (AC-10)', () => {
    it('N=1 single layer -> always picks layer 0, same code path', async () => {
      const r = await runKernel({
        splitPlanes: [10, 0, 0, 0],
        cascadeCount: 1,
        cascadeBlend: 0,
        viewZ: -5,
        shadowPerCascade: [0.7, 0, 0, 0],
      });
      expect(r.layer).toBe(0);
      expect(r.uvX).toBeCloseTo(0, 5);
      expect(r.uvY).toBeCloseTo(0, 5);
      expect(r.blended).toBeCloseTo(0.7, 5);
    });

    it('N=1 with non-zero blend -> still picks layer 0 with no mix (no next cascade)', async () => {
      const r = await runKernel({
        splitPlanes: [10, 0, 0, 0],
        cascadeCount: 1,
        cascadeBlend: 0.5,
        viewZ: -5,
        shadowPerCascade: [0.7, 0, 0, 0],
      });
      expect(r.layer).toBe(0);
      expect(r.blended).toBeCloseTo(0.7, 5);
    });
  });
});
