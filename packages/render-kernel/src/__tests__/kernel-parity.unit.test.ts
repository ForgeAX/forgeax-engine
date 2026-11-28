import { rhi as nullRhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import {
  COLOR_DOMAIN_LINEAR_HDR,
  CULL_FLAG_COMPUTE_VISIBLE_BOUNDS,
  CULL_FLAG_CULL_LIGHTS,
  createRenderKernel,
  createRenderKernelHotPath,
  DELTA_FLAG_BASELINE,
  DRAW_FLAG_INSTANCING,
  type LightId,
  OBJ_FLAG_CAST_SHADOW,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_TRANSPARENT,
  OBJ_FLAG_VISIBLE,
  PASS_TAG_FORWARD_OPAQUE,
  PASS_TAG_FORWARD_TRANSPARENT,
  PASS_TAG_SHADOW_DEPTH,
  packPsoKeyInto,
  type RenderKernel,
  type RenderObjectId,
  SORT_BACK_TO_FRONT,
  SORT_MATERIAL_PSO,
  TEXTURE_FORMAT_DEPTH32_FLOAT,
  TEXTURE_FORMAT_RGBA8_UNORM,
  TEXTURE_FORMAT_RGBA16_FLOAT,
} from '../index.js';

const IDENTITY_VP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const SIMPLE_SHADER = `
@vertex
fn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, 1.0);
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.7, 0.9, 1.0);
}
`;

const FULLSCREEN_SHADER = `
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(pos[idx], 0.0, 1.0);
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.9, 0.4, 0.1, 1.0);
}
`;

async function makeNullDevice() {
  const adapter = (await nullRhi.requestAdapter()).unwrap();
  return (await adapter.requestDevice()).unwrap();
}

function runReferenceScenario(kernel: RenderKernel) {
  const vertices = new Float32Array([-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.0, 0.5, 0.5]);
  const indices = new Uint16Array([0, 1, 2]);
  const mesh = kernel.assets
    .createMesh(
      { vertexLayoutId: 1, vertexCount: 3, indexCount: 3, isUint32Index: false, label: 'tri' },
      new Uint8Array(vertices.buffer),
      new Uint8Array(indices.buffer),
    )
    .unwrap();
  const shader = kernel.assets
    .registerShaderProgram({
      code: SIMPLE_SHADER,
      layoutFamilyId: 1,
      colorFormats: ['rgba16float'],
      label: 'pbr-basic',
    })
    .unwrap();
  const postShader = kernel.assets
    .registerShaderProgram({
      code: FULLSCREEN_SHADER,
      layoutFamilyId: 0,
      colorFormats: ['rgba8unorm'],
      label: 'tonemap',
    })
    .unwrap();
  const dynTex = kernel.assets
    .createDynamicTexture({
      width: 64,
      height: 64,
      format: TEXTURE_FORMAT_RGBA8_UNORM,
      label: 'canvas-0',
    })
    .unwrap();

  // Same-size Canvas updates must be in-place (false), resize triggers reallocation (true).
  const pixels64 = new Uint8Array(64 * 64 * 4);
  const pixels128 = new Uint8Array(128 * 128 * 4);
  const sameSize1 = kernel.assets.uploadDynamicTexture(dynTex, 1, 64, 64, pixels64).unwrap();
  const sameSize2 = kernel.assets.uploadDynamicTexture(dynTex, 2, 64, 64, pixels64).unwrap();
  const resized = kernel.assets.uploadDynamicTexture(dynTex, 3, 128, 128, pixels128).unwrap();

  const opaqueMat = kernel.assets
    .createMaterial(
      {
        shaderProgramId: shader,
        layoutFamilyId: 1,
        renderStateBits: 0x11,
        queue: 1000,
        dynamicTextureIds: [dynTex],
      },
      new Uint8Array(64),
    )
    .unwrap();
  const transMat = kernel.assets
    .createMaterial(
      { shaderProgramId: shader, layoutFamilyId: 1, renderStateBits: 0x22, queue: 3000 },
      new Uint8Array(64),
    )
    .unwrap();

  // Baseline FXK1 SceneDelta: 2 identical opaque inside, 1 culled outside, 2 transparent at distinct depths
  const delta = kernel.beginSceneDelta();
  delta
    .reset(1, 1, 0, DELTA_FLAG_BASELINE, 0.016, 0.016, 0.016, 0)
    .upsertObjects([
      {
        objectId: 10 as RenderObjectId,
        meshId: mesh,
        materialId: opaqueMat,
        queue: 1000,
        entityOrder: 1,
        objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
        localBoundsMin: [-0.2, -0.2, -0.2],
        localBoundsMax: [0.2, 0.2, 0.2],
      },
      {
        objectId: 11 as RenderObjectId,
        meshId: mesh,
        materialId: opaqueMat,
        queue: 1000,
        entityOrder: 2,
        objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
        localBoundsMin: [-0.2, -0.2, -0.2],
        localBoundsMax: [0.2, 0.2, 0.2],
      },
      {
        objectId: 12 as RenderObjectId,
        meshId: mesh,
        materialId: opaqueMat,
        queue: 1000,
        entityOrder: 3,
        objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
        localBoundsMin: [-0.2, -0.2, -0.2],
        localBoundsMax: [0.2, 0.2, 0.2],
      },
      {
        objectId: 13 as RenderObjectId,
        meshId: mesh,
        materialId: transMat,
        queue: 3000,
        entityOrder: 4,
        objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_TRANSPARENT | OBJ_FLAG_FRUSTUM_CULLED,
        localBoundsMin: [-0.1, -0.1, -0.1],
        localBoundsMax: [0.1, 0.1, 0.1],
      },
      {
        objectId: 14 as RenderObjectId,
        meshId: mesh,
        materialId: transMat,
        queue: 3000,
        entityOrder: 5,
        objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_TRANSPARENT | OBJ_FLAG_FRUSTUM_CULLED,
        localBoundsMin: [-0.1, -0.1, -0.1],
        localBoundsMax: [0.1, 0.1, 0.1],
      },
    ])
    .setTransforms(
      [10, 11, 12, 13, 14],
      new Float32Array([
        // 10: inside
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.0, 0.0, 0.4, 1,
        // 11: inside (folds with 10 via instancing!)
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, 0.0, 0.4, 1,
        // 12: outside frustum (x=50)
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50.0, 0.0, 0.4, 1,
        // 13: transparent near
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.0, 0.0, 0.2, 1,
        // 14: transparent far
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.0, 0.0, 0.8, 1,
      ]),
    )
    .setLights([
      {
        lightId: 100 as LightId,
        kind: 0,
        castShadow: true,
        cascadeCount: 3,
        position: [0, 10, 0],
        intensity: 3.0,
        direction: [0, -1, 0],
        color: [1, 0.98, 0.92],
      },
    ]);
  const rev = kernel.commitSceneDelta(delta).unwrap();

  const rec = kernel.beginFrame(1, 1280, 800).unwrap();
  const cull = kernel
    .cull({
      viewProj: IDENTITY_VP,
      cameraPos: [0, 0, 0],
      flags: CULL_FLAG_CULL_LIGHTS | CULL_FLAG_COMPUTE_VISIBLE_BOUNDS,
    })
    .unwrap();

  // Pass 1: Shadow depth pass
  const shadowTex = rec.acquireTempTexture(
    TEXTURE_FORMAT_DEPTH32_FLOAT,
    1024,
    1024,
    1,
    1,
    1,
    0x14,
    COLOR_DOMAIN_LINEAR_HDR,
  );
  rec.beginRenderPass({
    labelId: 1,
    colorAttachments: [],
    depthAttachment: { texture: shadowTex, loadOp: 'clear', storeOp: 'store', clearDepth: 0.0 },
  });
  rec.drawRenderers({
    cullId: cull.cullId,
    passTag: PASS_TAG_SHADOW_DEPTH,
    queueMin: 0,
    queueMax: 2499,
    sortMode: SORT_MATERIAL_PSO,
    drawFlags: DRAW_FLAG_INSTANCING,
    passAttachmentId: 1,
  });
  rec.endRenderPass();

  // Pass 2 & Pass 3: Opaque + Transparent on identical attachments (loadOp='load' merges passes!)
  const hdrTex = rec.acquireTempTexture(
    TEXTURE_FORMAT_RGBA16_FLOAT,
    0,
    0,
    1,
    1,
    1,
    0x14,
    COLOR_DOMAIN_LINEAR_HDR,
  );
  const depthTex = rec.acquireTempTexture(
    TEXTURE_FORMAT_DEPTH32_FLOAT,
    0,
    0,
    1,
    1,
    1,
    0x10,
    COLOR_DOMAIN_LINEAR_HDR,
  );
  rec.beginRenderPass({
    labelId: 2,
    colorAttachments: [{ texture: hdrTex, loadOp: 'clear', clearColor: [0, 0, 0, 1] }],
    depthAttachment: { texture: depthTex, loadOp: 'clear', clearDepth: 0.0 },
  });
  rec.drawRenderers({
    cullId: cull.cullId,
    passTag: PASS_TAG_FORWARD_OPAQUE,
    queueMin: 0,
    queueMax: 2499,
    sortMode: SORT_MATERIAL_PSO,
    drawFlags: DRAW_FLAG_INSTANCING,
    passAttachmentId: 2,
  });
  rec.endRenderPass();

  rec.beginRenderPass({
    labelId: 3,
    colorAttachments: [{ texture: hdrTex, loadOp: 'load' }],
    depthAttachment: { texture: depthTex, loadOp: 'load' },
  });
  rec.drawRenderers({
    cullId: cull.cullId,
    passTag: PASS_TAG_FORWARD_TRANSPARENT,
    queueMin: 2500,
    queueMax: 5000,
    sortMode: SORT_BACK_TO_FRONT,
    drawFlags: 0,
    passAttachmentId: 2,
  });
  rec.endRenderPass();

  // Pass 4: Post fullscreen pass into final RGBA8 target
  const outTex = rec.acquireTempTexture(
    TEXTURE_FORMAT_RGBA8_UNORM,
    0,
    0,
    1,
    1,
    1,
    0x11,
    COLOR_DOMAIN_LINEAR_HDR,
  );
  const postBindings = rec.beginBindingSet().bindTexture(0, hdrTex).finish();
  rec.beginRenderPass({
    labelId: 4,
    colorAttachments: [{ texture: outTex, loadOp: 'clear', clearColor: [0, 0, 0, 1] }],
  });
  rec.drawFullscreen(postShader, postBindings);
  rec.endRenderPass();

  const receipt = kernel.submitFrame(rec).unwrap();
  return { sameSize1, sameSize2, resized, rev, cull, receipt };
}

describe('RenderKernel TS vs Rust WASM bit-identical parity', () => {
  it('produces word-for-word identical physical command streams, cull summaries, and receipts', async () => {
    const tsDev = await makeNullDevice();
    const wasmDev = await makeNullDevice();
    const tsKernel = (
      await createRenderKernel({
        device: tsDev,
        createShaderModuleImmediate: nullRhi.createShaderModuleImmediate,
        backend: 'ts',
      })
    ).unwrap();
    const wasmKernel = (
      await createRenderKernel({
        device: wasmDev,
        createShaderModuleImmediate: nullRhi.createShaderModuleImmediate,
        backend: 'wasm',
      })
    ).unwrap();
    expect(tsKernel.mode).toBe('ts');
    expect(wasmKernel.mode).toBe('wasm');

    try {
      const a = runReferenceScenario(tsKernel);
      const b = runReferenceScenario(wasmKernel);

      expect(a.sameSize1).toBe(false);
      expect(a.sameSize2).toBe(false);
      expect(a.resized).toBe(true);
      expect(b.sameSize1).toBe(false);
      expect(b.sameSize2).toBe(false);
      expect(b.resized).toBe(true);

      expect(a.rev).toBe(1);
      expect(b.rev).toBe(1);
      expect(a.cull.candidateCount).toBe(5);
      expect(a.cull.visibleOpaqueCount).toBe(2);
      expect(a.cull.visibleTransparentCount).toBe(2);
      expect(a.cull.visibleLights.length).toBe(1);
      expect(b.cull).toEqual(a.cull);

      // Compatible opaque+transparent passes merge into one physical pass -> 3 total passes, 1 merged
      expect(a.receipt.submittedPassCount).toBe(3);
      expect(a.receipt.mergedPassCount).toBe(1);
      expect(b.receipt.submittedPassCount).toBe(a.receipt.submittedPassCount);
      expect(b.receipt.mergedPassCount).toBe(a.receipt.mergedPassCount);
      expect(b.receipt.submittedDrawCount).toBe(a.receipt.submittedDrawCount);
      expect(b.receipt.poolTextureCount).toBe(a.receipt.poolTextureCount);
      expect(Array.from(b.receipt.submittedBitmap)).toEqual(Array.from(a.receipt.submittedBitmap));
      // Word-for-word identical resolved physical command stream!
      expect(Array.from(b.receipt.resolvedPhysicalCommands)).toEqual(
        Array.from(a.receipt.resolvedPhysicalCommands),
      );
    } finally {
      tsKernel.dispose();
      wasmKernel.dispose();
    }
  });

  it('rejects pass read/write conflicts and stale handles symmetrically on both backends', async () => {
    for (const backend of ['ts', 'wasm'] as const) {
      const dev = await makeNullDevice();
      const kernel = (await createRenderKernel({ device: dev, backend })).unwrap();
      try {
        const dyn = kernel.assets
          .createDynamicTexture({ width: 16, height: 16, format: TEXTURE_FORMAT_RGBA8_UNORM })
          .unwrap();
        expect(kernel.assets.destroyDynamicTexture(dyn).ok).toBe(true);
        const dup = kernel.assets.destroyDynamicTexture(dyn);
        expect(dup.ok).toBe(false);
        if (!dup.ok) expect(dup.error.code).toBe('kernel-handle-stale-generation');

        const rec = kernel.beginFrame(1, 64, 64).unwrap();
        const rt = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 64, 64, 1, 1, 1, 0x14);
        rec.beginRenderPass({ colorAttachments: [{ texture: rt }] });
        // Illegal: sampling the exact attachment currently being rendered to in the same pass!
        rec.beginBindingSet().bindTexture(0, rt).finish();
        rec.endRenderPass();
        const bad = kernel.submitFrame(rec);
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error.code).toBe('kernel-pass-resource-conflict');
      } finally {
        kernel.dispose();
      }
    }
  });

  it('matches TsHotPathAccel and WasmHotPathAccel bit-for-bit on bulk cull and transparent sort', async () => {
    const tsAccel = await createRenderKernelHotPath('ts', 256);
    const wasmAccel = await createRenderKernelHotPath('wasm', 256);
    expect(tsAccel.mode).toBe('ts');
    expect(wasmAccel.mode).toBe('wasm');
    try {
      const count = 200;
      const tb = tsAccel.borrowCullBuffers(count);
      const wb = wasmAccel.borrowCullBuffers(count);
      tb.cameraVp.set(IDENTITY_VP);
      wb.cameraVp.set(IDENTITY_VP);
      for (let i = 0; i < count; i++) {
        const ab = i * 6;
        const mb = i * 16;
        tb.localAabbs.set([-0.2, -0.2, -0.2, 0.2, 0.2, 0.2], ab);
        wb.localAabbs.set([-0.2, -0.2, -0.2, 0.2, 0.2, 0.2], ab);
        const x = i % 3 === 0 ? 100.0 : (i % 7) * 0.1 - 0.3;
        const z = 0.2 + (i % 5) * 0.1;
        const mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1];
        tb.worldMatrices.set(mat, mb);
        wb.worldMatrices.set(mat, mb);
        tb.flags[i] = 1 | 2 | (i % 2 === 0 ? 4 : 0);
        wb.flags[i] = tb.flags[i] as number;
        tb.layerMasks[i] = 0xffff_ffff;
        wb.layerMasks[i] = 0xffff_ffff;
      }
      const visTs = tsAccel.runTransformAndCull(count, 0xffff_ffff, false, true);
      const visWasm = wasmAccel.runTransformAndCull(count, 0xffff_ffff, false, true);
      expect(Array.from(visWasm)).toEqual(Array.from(visTs));
      expect(visTs.length).toBeGreaterThan(100);

      const tsSort = tsAccel.borrowSortBuffers(count);
      const wasmSort = wasmAccel.borrowSortBuffers(count);
      for (let i = 0; i < count; i++) {
        const pos = [(i * 13) % 19, (i * 7) % 11, (i * 5) % 23];
        tsSort.positions.set(pos, i * 3);
        wasmSort.positions.set(pos, i * 3);
        tsSort.layers[i] = i % 3;
        wasmSort.layers[i] = i % 3;
        tsSort.ties[i] = i;
        wasmSort.ties[i] = i;
      }
      const orderTs = tsAccel.runSortTransparent(count, 0, 0, 0);
      const orderWasm = wasmAccel.runSortTransparent(count, 0, 0, 0);
      expect(Array.from(orderWasm)).toEqual(Array.from(orderTs));

      // Verify multi-camera world-AABB culling parity & cached view stability (zero wrapper allocs)
      const camPlanes = new Float32Array([
        // Camera 0: box [-1, 1] x [-1, 1] x [0, 1]
        1, 0, 0, 1, -1, 0, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 0, 0, 0, -1, 1,
        // Camera 1: shifted box [9, 11] x [-1, 1] x [0, 1]
        1, 0, 0, -9, -1, 0, 0, 11, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 0, 0, 0, -1, 1,
      ]);
      const twa = tsAccel.borrowWorldAabbCullBuffers(count, 2);
      const wwa = wasmAccel.borrowWorldAabbCullBuffers(count, 2);
      // Repeated borrow within capacity returns exact cached wrapper references
      expect(tsAccel.borrowWorldAabbCullBuffers(count, 2)).toBe(twa);
      expect(wasmAccel.borrowWorldAabbCullBuffers(count, 2)).toBe(wwa);
      twa.frustumPlanes.set(camPlanes);
      wwa.frustumPlanes.set(camPlanes);
      for (let i = 0; i < count; i++) {
        const ab = i * 6;
        const x = i % 3 === 0 ? 0.0 : i % 3 === 1 ? 10.0 : 50.0;
        twa.worldAabbs.set([x - 0.2, -0.2, 0.2, x + 0.2, 0.2, 0.6], ab);
        wwa.worldAabbs.set([x - 0.2, -0.2, 0.2, x + 0.2, 0.2, 0.6], ab);
      }
      const resTs = tsAccel.runCullWorldAabbs(count, 2);
      const resWasm = wasmAccel.runCullWorldAabbs(count, 2);
      expect(resWasm.visibleCount).toBe(resTs.visibleCount);
      const words = Math.ceil(count / 32);
      expect(Array.from(resWasm.bits.subarray(0, words))).toEqual(
        Array.from(resTs.bits.subarray(0, words)),
      );
    } finally {
      tsAccel.dispose();
      wasmAccel.dispose();
    }
  });

  it('packs 128-bit PsoKey deterministically', () => {
    const out = new Uint32Array(4);
    packPsoKeyInto(out, 0, 7, 3, 2, 1, 4, 0x1234_5678, 0x00ab);
    expect(out[0]).toBe(((3 << 24) | (2 << 8) | 1) >>> 0);
    expect(out[1]).toBe((7 << 8) >>> 0);
    expect(out[2]).toBe(((0x5678 << 16) | 0x00ab) >>> 0);
    expect(out[3]).toBe(((4 << 16) | 0x1234) >>> 0);
  });
});
