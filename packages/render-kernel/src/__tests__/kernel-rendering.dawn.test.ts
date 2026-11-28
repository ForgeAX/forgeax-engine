/// <reference types="@webgpu/types" />
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  readbackTexturePixels,
} from '@forgeax/engine-rhi-debug';
import {
  createShaderModule,
  createShaderModuleImmediate,
  rhi as webgpuRhi,
} from '@forgeax/engine-rhi-webgpu';
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

const SKIP_DAWN = process.env.FORGEAX_SKIP_DAWN === '1';

const WGSL_TRI = `
@vertex
fn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, 1.0);
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.8, 0.4, 1.0);
}
`;

const WGSL_FULLSCREEN_SAMPLE = `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[idx], 0.0, 1.0);
  o.uv = uv[idx];
  return o;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(srcTex, srcSampler, in.uv);
  return vec4<f32>(c.g, c.r, c.b, 1.0);
}
`;

const IDENTITY_VP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

async function ensureDawnWebGpu(): Promise<boolean> {
  if (SKIP_DAWN) return false;
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) return true;
  try {
    const dawn = await import('@forgeax/engine-dawn-node');
    const gpu = dawn.create([]);
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu },
      configurable: true,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
}

describe('RenderKernel Dawn GPU pixel & RHI Debug replay verification', () => {
  it('renders byte-identical GPU pixels on TS and Rust WASM kernels and replays cleanly through RHI Debug', async () => {
    const ready = await ensureDawnWebGpu();
    if (!ready) return;

    const results: Record<'ts' | 'wasm', Uint8Array> = {} as Record<'ts' | 'wasm', Uint8Array>;

    for (const backend of ['ts', 'wasm'] as const) {
      const attached = attachRecorder({
        rhi: webgpuRhi,
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
        // Full-coverage triangle covering the 32x32 target center
        const verts = new Float32Array([-1.0, -1.0, 0.5, 3.0, -1.0, 0.5, -1.0, 3.0, 0.5]);
        const idx = new Uint16Array([0, 1, 2]);
        const mesh = kernel.assets
          .createMesh(
            {
              vertexLayoutId: 1,
              vertexCount: 3,
              indexCount: 3,
              isUint32Index: false,
              label: 'quad-tri',
            },
            new Uint8Array(verts.buffer),
            new Uint8Array(idx.buffer),
          )
          .unwrap();
        const triShader = kernel.assets
          .registerShaderProgram({
            code: WGSL_TRI,
            layoutFamilyId: 1,
            colorFormats: ['rgba8unorm'],
            vertexBufferLayouts: [
              {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
              },
            ],
            label: 'tri-green',
          })
          .unwrap();
        const postShader = kernel.assets
          .registerShaderProgram({
            code: WGSL_FULLSCREEN_SAMPLE,
            layoutFamilyId: 0,
            colorFormats: ['rgba8unorm'],
            label: 'swizzle-post',
          })
          .unwrap();
        const sampler = kernel.assets
          .createSampler({ magFilter: 'nearest', minFilter: 'nearest' })
          .unwrap();
        const mat = kernel.assets
          .createMaterial(
            { shaderProgramId: triShader, layoutFamilyId: 1, renderStateBits: 1, queue: 1000 },
            new Uint8Array(16),
          )
          .unwrap();

        // Also exercise DynamicTexture in-place update on real GPU!
        const dynTex = kernel.assets
          .createDynamicTexture({ width: 4, height: 4, format: TEXTURE_FORMAT_RGBA8_UNORM })
          .unwrap();
        const dynBytes = new Uint8Array(4 * 4 * 4).fill(200);
        expect(kernel.assets.uploadDynamicTexture(dynTex, 1, 4, 4, dynBytes).unwrap()).toBe(false);

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
              localBoundsMin: [-1, -1, -1],
              localBoundsMax: [1, 1, 1],
            },
          ])
          .setTransforms([1], new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1]));
        kernel.commitSceneDelta(delta).unwrap();

        const capturePromise = attached.captureFrame();
        (await attached.frameBoundary()).unwrap();

        const rec = kernel.beginFrame(1, 32, 32).unwrap();
        const cull = kernel.cull({ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }).unwrap();
        // Pass 1: Geometry pass draws green (0.2, 0.8, 0.4) into pooled RT 1
        const sceneColor = rec.acquireTempTexture(
          TEXTURE_FORMAT_RGBA8_UNORM,
          32,
          32,
          1,
          1,
          1,
          0x15,
        );
        // Pass 2: Fullscreen post pass samples RT 1 and swizzles R<->G -> (0.8, 0.2, 0.4) into pooled RT 2
        const finalColor = rec.acquireTempTexture(
          TEXTURE_FORMAT_RGBA8_UNORM,
          32,
          32,
          1,
          1,
          1,
          0x11,
        );

        rec.beginRenderPass({
          labelId: 1,
          colorAttachments: [{ texture: sceneColor, clearColor: [0, 0, 0, 1] }],
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

        const postBindings = rec
          .beginBindingSet()
          .bindTexture(0, sceneColor)
          .bindSampler(1, sampler)
          .finish();
        rec.beginRenderPass({
          labelId: 2,
          colorAttachments: [{ texture: finalColor, clearColor: [0, 0, 0, 1] }],
        });
        rec.drawFullscreen(postShader, postBindings);
        rec.endRenderPass();

        const receipt = kernel.submitFrame(rec).unwrap();
        expect(receipt.submittedPassCount).toBe(2);
        expect(receipt.submittedDrawCount).toBe(2);

        (await attached.frameBoundary()).unwrap();
        const encoded = (await capturePromise).unwrap();

        // Read back actual GPU pixels from pooled finalColor (pool slot 2)
        const poolTex = kernel.getPoolTexture(2);
        expect(poolTex).toBeDefined();
        if (poolTex === undefined) throw new Error('expected pooled finalColor texture');
        const rawDev = attached.backend.unwrapDeviceForSurface(device).unwrap();
        const pixels = await readbackTexturePixels(rawDev, poolTex, 32, 32);
        // Center pixel (16, 16): expected swizzled ~(204, 51, 102, 255)
        const centerOff = (16 * 32 + 16) * 4;
        expect(Math.abs((pixels[centerOff] as number) - 204)).toBeLessThanOrEqual(2);
        expect(Math.abs((pixels[centerOff + 1] as number) - 51)).toBeLessThanOrEqual(2);
        expect(Math.abs((pixels[centerOff + 2] as number) - 102)).toBeLessThanOrEqual(2);
        expect(pixels[centerOff + 3]).toBe(255);
        results[backend] = pixels;

        // Replay the captured RHI Debug .rhitape on a fresh Dawn device!
        const tape = decodeTape(encoded.bytes).unwrap();
        const model = buildFrameModel(tape);
        expect(model.passes.length).toBe(2);
        expect(model.works.length).toBe(2);
        const replayAdapter = (await webgpuRhi.requestAdapter()).unwrap();
        const replayDevice = (await replayAdapter.requestDevice()).unwrap();
        const replay = (
          await openReplay(tape, { device: replayDevice, createShaderModule })
        ).unwrap();
        try {
          const secondWork = model.works[1];
          if (secondWork === undefined) throw new Error('expected second captured work');
          const inspected = (
            await replay.inspectWork(secondWork.workIndex, ['pipeline', 'bindings', 'pixels'])
          ).unwrap();
          expect(inspected.pipeline).toBeDefined();
        } finally {
          await replay.dispose();
        }
      } finally {
        kernel.dispose();
        await attached.dispose();
      }
    }

    // TS Kernel and Rust WASM Kernel produce byte-for-byte identical GPU output!
    expect(Array.from(results.wasm)).toEqual(Array.from(results.ts));
  }, 60_000);
});
