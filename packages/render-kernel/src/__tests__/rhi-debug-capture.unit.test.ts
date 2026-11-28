import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import {
  createShaderModule,
  createShaderModuleImmediate,
  rhi as nullRhi,
} from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import {
  createRenderKernel,
  DELTA_FLAG_BASELINE,
  DRAW_FLAG_INSTANCING,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_VISIBLE,
  PASS_TAG_FORWARD_OPAQUE,
  type RenderObjectId,
  SORT_MATERIAL_PSO,
  TEXTURE_FORMAT_RGBA8_UNORM,
} from '../index.js';

const WGSL_TRI = `
@vertex
fn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, 1.0);
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.25, 0.75, 0.5, 1.0);
}
`;

const WGSL_FULLSCREEN = `
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[idx], 0.0, 1.0);
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.2, 0.1, 1.0);
}
`;

const IDENTITY_VP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('RenderKernel RHI Debug v7 capture integration', () => {
  it.each([
    'ts',
    'wasm',
  ] as const)('captures, decodes, and projects a valid v7 FrameModel for %s kernel', async (backend) => {
    const attached = attachRecorder({
      rhi: nullRhi,
      createShaderModule,
      createShaderModuleImmediate,
    }).unwrap();
    const adapter = (await attached.backend.rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const kernel = (
      await createRenderKernel({
        device,
        createShaderModuleImmediate: attached.backend.createShaderModuleImmediate,
        backend,
      })
    ).unwrap();

    try {
      const verts = new Float32Array([-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0, 0.5, 0.5]);
      const idx = new Uint16Array([0, 1, 2]);
      const mesh = kernel.assets
        .createMesh(
          { vertexLayoutId: 1, vertexCount: 3, indexCount: 3, isUint32Index: false, label: 'tri' },
          new Uint8Array(verts.buffer),
          new Uint8Array(idx.buffer),
        )
        .unwrap();
      const shader = kernel.assets
        .registerShaderProgram({
          code: WGSL_TRI,
          layoutFamilyId: 1,
          colorFormats: ['rgba8unorm'],
          label: 'tri-shader',
        })
        .unwrap();
      const postShader = kernel.assets
        .registerShaderProgram({
          code: WGSL_FULLSCREEN,
          layoutFamilyId: 0,
          colorFormats: ['rgba8unorm'],
          label: 'fs-shader',
        })
        .unwrap();
      const mat = kernel.assets
        .createMaterial(
          { shaderProgramId: shader, layoutFamilyId: 1, renderStateBits: 1, queue: 1000 },
          new Uint8Array(16),
        )
        .unwrap();

      const delta = kernel.beginSceneDelta();
      delta
        .reset(1, 1, 0, DELTA_FLAG_BASELINE)
        .upsertObjects([
          {
            objectId: 1 as RenderObjectId,
            meshId: mesh,
            materialId: mat,
            queue: 1000,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-0.5, -0.5, -0.5],
            localBoundsMax: [0.5, 0.5, 0.5],
          },
        ])
        .setTransforms([1], new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1]));
      kernel.commitSceneDelta(delta).unwrap();

      const capturePromise = attached.captureFrame({ seed: { maxResourceBytes: 0 } });
      (await attached.frameBoundary()).unwrap();

      const rec = kernel.beginFrame(1, 64, 64).unwrap();
      const cull = kernel.cull({ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }).unwrap();
      const colorA = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 64, 64, 1, 1, 1, 0x15);
      const colorB = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 64, 64, 1, 1, 1, 0x11);
      rec.beginRenderPass({
        labelId: 1,
        colorAttachments: [{ texture: colorA, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawRenderers({
        cullId: cull.cullId,
        passTag: PASS_TAG_FORWARD_OPAQUE,
        queueMin: 0,
        queueMax: 2499,
        sortMode: SORT_MATERIAL_PSO,
        drawFlags: DRAW_FLAG_INSTANCING,
      });
      rec.endRenderPass();
      rec.beginRenderPass({
        labelId: 2,
        colorAttachments: [{ texture: colorB, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawFullscreen(postShader);
      rec.endRenderPass();

      const receipt = kernel.submitFrame(rec).unwrap();
      expect(receipt.submittedPassCount).toBe(2);
      expect(receipt.submittedDrawCount).toBe(2);

      (await attached.frameBoundary()).unwrap();
      const encoded = (await capturePromise).unwrap();
      expect(encoded.bytes.byteLength).toBeGreaterThan(0);

      const decoded = decodeTape(encoded.bytes).unwrap();
      const model = buildFrameModel(decoded);
      const summary = summarizeFrame(model);

      expect(model.passes.length).toBe(2);
      expect(model.works.length).toBe(2);
      expect(summary.passCount).toBe(2);
      expect(summary.works.length).toBe(2);
    } finally {
      kernel.dispose();
      await attached.dispose();
    }
  });
});
