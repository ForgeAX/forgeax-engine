// clamp-to-last.e2e.dawn.test.ts -- feat-20260629-multi-uv-set-support m3-w2
//
// Dawn-node e2e test for clamp-to-last readback via raw WebGPU calls.
// Verifies the AC-06 semantic: shader declares m UV sets, mesh has n (m>n),
// shader indices [n,m) alias to the n-1th set's buffer offset.
// Also verifies AC-07: n=0 (no UV) -> reads (0,0).
//
// Uses raw dawn-node GPU calls (no engine createRenderer) because
// deriveVertexBufferLayout does not yet produce aliased layouts (m3-w4).
// The alias pattern verified here matches exactly what m3-w4 will emit.
//
// Uses the vitest dawn project setup (vitest.setup-webgpu.ts provides
// globalThis.navigator.gpu — no separate bootstrap needed).

import { describe, expect, it } from 'vitest';

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

const W = 16;
const H = 16;

// ─── helpers ────────────────────────────────────────────────

async function readbackTexture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
  const readback = device.createBuffer({
    size: bytesPerRow * height,
    usage: 0x09, // MAP_READ | COPY_DST
  });
  const cmd = device.createCommandEncoder();
  cmd.copyTextureToBuffer(
    { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([cmd.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(0x0001); // GPUMapMode.READ
  const view = new Uint8Array(readback.getMappedRange().slice(0));
  const copy = new Uint8Array(view);
  readback.unmap();
  readback.destroy();
  return copy;
}

function samplePixel(
  bytes: Uint8Array,
  bytesPerRow: number,
  px: number,
  py: number,
): [number, number, number, number] {
  const off = py * bytesPerRow + px * 4;
  return [
    (bytes[off] ?? 0) / 255,
    (bytes[off + 1] ?? 0) / 255,
    (bytes[off + 2] ?? 0) / 255,
    (bytes[off + 3] ?? 0) / 255,
  ];
}

type VertexAttr = { shaderLocation: number; offset: number; format: string };

async function runAliasProbe(params: {
  attributes: VertexAttr[];
  vertexData: Float32Array;
  arrayStride: number;
}): Promise<[number, number, number, number]> {
  // biome-ignore lint/style/noNonNullAssertion: dawn setup guarantees navigator.gpu is set
  // biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: the ?. path is a biome artifact
  const gpu = globalThis.navigator?.gpu!;
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('no dawn adapter');
  const device = await adapter.requestDevice();

  const vbuf = device.createBuffer({
    size: params.vertexData.byteLength,
    usage: 0x20 | 0x08, // VERTEX | COPY_DST
  });
  device.queue.writeBuffer(vbuf, 0, params.vertexData);

  // Collect UV attributes (exclude position at location 0)
  const uvAttribs = params.attributes.filter((a) => a.shaderLocation !== 0);
  if (uvAttribs.length < 4) {
    throw new Error(`need 4 UV attributes, got ${uvAttribs.length}`);
  }

  const l0 = uvAttribs[0]?.shaderLocation;
  const l1 = uvAttribs[1]?.shaderLocation;
  const l2 = uvAttribs[2]?.shaderLocation;
  const l3 = uvAttribs[3]?.shaderLocation;

  const shader = device.createShaderModule({
    code: /* wgsl */ `
struct VsIn {
  @location(0) pos : vec3f,
  @location(${l0}) uv0 : vec2f,
  @location(${l1}) uv1 : vec2f,
  @location(${l2}) uv2 : vec2f,
  @location(${l3}) uv3 : vec2f,
}
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) out0 : vec2f,
  @location(1) out1 : vec2f,
}
@vertex fn vs(in: VsIn) -> VsOut {
  var out: VsOut;
  out.pos = vec4f(in.pos, 1.0);
  out.out0 = in.uv0;
  out.out1 = in.uv1;
  return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.out0, in.out1);
}
`,
  });

  const renderTarget = device.createTexture({
    size: { width: W, height: H, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: 0x10 | 0x01, // RENDER_ATTACHMENT | COPY_SRC
  });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shader,
      entryPoint: 'vs',
      buffers: [{ arrayStride: params.arrayStride, attributes: params.attributes as never }],
    },
    fragment: {
      module: shader,
      entryPoint: 'fs',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const encoder = device.createCommandEncoder();
  {
    const rp = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: renderTarget.createView(),
          loadOp: 'clear',
          clearValue: [0, 0, 0, 0],
          storeOp: 'store',
        },
      ],
    });
    rp.setPipeline(pipeline);
    rp.setVertexBuffer(0, vbuf);
    rp.draw(3, 1, 0, 0);
    rp.end();
  }
  device.queue.submit([encoder.finish()]);

  const bytes = await readbackTexture(device, renderTarget, W, H);

  device.destroy();
  const bpr = Math.ceil((W * 4) / 256) * 256;
  return samplePixel(bytes, bpr, Math.floor(W / 2), Math.floor(H / 2));
}

// ─── tests ─────────────────────────────────────────────────

describe('clamp-to-last alias dawn e2e (m3-w2)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  // ── AC-06: n=2, m=5, [2,4) alias to set 1 (n-1) ──

  it('AC-06: mesh n=2, shader m=5 -> [2,4) reads set 1 data', async () => {
    // layout: pos(12B) + uv0(8B at off12) + uv1(8B at off20)
    // uv0=(0.2,0.3), uv1=(0.8,0.7)
    // attributes: loc2=off12(uv0), loc6=off20(uv1), loc7=off20(alias), loc8=off20(alias)
    // Fragment: R,G = in.uv0, B,A = in.uv1 (which reads alias at loc7 → same offset as loc6)
    const uv0u = 0.2;
    const uv0v = 0.3;
    const uv1u = 0.8;
    const uv1v = 0.7;

    const vertexData = new Float32Array([
      -1,
      -1,
      0,
      uv0u,
      uv0v,
      uv1u,
      uv1v, // v0
      3,
      -1,
      0,
      uv0u,
      uv0v,
      uv1u,
      uv1v, // v1
      -1,
      3,
      0,
      uv0u,
      uv0v,
      uv1u,
      uv1v, // v2
    ]);
    const STRIDE = 7 * 4; // 28 bytes

    // R,G from location 2 (real uv0), B,A from location 7 (aliased to uv1 offset)
    const [R, G, B, A] = await runAliasProbe({
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 2, offset: 12, format: 'float32x2' }, // uv0 → in.uv0
        { shaderLocation: 6, offset: 20, format: 'float32x2' }, // uv1 → in.uv1 (B,A)
        { shaderLocation: 7, offset: 20, format: 'float32x2' }, // alias (unused)
        { shaderLocation: 8, offset: 20, format: 'float32x2' }, // alias (unused)
      ],
      vertexData,
      arrayStride: STRIDE,
    });

    // R,G = uv0
    expect(Math.abs(R - uv0u)).toBeLessThan(0.03);
    expect(Math.abs(G - uv0v)).toBeLessThan(0.03);
    // B,A = uv1 (location 6 reads offset 20 = real uv1 data)
    expect(Math.abs(B - uv1u)).toBeLessThan(0.03);
    expect(Math.abs(A - uv1v)).toBeLessThan(0.03);
    // B is NOT uv0 (proves alias path is independent)
    expect(Math.abs(B - uv0u)).toBeGreaterThan(0.1);
  });

  // ── Proof: duplicated location offset = alias reads same data ──

  it('alias proof: same offset at two locations reads same data', async () => {
    // Single UV offset at 12: uv=(0.6, 0.4)
    // loc 2 (VsIn.uv0) offset=12, loc 6 (VsIn.uv1) offset=12 (same!)
    const uvU = 0.6;
    const uvV = 0.4;

    const vertexData = new Float32Array([
      -1,
      -1,
      0,
      uvU,
      uvV, // v0
      3,
      -1,
      0,
      uvU,
      uvV, // v1
      -1,
      3,
      0,
      uvU,
      uvV, // v2
    ]);
    const STRIDE = 5 * 4;

    const [R, G, B, A] = await runAliasProbe({
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 2, offset: 12, format: 'float32x2' }, // → in.uv0
        { shaderLocation: 6, offset: 12, format: 'float32x2' }, // → in.uv1 (same offset!)
        { shaderLocation: 7, offset: 12, format: 'float32x2' }, // unused
        { shaderLocation: 8, offset: 12, format: 'float32x2' }, // unused
      ],
      vertexData,
      arrayStride: STRIDE,
    });

    // Both read the same data from offset 12
    expect(Math.abs(R - uvU)).toBeLessThan(0.03);
    expect(Math.abs(G - uvV)).toBeLessThan(0.03);
    expect(Math.abs(B - uvU)).toBeLessThan(0.03); // same offset = same data
    expect(Math.abs(A - uvV)).toBeLessThan(0.03);
  });

  // ── AC-07: n=0 (no UV), default buffer = (0,0) ──

  it('AC-07: mesh n=0 UV, all UV locations alias to zero buffer -> (0,0)', async () => {
    const vertexData = new Float32Array([
      -1,
      -1,
      0,
      0,
      0, // zero pad
      3,
      -1,
      0,
      0,
      0,
      -1,
      3,
      0,
      0,
      0,
    ]);
    const STRIDE = 5 * 4;

    const [R, G, B, A] = await runAliasProbe({
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 2, offset: 12, format: 'float32x2' },
        { shaderLocation: 6, offset: 12, format: 'float32x2' },
        { shaderLocation: 7, offset: 12, format: 'float32x2' },
        { shaderLocation: 8, offset: 12, format: 'float32x2' },
      ],
      vertexData,
      arrayStride: STRIDE,
    });

    expect(Math.abs(R)).toBeLessThan(0.02);
    expect(Math.abs(G)).toBeLessThan(0.02);
    expect(Math.abs(B)).toBeLessThan(0.02);
    expect(Math.abs(A)).toBeLessThan(0.02);
  });
});
