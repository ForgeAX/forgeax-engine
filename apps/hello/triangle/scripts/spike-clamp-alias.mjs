#!/usr/bin/env node
// spike-clamp-alias.mjs — M0 spike probe for feat-20260629-multi-uv-set-support.
// Verifies that "same offset, different shaderLocation" alias attributes work
// in the dawn-node backend (wgpu-wasm / WebGL2-via-ANGLE proxy).
//
// Scenario: shader declares m=4 UV sets, mesh has n=2 UV sets.
// Vertex attribute layout aliases shaderLocation 7,8 to same buffer offset as
// shaderLocation 6 (the n-1=1th set), testing the clamp-to-last alias pattern
// from plan-strategy D-1.
//
// This script uses raw dawn-node GPU calls; it does NOT modify engine
// production code (vertex-attribute-layout.ts is read-only as reference).

import { create, globals } from '@forgeax/engine-dawn-node';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ────────────────────────────────────────────────
// Bootstrap dawn-node
// ────────────────────────────────────────────────

function bootstrapDawn() {
  // Assign spec constants (GPUBufferUsage, GPUTextureUsage, etc.)
  Object.assign(globalThis, globals);

  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }

  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });

  return gpu;
}

function teardown(device) {
  device?.destroy?.();
  if (globalThis.navigator?.gpu) {
    delete globalThis.navigator.gpu;
  }
}

// ────────────────────────────────────────────────
// Main: run the alias probe
// ────────────────────────────────────────────────

async function main() {
  const gpu = bootstrapDawn();
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    console.error('[spike] FAIL — no adapter');
    process.exit(1);
  }

  const device = await adapter.requestDevice();
  const W = 16;
  const H = 16;

  // ── mesh data: 3 vertices (triangle covering viewport) ──
  // Per-vertex layout: pos(3f) + uv0(2f) + uv1(2f) = 7 floats = 28 bytes
  //   v0: (-1,-1,0), uv0=(0.2,0.3), uv1=(0.8,0.7)
  //   v1: ( 3,-1,0), uv0=(0.2,0.3), uv1=(0.8,0.7)
  //   v2: (-1, 3,0), uv0=(0.2,0.3), uv1=(0.8,0.7)
  const uv0u = 0.2;
  const uv0v = 0.3;
  const uv1u = 0.8;
  const uv1v = 0.7;
  const vertexData = new Float32Array([
    // pos.x, pos.y, pos.z,  uv0.u, uv0.v,  uv1.u, uv1.v
    -1, -1, 0, uv0u, uv0v, uv1u, uv1v, // v0
     3, -1, 0, uv0u, uv0v, uv1u, uv1v, // v1
    -1,  3, 0, uv0u, uv0v, uv1u, uv1v, // v2
  ]);
  const STRIDE = 7 * 4; // 28 bytes
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  // ── shader WGSL ──
  // VsIn declares m=4 UV sets: uv@2, uv1@6, uv2@7, uv3@8
  // Fragment outputs R,G = uv1 (real set 1), B,A = uv2 (should alias to set 1)
  const shaderCode = /* wgsl */ `
struct VsIn {
  @location(0) pos  : vec3f,
  @location(2) uv   : vec2f,
  @location(6) uv1  : vec2f,
  @location(7) uv2  : vec2f,
  @location(8) uv3  : vec2f,
}

struct VsOut {
  @builtin(position) position : vec4f,
  @location(0) out_uv1 : vec2f,
  @location(1) out_uv2 : vec2f,
}

@vertex
fn vs(in: VsIn) -> VsOut {
  var out: VsOut;
  out.position = vec4f(in.pos, 1.0);
  out.out_uv1 = in.uv1;
  out.out_uv2 = in.uv2;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.out_uv1, in.out_uv2);
}
`;

  const shaderModule = device.createShaderModule({ code: shaderCode });

  // ── render target ──
  // RENDER_ATTACHMENT (0x10) | COPY_SRC (0x01)
  const renderTarget = device.createTexture({
    size: { width: W, height: H, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  // ── vertex buffer layout with alias ──
  // location 0: offset 0,  float32x3 (position, 12 bytes)
  // location 2: offset 12, float32x2 (uv0,     8 bytes)  ← set 0
  // location 6: offset 20, float32x2 (uv1,     8 bytes)  ← set 1 (n-1 = last real)
  // location 7: offset 20, float32x2 (uv1 ALIAS, 8 bytes) ← KEY PROBE
  // location 8: offset 20, float32x2 (uv1 ALIAS, 8 bytes) ← KEY PROBE
  const vertexBufferLayout = {
    arrayStride: STRIDE,
    attributes: [
      { shaderLocation: 0, offset: 0,  format: 'float32x3' },
      { shaderLocation: 2, offset: 12, format: 'float32x2' },
      { shaderLocation: 6, offset: 20, format: 'float32x2' },
      { shaderLocation: 7, offset: 20, format: 'float32x2' }, // alias — same offset as 6
      { shaderLocation: 8, offset: 20, format: 'float32x2' }, // alias — same offset as 6
    ],
  };

  // ── pipeline ──
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs',
      buffers: [vertexBufferLayout],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  });

  // ── render 1 frame ──
  const encoder = device.createCommandEncoder();
  {
    const rp = encoder.beginRenderPass({
      colorAttachments: [{
        view: renderTarget.createView(),
        loadOp: 'clear',
        clearValue: [0, 0, 0, 0],
        storeOp: 'store',
      }],
    });
    rp.setPipeline(pipeline);
    rp.setVertexBuffer(0, vertexBuffer);
    rp.draw(3, 1, 0, 0);
    rp.end();
  }
  // Copy render target to readback buffer
  const bytesPerPixel = 4;
  const bytesPerRow = Math.ceil((W * bytesPerPixel) / 256) * 256;
  const readbackBuf = device.createBuffer({
    size: bytesPerRow * H,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer: readbackBuf, bytesPerRow, rowsPerImage: H },
    { width: W, height: H, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);

  await device.queue.onSubmittedWorkDone();
  await readbackBuf.mapAsync(GPUMapMode.READ);
  const mapped = readbackBuf.getMappedRange();
  const bytes = new Uint8Array(mapped.slice(0));
  readbackBuf.unmap();
  readbackBuf.destroy();

  // ── sample center pixel ──
  const cx = Math.floor(W / 2);
  const cy = Math.floor(H / 2);
  const off = cy * bytesPerRow + cx * bytesPerPixel;
  const R = bytes[off + 0] / 255;
  const G = bytes[off + 1] / 255;
  const B = bytes[off + 2] / 255;
  const A = bytes[off + 3] / 255;

  // Expected if alias works: R=uv1u, G=uv1v, B=uv1u, A=uv1v (all from set 1)
  // Expected if alias BROKEN:  B,A would be (0,0) or uv0 values (0.2,0.3)
  const aliasWorks =
    Math.abs(R - uv1u) < 0.02 &&
    Math.abs(G - uv1v) < 0.02 &&
    Math.abs(B - uv1u) < 0.02 &&
    Math.abs(A - uv1v) < 0.02;

  console.log(`[spike] backend=${adapter.info?.backendType ?? 'unknown'} vendor=${adapter.info?.vendor ?? 'unknown'}`);
  console.log(`[spike] readback RGBA=(${R.toFixed(4)}, ${G.toFixed(4)}, ${B.toFixed(4)}, ${A.toFixed(4)})`);
  console.log(`[spike] expected RGBA=(${uv1u.toFixed(4)}, ${uv1v.toFixed(4)}, ${uv1u.toFixed(4)}, ${uv1v.toFixed(4)})`);
  console.log(`[spike] alias_works=${aliasWorks}`);

  teardown(device);

  if (aliasWorks) {
    console.log('[spike] RESULT=PASS — clamp-to-last layout alias confirmed working in this backend');
    process.exit(0);
  } else {
    // Readback delta info for diagnosis
    const bDelta = Math.abs(B - uv1u);
    const aDelta = Math.abs(A - uv1v);
    console.error(`[spike] RESULT=FAIL — alias didn't work: B delta=${bDelta.toFixed(4)}, A delta=${aDelta.toFixed(4)}`);
    console.error('[spike] hint: if B,A ~= (0,0) or (0.2,0.3), alias is not active in this backend');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[spike] crash:', err);
  process.exit(1);
});