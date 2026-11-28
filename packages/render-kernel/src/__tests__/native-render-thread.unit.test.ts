import { describe, expect, it } from 'vitest';
import { createNativeRenderKernel, isNativeRenderKernelAvailable } from '../desktop/index.js';
import {
  type CullId,
  DELTA_FLAG_BASELINE,
  DRAW_FLAG_INSTANCING,
  LAYOUT_FAMILY_SCENE_4BGL,
  type LightId,
  OBJ_FLAG_CAST_SHADOW,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_VISIBLE,
  PASS_TAG_FORWARD_OPAQUE,
  PASS_TAG_SHADOW_DEPTH,
  RENDER_STATE_DEPTH_LESS_EQUAL,
  RENDER_STATE_DEPTH_WRITE,
  type RenderObjectId,
  SORT_MATERIAL_PSO,
  TEXTURE_FORMAT_DEPTH32_FLOAT,
  TEXTURE_FORMAT_RGBA8_UNORM,
} from '../index.js';

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

const WGSL_COMPUTE_DOUBLE = `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(4)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  data[gid.x] = data[gid.x] * 2u + 7u;
}
`;

const IDENTITY_VP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('NativeRenderKernel (napi-rs + wgpu 30 dedicated OS render thread)', () => {
  it('renders exact two-pass pixels, executes compute, and pipelines 60 frames off main thread', () => {
    if (!isNativeRenderKernelAvailable()) return;

    const kernel = createNativeRenderKernel({ maxInFlight: 2 }).unwrap();
    try {
      expect(kernel.backendKind).toBe('rust-wgpu-native');
      expect(kernel.version).toContain('30.0.1');

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
      const csShader = kernel.assets
        .registerShaderProgram({
          code: WGSL_COMPUTE_DOUBLE,
          computeEntryPoint: 'cs_main',
          layoutFamilyId: 0,
          label: 'compute-double',
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

      // DynamicTexture same-size in-place update vs resize reallocation
      const dynTex = kernel.assets
        .createDynamicTexture({ width: 4, height: 4, format: TEXTURE_FORMAT_RGBA8_UNORM })
        .unwrap();
      expect(
        kernel.assets
          .uploadDynamicTexture(dynTex, 1, 4, 4, new Uint8Array(4 * 4 * 4).fill(200))
          .unwrap(),
      ).toBe(false);
      expect(
        kernel.assets
          .uploadDynamicTexture(dynTex, 2, 8, 8, new Uint8Array(8 * 8 * 4).fill(120))
          .unwrap(),
      ).toBe(true);

      // Commit 1-object scene delta
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
      expect(kernel.commitSceneDelta(delta).unwrap()).toBe(1);

      // Frame 1 (sync): 2-pass raster -> fullscreen swizzle -> readback pixel parity with Dawn!
      const rec = kernel.beginFrame(1, 32, 32).unwrap();
      const cull = kernel.cull({ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }).unwrap();
      expect(cull.visibleOpaqueCount).toBe(1);

      const sceneColor = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 32, 32, 1, 1, 1, 0x15);
      const finalColor = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 32, 32, 1, 1, 1, 0x11);

      rec.beginRenderPass({
        labelId: 1,
        colorAttachments: [{ texture: sceneColor, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawRenderers({
        cullId: cull.cullId,
        passTag: PASS_TAG_FORWARD_OPAQUE,
        sortMode: SORT_MATERIAL_PSO,
        drawFlags: DRAW_FLAG_INSTANCING,
        queueMin: 0,
        queueMax: 2500,
        passAttachmentId: 1,
      });
      rec.endRenderPass();

      const bs = rec.beginBindingSet().bindTexture(0, sceneColor).bindSampler(1, sampler).finish();
      rec.beginRenderPass({
        labelId: 2,
        colorAttachments: [{ texture: finalColor, clearColor: [0, 0, 0, 1] }],
      });
      rec.drawFullscreen(postShader, bs);
      rec.endRenderPass();

      const receipt = kernel.submitFrame(rec).unwrap();
      expect(receipt.executedPasses).toBe(2);
      expect(receipt.submittedDrawCount).toBe(2);

      const rb = kernel.readbackPoolTexture(2).unwrap();
      expect(rb.width).toBe(32);
      expect(rb.height).toBe(32);
      const off = (16 * 32 + 16) * 4;
      expect(Math.abs((rb.pixels[off] as number) - 204)).toBeLessThanOrEqual(2);
      expect(Math.abs((rb.pixels[off + 1] as number) - 51)).toBeLessThanOrEqual(2);
      expect(Math.abs((rb.pixels[off + 2] as number) - 102)).toBeLessThanOrEqual(2);
      expect(rb.pixels[off + 3]).toBe(255);

      // Frame 2 (sync): GPU compute pass verification
      const csBuf = kernel.assets
        .createBuffer(
          { size: 16, usage: 0x0080 | 0x0004 | 0x0008, label: 'cs-buf' },
          new Uint8Array(new Uint32Array([1, 2, 3, 4]).buffer),
        )
        .unwrap();
      const rec2 = kernel.beginFrame(2, 32, 32).unwrap();
      const csSet = rec2.beginBindingSet().bindBuffer(0, csBuf, 0).finish();
      rec2.beginComputePass(1);
      rec2.dispatch(csShader, csSet, 1, 1, 1);
      rec2.endComputePass();
      expect(kernel.submitFrame(rec2).unwrap().executedPasses).toBe(1);
      const outBytes = kernel.readbackBuffer(csBuf, 0, 16).unwrap();
      const outU32 = new Uint32Array(outBytes.buffer, outBytes.byteOffset, 4);
      expect(Array.from(outU32)).toEqual([9, 11, 13, 15]);

      // Frames 3..62 (async pipelined on dedicated OS render thread with 1,000 scene objects!)
      const bulkDelta = kernel.beginSceneDelta(256 * 1024);
      const count = 1000;
      const objects = [];
      const ids: number[] = [];
      const transforms = new Float32Array(count * 16);
      for (let i = 0; i < count; i++) {
        const oid = (i + 1) as RenderObjectId;
        objects.push({
          objectId: oid,
          meshId: mesh,
          materialId: mat,
          queue: 1000,
          objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
          localBoundsMin: [-0.5, -0.5, -0.5] as const,
          localBoundsMax: [0.5, 0.5, 0.5] as const,
        });
        ids.push(oid);
        const m = i * 16;
        transforms[m] = 1;
        transforms[m + 5] = 1;
        transforms[m + 10] = 1;
        transforms[m + 15] = 1;
        transforms[m + 12] = ((i % 20) - 10) * 0.05;
        transforms[m + 13] = (Math.floor(i / 20) - 25) * 0.02;
        transforms[m + 14] = 0.5;
      }
      bulkDelta
        .reset(1, 2, 1, DELTA_FLAG_BASELINE)
        .upsertObjects(objects)
        .setTransforms(ids, transforms);
      expect(kernel.commitSceneDelta(bulkDelta).unwrap()).toBe(2);

      // Submit 60 full 1,000-object frames asynchronously (cull + plan + wgpu encode/submit off main thread)
      const tStart = performance.now();
      for (let frame = 3; frame <= 62; frame++) {
        const pipeRec = kernel.preparePipelinedRecorder(frame, 32, 32);
        const rt = pipeRec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 32, 32, 1, 1, 1, 0x15);
        pipeRec.beginRenderPass({
          labelId: 10,
          colorAttachments: [{ texture: rt, clearColor: [0, 0, 0, 1] }],
        });
        pipeRec.drawRenderers({
          cullId: 1 as CullId,
          passTag: PASS_TAG_FORWARD_OPAQUE,
          sortMode: SORT_MATERIAL_PSO,
          drawFlags: DRAW_FLAG_INSTANCING,
          queueMin: 0,
          queueMax: 2500,
          passAttachmentId: 1,
        });
        pipeRec.endRenderPass();
        kernel
          .submitPipelinedFrameAsync(pipeRec, {
            culls: [{ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }],
          })
          .unwrap();
      }
      const enqueueElapsedMs = performance.now() - tStart;
      kernel.flush().unwrap();

      const stats = kernel.getThreadStats().unwrap();
      expect(stats.submittedFrames).toBe(62);
      expect(stats.completedFrames).toBe(62);
      expect(stats.lastCompletedFrameId).toBe(62);
      expect(stats.inFlightFrames).toBe(0);
      expect(stats.adapterName.length).toBeGreaterThan(0);
      expect(enqueueElapsedMs).toBeGreaterThan(0);
    } finally {
      kernel.dispose();
    }
  });

  it('executes fixed 4-BGL 3D lit multi-object scene with incremental dirty-row sync and rotating partial edits', () => {
    if (!isNativeRenderKernelAvailable()) return;

    const WGSL_4BGL_LIT = `
struct ViewUniform {
  view_proj: mat4x4<f32>,
  ambient: vec4<f32>,
};
struct MaterialUniform {
  albedo: vec4<f32>,
};
struct SceneObjectGpu {
  world: mat4x4<f32>,
  params0: vec4<f32>,
  params1: vec4<f32>,
};
struct SceneLightGpu {
  position_range: vec4<f32>,
  direction_intensity: vec4<f32>,
  color_outer_cos: vec4<f32>,
  flags_meta: vec4<u32>,
};
@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(1) @binding(0) var<uniform> u_mat: MaterialUniform;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(2) @binding(1) var<storage, read> s_lights: array<SceneLightGpu>;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world_n: vec3<f32>,
};
@vertex
fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @builtin(instance_index) inst: u32,
) -> VsOut {
  let row = s_instance_rows[inst];
  let obj = s_objects[row];
  var out: VsOut;
  out.pos = u_view.view_proj * (obj.world * vec4<f32>(pos, 1.0));
  out.world_n = normalize((obj.world * vec4<f32>(normal, 0.0)).xyz);
  return out;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let light = s_lights[0];
  let ldir = normalize(-light.direction_intensity.xyz);
  let ndotl = max(dot(normalize(in.world_n), ldir), 0.0);
  let lit = u_mat.albedo.rgb * (u_view.ambient.rgb + light.color_outer_cos.rgb * light.direction_intensity.w * ndotl);
  return vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

    const kernel = createNativeRenderKernel({ maxInFlight: 2 }).unwrap();
    try {
      const verts = new Float32Array([
        -0.25, -0.25, 0, 0, 0, 1, 0.25, -0.25, 0, 0, 0, 1, 0.25, 0.25, 0, 0, 0, 1, -0.25, 0.25, 0,
        0, 0, 1,
      ]);
      const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
      const mesh = kernel.assets
        .createMesh(
          {
            vertexLayoutId: 2,
            vertexCount: 4,
            indexCount: 6,
            isUint32Index: false,
            label: 'lit-quad',
          },
          new Uint8Array(verts.buffer),
          new Uint8Array(idx.buffer),
        )
        .unwrap();
      const shader = kernel.assets
        .registerShaderProgram({
          code: WGSL_4BGL_LIT,
          layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
          colorFormats: ['rgba8unorm'],
          vertexBufferLayouts: [
            {
              arrayStride: 24,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
              ],
            },
          ],
          label: 'lit-4bgl',
        })
        .unwrap();

      const matRed = kernel.assets
        .createMaterial(
          {
            shaderProgramId: shader,
            layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
            renderStateBits: 1,
            queue: 1000,
          },
          new Uint8Array(new Float32Array([0.8, 0.2, 0.2, 1.0]).buffer),
        )
        .unwrap();
      const matBlue = kernel.assets
        .createMaterial(
          {
            shaderProgramId: shader,
            layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
            renderStateBits: 1,
            queue: 1000,
          },
          new Uint8Array(new Float32Array([0.2, 0.4, 0.9, 1.0]).buffer),
        )
        .unwrap();

      const makeMat = (tx: number, ty: number, tz: number): number[] => [
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        tx,
        ty,
        tz,
        1,
      ];

      // Interleaved 4 objects across matRed & matBlue proving non-contiguous instance_rows indirection
      const delta1 = kernel.beginSceneDelta();
      delta1
        .reset(1, 1, 0, DELTA_FLAG_BASELINE)
        .upsertObjects([
          {
            objectId: 1 as RenderObjectId,
            meshId: mesh,
            materialId: matRed,
            queue: 1000,
            entityOrder: 1,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-0.25, -0.25, -0.1],
            localBoundsMax: [0.25, 0.25, 0.1],
          },
          {
            objectId: 2 as RenderObjectId,
            meshId: mesh,
            materialId: matBlue,
            queue: 1000,
            entityOrder: 2,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-0.25, -0.25, -0.1],
            localBoundsMax: [0.25, 0.25, 0.1],
          },
          {
            objectId: 3 as RenderObjectId,
            meshId: mesh,
            materialId: matRed,
            queue: 1000,
            entityOrder: 3,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-0.25, -0.25, -0.1],
            localBoundsMax: [0.25, 0.25, 0.1],
          },
          {
            objectId: 4 as RenderObjectId,
            meshId: mesh,
            materialId: matBlue,
            queue: 1000,
            entityOrder: 4,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-0.25, -0.25, -0.1],
            localBoundsMax: [0.25, 0.25, 0.1],
          },
        ])
        .setTransforms(
          [1, 2, 3, 4],
          new Float32Array([
            ...makeMat(-0.5, 0, 0.5),
            ...makeMat(0.5, 0, 0.5),
            ...makeMat(-0.5, 0.6, 0.5),
            ...makeMat(0.5, -0.6, 0.5),
          ]),
        )
        .setLights([
          {
            lightId: 1 as LightId,
            kind: 0,
            castShadow: false,
            position: [0, 0, 0],
            direction: [0, 0, -1],
            color: [1, 1, 1],
            intensity: 1,
          },
        ]);
      expect(kernel.commitSceneDelta(delta1).unwrap()).toBe(1);

      const viewUboBytes = new Uint8Array(80);
      new Float32Array(viewUboBytes.buffer, 0, 16).set(IDENTITY_VP);

      const rec1 = kernel.beginFrame(1, 64, 64).unwrap();
      // Reserve slot 0 so viewUbo lives at dynamic offset 256!
      rec1.writeUniform(new Uint8Array(16));
      const viewSlice1 = rec1.writeUniform(viewUboBytes);
      expect(viewSlice1.offset).toBe(256);
      const cull1 = kernel.cull({ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }).unwrap();
      expect(cull1.visibleOpaqueCount).toBe(4);
      const rt1 = rec1.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 64, 64, 1, 1, 1, 0x11);
      rec1.beginRenderPass({
        labelId: 1,
        colorAttachments: [{ texture: rt1, clearColor: [0, 0, 0, 1] }],
      });
      rec1.drawRenderers({
        cullId: cull1.cullId,
        passTag: PASS_TAG_FORWARD_OPAQUE,
        sortMode: SORT_MATERIAL_PSO,
        drawFlags: DRAW_FLAG_INSTANCING,
        queueMin: 0,
        queueMax: 2500,
        viewUniformOffset: viewSlice1.offset,
        viewUniformLength: viewSlice1.length,
        passAttachmentId: 1,
      });
      rec1.endRenderPass();
      const r1 = kernel.submitFrame(rec1).unwrap();
      expect(r1.submittedDrawCount).toBe(2);

      const px1 = kernel.readbackPoolTexture(1).unwrap().pixels;
      const left = (32 * 64 + 16) * 4;
      const center = (32 * 64 + 32) * 4;
      const right = (32 * 64 + 48) * 4;
      expect(Math.abs((px1[left] as number) - 204)).toBeLessThanOrEqual(2);
      expect(Math.abs((px1[left + 1] as number) - 51)).toBeLessThanOrEqual(2);
      expect(px1[center]).toBe(0);
      expect(Math.abs((px1[right + 2] as number) - 230)).toBeLessThanOrEqual(2);

      const s1 = kernel.getThreadStats().unwrap();
      expect(s1.dirtyRowsUploaded).toBe(4);
      expect(s1.dirtyRangeWrites).toBe(1);
      expect(s1.materialUploads).toBe(0);

      // Frame 2: incremental update of ONLY object 1 + matRed -> yellow
      const delta2 = kernel.beginSceneDelta();
      delta2
        .reset(1, 2, 1, 0)
        .setTransforms([1], new Float32Array(makeMat(0, 0, 0.5)))
        .updateMaterialParams(
          matRed,
          0,
          new Uint8Array(new Float32Array([0.9, 0.9, 0.1, 1]).buffer),
        );
      expect(kernel.commitSceneDelta(delta2).unwrap()).toBe(2);

      const rec2 = kernel.beginFrame(2, 64, 64).unwrap();
      const viewSlice2 = rec2.writeUniform(viewUboBytes);
      const cull2 = kernel.cull({ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }).unwrap();
      const rt2 = rec2.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 64, 64, 1, 1, 1, 0x11);
      rec2.beginRenderPass({
        labelId: 1,
        colorAttachments: [{ texture: rt2, clearColor: [0, 0, 0, 1] }],
      });
      rec2.drawRenderers({
        cullId: cull2.cullId,
        passTag: PASS_TAG_FORWARD_OPAQUE,
        sortMode: SORT_MATERIAL_PSO,
        drawFlags: DRAW_FLAG_INSTANCING,
        queueMin: 0,
        queueMax: 2500,
        viewUniformOffset: viewSlice2.offset,
        viewUniformLength: viewSlice2.length,
        passAttachmentId: 1,
      });
      rec2.endRenderPass();
      kernel.submitFrame(rec2).unwrap();

      const s2 = kernel.getThreadStats().unwrap();
      expect(s2.dirtyRowsUploaded - s1.dirtyRowsUploaded).toBe(1);
      expect(s2.dirtyRangeWrites - s1.dirtyRangeWrites).toBe(1);
      expect(s2.materialUploads - s1.materialUploads).toBe(1);

      const px2 = kernel.readbackPoolTexture(1).unwrap().pixels;
      expect(px2[left]).toBe(0);
      expect(Math.abs((px2[center] as number) - 230)).toBeLessThanOrEqual(2);
      expect(Math.abs((px2[center + 1] as number) - 230)).toBeLessThanOrEqual(2);
      expect(Math.abs((px2[center + 2] as number) - 26)).toBeLessThanOrEqual(2);
      expect(Math.abs((px2[right + 2] as number) - 230)).toBeLessThanOrEqual(2);

      // Frames 3..62: 1,000 4-BGL lit objects with 5% rotating partial transform edits per frame!
      const totalObjs = 1000;
      const bulkDelta = kernel.beginSceneDelta(256 * 1024);
      const bulkObjs = [];
      const bulkIds: number[] = [];
      const bulkMats = new Float32Array(totalObjs * 16);
      for (let i = 0; i < totalObjs; i++) {
        const oid = (i + 1) as RenderObjectId;
        bulkObjs.push({
          objectId: oid,
          meshId: mesh,
          materialId: i % 2 === 0 ? matRed : matBlue,
          queue: 1000,
          objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
          localBoundsMin: [-0.25, -0.25, -0.1] as const,
          localBoundsMax: [0.25, 0.25, 0.1] as const,
        });
        bulkIds.push(oid);
        bulkMats.set(
          makeMat(((i % 20) - 10) * 0.08, (Math.floor(i / 20) - 25) * 0.03, 0.5),
          i * 16,
        );
      }
      bulkDelta
        .reset(2, 1, 0, DELTA_FLAG_BASELINE)
        .upsertObjects(bulkObjs)
        .setTransforms(bulkIds, bulkMats)
        .setLights([
          {
            lightId: 1 as LightId,
            kind: 0,
            castShadow: false,
            position: [0, 0, 0],
            direction: [0, 0, -1],
            color: [1, 1, 1],
            intensity: 1,
          },
        ]);
      expect(kernel.commitSceneDelta(bulkDelta).unwrap()).toBe(1);

      const rotatingCount = 50;
      const editIds = new Uint32Array(rotatingCount);
      const editMats = new Float32Array(rotatingCount * 16);
      const partialDelta = kernel.beginSceneDelta(16 * 1024);

      for (let f = 0; f < 60; f++) {
        const startRow = (f * rotatingCount) % totalObjs;
        for (let k = 0; k < rotatingCount; k++) {
          const row = (startRow + k) % totalObjs;
          editIds[k] = row + 1;
          editMats.set(
            makeMat(Math.sin(f * 0.1 + k) * 0.5, Math.cos(f * 0.1 + k) * 0.5, 0.5),
            k * 16,
          );
        }
        partialDelta.reset(2, f + 2, f + 1, 0).setTransforms(editIds, editMats, rotatingCount);

        const rec = kernel.preparePipelinedRecorder(f + 3, 64, 64);
        const viewSlice = rec.writeUniform(viewUboBytes);
        const rt = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 64, 64, 1, 1, 1, 0x11);
        rec.beginRenderPass({
          labelId: 2,
          colorAttachments: [{ texture: rt, clearColor: [0, 0, 0, 1] }],
        });
        rec.drawRenderers({
          cullId: 1 as CullId,
          passTag: PASS_TAG_FORWARD_OPAQUE,
          sortMode: SORT_MATERIAL_PSO,
          drawFlags: DRAW_FLAG_INSTANCING,
          queueMin: 0,
          queueMax: 2500,
          viewUniformOffset: viewSlice.offset,
          viewUniformLength: viewSlice.length,
          passAttachmentId: 1,
        });
        rec.endRenderPass();
        kernel
          .submitPipelinedFrameAsync(rec, {
            delta: partialDelta,
            culls: [{ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }],
          })
          .unwrap();
      }
      kernel.flush().unwrap();

      const s3 = kernel.getThreadStats().unwrap();
      expect(s3.completedFrames).toBe(62);
      expect(s3.inFlightFrames).toBe(0);
      // Frame 3 full upload (1000 rows) + 59 frames * 50 rotating dirty rows = 3950 rows (or 1000 + 60*50 if frame 3 delta merged before sync -> 1000 + 59*50 = 3950)!
      expect(s3.dirtyRowsUploaded - s2.dirtyRowsUploaded).toBe(totalObjs + 59 * rotatingCount);
      // Each contiguous 50-row slice coalesces into 1 write_buffer call (1 baseline + 59 single-range writes = 60)!
      expect(s3.dirtyRangeWrites - s2.dirtyRangeWrites).toBe(60);
    } finally {
      kernel.dispose();
    }
  });

  it('executes depth-only shadow pass + textured 4-BGL lit pass with real shadow occlusion', () => {
    if (!isNativeRenderKernelAvailable()) return;

    const WGSL_SHADOW = `
struct ViewUniform { view_proj: mat4x4<f32>, light_vp: mat4x4<f32>, };
struct SceneObjectGpu { world: mat4x4<f32>, params0: vec4<f32>, params1: vec4<f32>, };
@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;
@vertex fn vs_shadow(@location(0) pos: vec3<f32>, @builtin(instance_index) inst: u32) -> @builtin(position) vec4<f32> {
  return u_view.light_vp * (s_objects[s_instance_rows[inst]].world * vec4<f32>(pos, 1.0));
}
`;
    const WGSL_TEX_SHADOW = `
struct ViewUniform { view_proj: mat4x4<f32>, light_vp: mat4x4<f32>, };
struct MaterialUniform { albedo: vec4<f32>, };
struct SceneObjectGpu { world: mat4x4<f32>, params0: vec4<f32>, params1: vec4<f32>, };
struct SceneLightGpu { position_range: vec4<f32>, direction_intensity: vec4<f32>, color_outer_cos: vec4<f32>, flags_meta: vec4<u32>, };
@group(0) @binding(0) var<uniform> u_view: ViewUniform;
@group(1) @binding(0) var<uniform> u_mat: MaterialUniform;
@group(1) @binding(1) var t_albedo: texture_2d<f32>;
@group(1) @binding(2) var s_albedo: sampler;
@group(2) @binding(0) var<storage, read> s_objects: array<SceneObjectGpu>;
@group(2) @binding(1) var<storage, read> s_lights: array<SceneLightGpu>;
@group(2) @binding(2) var t_shadow: texture_depth_2d;
@group(2) @binding(3) var s_shadow: sampler_comparison;
@group(3) @binding(0) var<storage, read> s_instance_rows: array<u32>;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) wp: vec3<f32>, @location(1) uv: vec2<f32>, };
@vertex fn vs_main(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>, @builtin(instance_index) inst: u32) -> VsOut {
  let wp = s_objects[s_instance_rows[inst]].world * vec4<f32>(pos, 1.0);
  var o: VsOut;
  o.pos = u_view.view_proj * wp;
  o.wp = wp.xyz;
  o.uv = uv;
  return o;
}
@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let sc = u_view.light_vp * vec4<f32>(in.wp, 1.0);
  let suv = vec2<f32>(sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5);
  let lit = textureSampleCompare(t_shadow, s_shadow, suv, sc.z - 0.01);
  let tex = textureSample(t_albedo, s_albedo, in.uv).rgb;
  return vec4<f32>(tex * u_mat.albedo.rgb * (0.2 + 0.8 * lit), 1.0);
}
`;

    const kernel = createNativeRenderKernel({ maxInFlight: 2 }).unwrap();
    try {
      // Quad in XY plane (pos vec3 + uv vec2 = 20 bytes)
      const verts = new Float32Array([
        -1, -1, 0, 0, 0, 1, -1, 0, 1, 0, 1, 1, 0, 1, 1, -1, 1, 0, 0, 1,
      ]);
      const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
      const quad = kernel.assets
        .createMesh(
          { vertexLayoutId: 4, vertexCount: 4, indexCount: 6, isUint32Index: false },
          new Uint8Array(verts.buffer),
          new Uint8Array(idx.buffer),
        )
        .unwrap();

      // Solid cyan 2x2 texture proving Group 1 texture binding works
      const cyanTex = kernel.assets
        .createTexture(
          { width: 2, height: 2, format: TEXTURE_FORMAT_RGBA8_UNORM, usage: 0x04 | 0x02 },
          new Uint8Array([0, 200, 255, 255, 0, 200, 255, 255, 0, 200, 255, 255, 0, 200, 255, 255]),
        )
        .unwrap();
      const sampler = kernel.assets
        .createSampler({ magFilter: 'nearest', minFilter: 'nearest' })
        .unwrap();

      const shadowShader = kernel.assets
        .registerShaderProgram({
          code: WGSL_SHADOW,
          vertexEntryPoint: 'vs_shadow',
          layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
          vertexBufferLayouts: [
            {
              arrayStride: 20,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
          colorFormats: [],
          depthFormat: 'depth32float',
        })
        .unwrap();
      const litShader = kernel.assets
        .registerShaderProgram({
          code: WGSL_TEX_SHADOW,
          vertexEntryPoint: 'vs_main',
          fragmentEntryPoint: 'fs_main',
          layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
          vertexBufferLayouts: [
            {
              arrayStride: 20,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x2' },
              ],
            },
          ],
          colorFormats: ['rgba8unorm'],
          depthFormat: 'depth32float',
        })
        .unwrap();

      const mat = kernel.assets
        .createMaterial(
          {
            shaderProgramId: litShader,
            layoutFamilyId: LAYOUT_FAMILY_SCENE_4BGL,
            renderStateBits: RENDER_STATE_DEPTH_WRITE | RENDER_STATE_DEPTH_LESS_EQUAL,
            queue: 1000,
            baseColorTextureId: cyanTex,
            samplerId: sampler,
          },
          new Uint8Array(new Float32Array([1, 1, 1, 1]).buffer),
        )
        .unwrap();

      // Receiver quad covers entire NDC at z=0.8; small blocker quad on LEFT half at z=0.2 casts shadow!
      const receiverMat = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.8, 1]);
      const blockerMat = new Float32Array([
        0.4, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 1, 0, -0.5, 0, 0.2, 1,
      ]);
      const delta = kernel.beginSceneDelta();
      delta
        .reset(1, 1, 0, DELTA_FLAG_BASELINE)
        .upsertObjects([
          {
            objectId: 1 as RenderObjectId,
            meshId: quad,
            materialId: mat,
            queue: 1000,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-1, -1, -0.1],
            localBoundsMax: [1, 1, 0.1],
          },
          {
            objectId: 2 as RenderObjectId,
            meshId: quad,
            materialId: mat,
            queue: 1000,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-1, -1, -0.1],
            localBoundsMax: [1, 1, 0.1],
          },
        ])
        .setTransforms([1, 2], new Float32Array([...receiverMat, ...blockerMat]));
      kernel.commitSceneDelta(delta).unwrap();

      // Light view = identity (orthographic from z=0 looking down +z).
      // Camera view = identity too, EXCEPT we only render receiver in main pass (layerMask/queue) OR shift blocker:
      // Even simpler: put blocker at z=0.2 only in shadow pass by giving blocker queue=500 and main pass queueMin=900!
      const deltaQ = kernel.beginSceneDelta();
      deltaQ.reset(1, 2, 1, 0).upsertObjects([
        {
          objectId: 2 as RenderObjectId,
          meshId: quad,
          materialId: mat,
          queue: 500,
          objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED,
          localBoundsMin: [-1, -1, -0.1],
          localBoundsMax: [1, 1, 0.1],
        },
      ]);
      kernel.commitSceneDelta(deltaQ).unwrap();

      const viewUbo = new Float32Array(32);
      viewUbo.set(IDENTITY_VP, 0);
      viewUbo.set(IDENTITY_VP, 16);

      const rec = kernel.beginFrame(1, 64, 64).unwrap();
      const vSlice = rec.writeUniform(new Uint8Array(viewUbo.buffer));
      const cull = kernel.cull({ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }).unwrap();

      const shadowMap = rec.acquireTempTexture(TEXTURE_FORMAT_DEPTH32_FLOAT, 64, 64, 1, 1, 1, 0x14);
      const colorRt = rec.acquireTempTexture(TEXTURE_FORMAT_RGBA8_UNORM, 64, 64, 1, 1, 1, 0x11);
      const mainDepth = rec.acquireTempTexture(TEXTURE_FORMAT_DEPTH32_FLOAT, 64, 64, 1, 1, 1, 0x10);

      // Pass 1: depth-only shadow pass (renders blocker at z=0.2 + receiver at z=0.8)
      rec.beginRenderPass({
        labelId: 1,
        colorAttachments: [],
        depthAttachment: {
          texture: shadowMap,
          loadOp: 'clear',
          storeOp: 'store',
          clearDepth: 1.0,
        },
      });
      rec.drawRenderers({
        cullId: cull.cullId,
        passTag: PASS_TAG_SHADOW_DEPTH,
        sortMode: SORT_MATERIAL_PSO,
        drawFlags: DRAW_FLAG_INSTANCING,
        queueMin: 0,
        queueMax: 2500,
        viewUniformOffset: vSlice.offset,
        viewUniformLength: vSlice.length,
        overrideShader: shadowShader,
        passAttachmentId: 1,
      });
      rec.endRenderPass();

      // Pass 2: textured + shadow-mapped receiver (queue >= 900 so blocker casts shadow onto receiver!)
      const shadowBind = rec.beginBindingSet().bindTexture(0, shadowMap).finish();
      rec.beginRenderPass({
        labelId: 2,
        colorAttachments: [{ texture: colorRt, clearColor: [0, 0, 0, 1] }],
        depthAttachment: {
          texture: mainDepth,
          loadOp: 'clear',
          storeOp: 'discard',
          clearDepth: 1.0,
        },
      });
      rec.drawRenderers({
        cullId: cull.cullId,
        passTag: PASS_TAG_FORWARD_OPAQUE,
        sortMode: SORT_MATERIAL_PSO,
        drawFlags: DRAW_FLAG_INSTANCING,
        queueMin: 900,
        queueMax: 2500,
        viewUniformOffset: vSlice.offset,
        viewUniformLength: vSlice.length,
        extraBindings: shadowBind,
        passAttachmentId: 2,
      });
      rec.endRenderPass();

      expect(kernel.submitFrame(rec).unwrap().executedPasses).toBe(2);
      const px = kernel.readbackPoolTexture(2).unwrap().pixels;
      // Left center (x=16, y=32) is shadowed by blocker -> ~20% cyan (~0, 40, 51)
      const shadowed = (32 * 64 + 16) * 4;
      // Right center (x=48, y=32) is unshadowed -> 100% cyan (~0, 200, 255)
      const lit = (32 * 64 + 48) * 4;
      expect(px[shadowed]).toBeLessThanOrEqual(5);
      expect(px[shadowed + 2]).toBeLessThan(90);
      expect(px[lit]).toBeLessThanOrEqual(5);
      expect(px[lit + 1]).toBeGreaterThan(180);
      expect(px[lit + 2]).toBeGreaterThan(230);
    } finally {
      kernel.dispose();
    }
  });
});
