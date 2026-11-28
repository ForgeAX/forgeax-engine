import {
  compileKernelRenderPipeline,
  createRenderKernel,
  DELTA_FLAG_BASELINE,
  DRAW_FLAG_INSTANCING,
  type KernelRenderFeature,
  type KernelRenderPipeline,
  type KernelStandardPipelineFrame,
  KernelStandardSceneRenderer,
  kernelMat4LookAt,
  kernelMat4Multiply,
  kernelMat4Perspective,
  type MeshId,
  OBJ_FLAG_FRUSTUM_CULLED,
  OBJ_FLAG_VISIBLE,
  PASS_TAG_FORWARD_OPAQUE,
  packKernelMeshVertices,
  type RenderObjectId,
  type SamplerId,
  type ShaderProgramId,
  SORT_MATERIAL_PSO,
  SURFACE_SWAPCHAIN_HANDLE,
  TEXTURE_FORMAT_RGBA8_UNORM,
  type WasmWgpuKernelModule,
  WasmWgpuRenderKernel,
} from '@forgeax/engine-render-kernel';
import {
  createShaderModule,
  disposeDevice,
  ensureReady,
  requestAdapter,
  rhi,
} from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';

const TRI_WGSL = `
@vertex
fn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.8, 0.4, 1.0);
}
`;

const POST_SWIZZLE_WGSL = `
@group(0) @binding(0) var t_in: texture_2d<f32>;
@group(0) @binding(1) var s_in: sampler;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VsOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  out.uv = p[vid] * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(t_in, s_in, in.uv);
  return vec4<f32>(c.b, c.g, c.r, 1.0);
}
`;

const IDENTITY_VP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  document.body.append(canvas);
  return canvas;
}

function readCanvasCenterPixel(canvas: HTMLCanvasElement): [number, number, number, number] {
  const gl = canvas.getContext('webgl2');
  if (gl === null) throw new Error('WebGL2 context unavailable');
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  const px = new Uint8Array(4);
  gl.readPixels(
    Math.floor(canvas.width / 2),
    Math.floor(canvas.height / 2),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    px,
  );
  return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, px[3] ?? 0];
}

it('renders identical pixels on WebGL2 via WasmWgpuRenderKernel and beats JS rhi-wgpu CPU time', async () => {
  const wgpuWasmMod = (await ensureReady()) as unknown as WasmWgpuKernelModule;
  const w = 64;
  const h = 64;
  const FRAMES = 60;
  const DRAWS = 25;
  // Both paths stay alive until the end so their timings can interleave.
  const cleanups: Array<() => void> = [];
  let runClosed: ((frameId: number) => unknown) | undefined;
  let runDirect: (() => void) | undefined;
  try {
    // -------------------------------------------------------------------------
    // 1. In-WASM closure (single crossing per frame)
    // -------------------------------------------------------------------------
    let pxA: [number, number, number, number];
    let closedMs = 0;
    {
      const canvasA = createCanvas(w, h);
      const adapterA = (await requestAdapter(undefined, canvasA)).unwrap();
      const deviceA = (await adapterA.requestDevice()).unwrap();
      const ctxA = rhi.acquireCanvasContext(canvasA).unwrap();
      ctxA
        .configure({ device: deviceA, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' })
        .unwrap();

      const kernelClosed = (
        await createRenderKernel({
          device: deviceA,
          wgpuWasmModule: wgpuWasmMod,
          captureResolved: true,
        })
      ).unwrap();
      expect(kernelClosed).toBeInstanceOf(WasmWgpuRenderKernel);
      expect(kernelClosed.backendKind).toBe('rust-wgpu-wasm');

      try {
        const verts = new Float32Array([-1, -1, 0.5, 3, -1, 0.5, -1, 3, 0.5]);
        const indices = new Uint16Array([0, 1, 2]);
        const mesh = kernelClosed.assets
          .createMesh(
            {
              vertexLayoutId: 1,
              vertexCount: 3,
              indexCount: 3,
              isUint32Index: false,
              topology: 0,
              label: 'tri',
            },
            new Uint8Array(verts.buffer),
            new Uint8Array(indices.buffer),
          )
          .unwrap();

        const triShader = kernelClosed.assets
          .registerShaderProgram({
            code: TRI_WGSL,
            vertexEntryPoint: 'vs_main',
            fragmentEntryPoint: 'fs_main',
            layoutFamilyId: 1,
            vertexBufferLayouts: [
              {
                arrayStride: 12,
                stepMode: 'vertex',
                attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
              },
            ],
            colorFormats: ['rgba8unorm'],
            sampleCount: 1,
            label: 'tri-closed',
          })
          .unwrap();

        const postShader = kernelClosed.assets
          .registerShaderProgram({
            code: POST_SWIZZLE_WGSL,
            vertexEntryPoint: 'vs_main',
            fragmentEntryPoint: 'fs_main',
            layoutFamilyId: 0,
            colorFormats: ['rgba8unorm'],
            sampleCount: 1,
            label: 'post-closed',
          })
          .unwrap();

        const sampler = kernelClosed.assets
          .createSampler({ magFilter: 'nearest', minFilter: 'nearest' })
          .unwrap();

        const mat = kernelClosed.assets
          .createMaterial(
            {
              shaderProgramId: triShader,
              layoutFamilyId: 1,
              renderStateBits: 0,
              queue: 1000,
            },
            new Uint8Array(16),
          )
          .unwrap();

        const delta = kernelClosed.beginSceneDelta();
        const objs = [];
        const ids: number[] = [];
        const transforms = new Float32Array(DRAWS * 16);
        for (let i = 0; i < DRAWS; i++) {
          const oid = i + 1;
          ids.push(oid);
          objs.push({
            objectId: oid as RenderObjectId,
            meshId: mesh,
            materialId: mat,
            queue: 1000,
            objFlags: OBJ_FLAG_VISIBLE | OBJ_FLAG_FRUSTUM_CULLED,
            localBoundsMin: [-1, -1, -1] as [number, number, number],
            localBoundsMax: [1, 1, 1] as [number, number, number],
          });
          transforms.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1], i * 16);
        }
        delta
          .reset(1, 1, 0, DELTA_FLAG_BASELINE)
          .upsertObjects(objs)
          .setTransforms(ids, transforms);
        kernelClosed.commitSceneDelta(delta).unwrap();

        const runClosedTwoPass = (frameId: number) => {
          const tex = ctxA.getCurrentTexture().unwrap();
          const view = deviceA.createTextureView(tex, {}).unwrap();
          kernelClosed.assets.registerExternalSurface(tex, view, w, h);

          const rec = kernelClosed.beginFrame(frameId, w, h).unwrap();
          const cull = kernelClosed.cull({ viewProj: IDENTITY_VP, cameraPos: [0, 0, 0] }).unwrap();
          const sceneColor = rec.acquireTempTexture(
            TEXTURE_FORMAT_RGBA8_UNORM,
            w,
            h,
            1,
            1,
            1,
            0x15,
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
            colorAttachments: [{ texture: SURFACE_SWAPCHAIN_HANDLE, clearColor: [0, 0, 0, 1] }],
          });
          rec.drawFullscreen(postShader, postBindings);
          rec.endRenderPass();

          return kernelClosed.submitFrame(rec).unwrap();
        };

        const receiptA = runClosedTwoPass(1);
        expect(receiptA.submittedPassCount).toBe(2);
        expect(receiptA.resolvedPhysicalCommands.length).toBeGreaterThan(0);

        (kernelClosed as WasmWgpuRenderKernel).setCaptureResolved(false);
        const receiptA2 = runClosedTwoPass(2);
        expect(receiptA2.resolvedPhysicalCommands.length).toBe(0);

        await Promise.resolve();
        pxA = readCanvasCenterPixel(canvasA);
        // Swizzled (0.4, 0.8, 0.2, 1.0) => [102, 204, 51, 255]
        expect(pxA).toEqual([102, 204, 51, 255]);

        runClosed = runClosedTwoPass;
      } finally {
        cleanups.push(() => {
          kernelClosed.dispose();
          ctxA.unconfigure();
          disposeDevice(deviceA);
          canvasA.remove();
        });
      }
    }

    // -------------------------------------------------------------------------
    // 2. Reference JS rhi-wgpu 2-pass (multi-crossing JS <-> wgpu-wasm)
    // -------------------------------------------------------------------------
    let pxB: [number, number, number, number];
    let directMs = 0;
    {
      const canvasB = createCanvas(w, h);
      const adapterB = (await requestAdapter(undefined, canvasB)).unwrap();
      const deviceB = (await adapterB.requestDevice()).unwrap();
      const ctxB = rhi.acquireCanvasContext(canvasB).unwrap();
      ctxB
        .configure({ device: deviceB, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' })
        .unwrap();

      try {
        const verts = new Float32Array([-1, -1, 0.5, 3, -1, 0.5, -1, 3, 0.5]);
        const vbB = deviceB.createBuffer({ size: verts.byteLength, usage: 0x20 | 0x08 }).unwrap();
        deviceB.queue.writeBuffer(vbB, 0, verts);
        const ibB = deviceB.createBuffer({ size: 8, usage: 0x10 | 0x08 }).unwrap();
        deviceB.queue.writeBuffer(ibB, 0, new Uint16Array([0, 1, 2, 0]));
        const modTriB = (await createShaderModule(deviceB, { code: TRI_WGSL })).unwrap();
        const psoTriB = deviceB
          .createRenderPipeline({
            layout: deviceB.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
            primitive: { topology: 'triangle-list' },
            vertex: {
              module: modTriB,
              entryPoint: 'vs_main',
              buffers: [
                {
                  arrayStride: 12,
                  stepMode: 'vertex',
                  attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
                },
              ],
            },
            fragment: {
              module: modTriB,
              entryPoint: 'fs_main',
              targets: [{ format: 'rgba8unorm' }],
            },
          })
          .unwrap();

        const bglPostB = deviceB
          .createBindGroupLayout({
            entries: [
              { binding: 0, visibility: 2, texture: { sampleType: 'float' } },
              { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
            ],
          })
          .unwrap();
        const modPostB = (await createShaderModule(deviceB, { code: POST_SWIZZLE_WGSL })).unwrap();
        const psoPostB = deviceB
          .createRenderPipeline({
            layout: deviceB.createPipelineLayout({ bindGroupLayouts: [bglPostB] }).unwrap(),
            primitive: { topology: 'triangle-list' },
            vertex: { module: modPostB, entryPoint: 'vs_main', buffers: [] },
            fragment: {
              module: modPostB,
              entryPoint: 'fs_main',
              targets: [{ format: 'rgba8unorm' }],
            },
          })
          .unwrap();

        const rtB = deviceB
          .createTexture({ size: [w, h], format: 'rgba8unorm', usage: 0x10 | 0x04 })
          .unwrap();
        const rtViewB = deviceB.createTextureView(rtB, {}).unwrap();
        const sampB = deviceB
          .createSampler({ magFilter: 'nearest', minFilter: 'nearest' })
          .unwrap();
        const bgPostB = deviceB
          .createBindGroup({
            layout: bglPostB,
            entries: [
              { binding: 0, resource: { kind: 'textureView', value: rtViewB } },
              { binding: 1, resource: { kind: 'sampler', value: sampB } },
            ],
          })
          .unwrap();

        const runDirectRhiTwoPass = () => {
          const tex = ctxB.getCurrentTexture().unwrap();
          const view = deviceB.createTextureView(tex, {}).unwrap();
          const enc = deviceB.createCommandEncoder().unwrap();

          const p1 = enc.beginRenderPass({
            colorAttachments: [
              {
                view: rtViewB,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              },
            ],
          });
          p1.setPipeline(psoTriB);
          p1.setVertexBuffer(0, vbB);
          p1.setIndexBuffer(ibB, 'uint16');
          for (let d = 0; d < DRAWS; d++) {
            p1.drawIndexed(3);
          }
          p1.end();

          const p2 = enc.beginRenderPass({
            colorAttachments: [
              { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
            ],
          });
          p2.setPipeline(psoPostB);
          p2.setBindGroup(0, bgPostB);
          p2.draw(3);
          p2.end();

          deviceB.queue.submit([enc.finish().unwrap()]).unwrap();
        };

        runDirectRhiTwoPass();
        await Promise.resolve();
        pxB = readCanvasCenterPixel(canvasB);

        runDirect = runDirectRhiTwoPass;
      } finally {
        cleanups.push(() => {
          ctxB.unconfigure();
          disposeDevice(deviceB);
          canvasB.remove();
        });
      }
    }

    // Warm both paths, then time alternating batches of FRAMES frames so neither path pays the
    // first-measured cost; compare the median batch of each.
    const closed = runClosed as (frameId: number) => unknown;
    const direct = runDirect as () => void;
    const ROUNDS = 9;
    const BATCH = FRAMES;
    let frameId = 10;
    for (let i = 0; i < BATCH; i++) {
      closed(frameId++);
      direct();
    }
    const closedSamples: number[] = [];
    const directSamples: number[] = [];
    const timeClosed = () => {
      const start = performance.now();
      for (let i = 0; i < BATCH; i++) closed(frameId++);
      closedSamples.push(performance.now() - start);
    };
    const timeDirect = () => {
      const start = performance.now();
      for (let i = 0; i < BATCH; i++) direct();
      directSamples.push(performance.now() - start);
    };
    for (let round = 0; round < ROUNDS; round++) {
      if (round % 2 === 0) {
        timeClosed();
        timeDirect();
      } else {
        timeDirect();
        timeClosed();
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;
    closedMs = median(closedSamples);
    directMs = median(directSamples);

    expect(pxA).toEqual(pxB);
    expect(closedMs).toBeLessThan(directMs);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
});

it('executes declarative KernelRenderGraph (2-MRT + MipGen + Custom KernelRenderFeature + bindUniformSlice) in single WebGL2 WASM closure', async () => {
  const wgpuWasmMod = (await ensureReady()) as unknown as WasmWgpuKernelModule;
  const w = 64;
  const h = 64;
  const canvas = createCanvas(w, h);
  const adapter = (await requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const ctx = rhi.acquireCanvasContext(canvas).unwrap();
  ctx.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' }).unwrap();

  const kernel = (
    await createRenderKernel({
      device,
      wgpuWasmModule: wgpuWasmMod,
    })
  ).unwrap();
  expect(kernel.backendKind).toBe('rust-wgpu-wasm');

  const MRT_WGSL = /* wgsl */ `
struct SceneUniform {
  albedo: vec4<f32>,
  aux_data: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_scene: SceneUniform;
struct MrtOut {
  @location(0) color: vec4<f32>,
  @location(1) aux_rg: vec4<f32>,
};
@vertex
fn vs_main(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, 0.0, 1.0);
}
@fragment
fn fs_main() -> MrtOut {
  var o: MrtOut;
  o.color = u_scene.albedo;
  o.aux_rg = u_scene.aux_data;
  return o;
}
`;

  const FEATURE_WGSL = /* wgsl */ `
struct FeatUniform {
  tint: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_feat: FeatUniform;
@group(0) @binding(1) var color_mip1: texture_2d<f32>;
@group(0) @binding(2) var meta_tex: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
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
  let c = textureSample(color_mip1, smp, in.uv);
  let m = textureSample(meta_tex, smp, in.uv);
  return vec4<f32>(
    clamp(c.r * u_feat.tint.r + m.r * 0.2, 0.0, 1.0),
    clamp(c.g * u_feat.tint.g + m.g * 0.2, 0.0, 1.0),
    clamp(c.b * u_feat.tint.b, 0.0, 1.0),
    1.0,
  );
}
`;

  interface WebGlGraphFrame {
    readonly quadMesh: MeshId;
    readonly mrtShader: ShaderProgramId;
    readonly featureShader: ShaderProgramId;
    readonly sampler: SamplerId;
    readonly tint: readonly [number, number, number];
  }

  const feature: KernelRenderFeature<WebGlGraphFrame> = {
    name: 'webgl-custom-mip-feature',
    stage: 'before-present',
    install(builder, targets) {
      const meta = targets.extras?.meta;
      if (!meta) throw new Error('missing meta target');
      const mip1 = builder.view(targets.sceneColor, { baseMipLevel: 1, mipLevelCount: 1 });
      let bgId = 0;
      return builder.addRasterPass('feature-composite', {
        reads: [mip1, meta],
        colorAttachments: [
          {
            target: targets.outputTarget,
            loadOp: 'clear',
            storeOp: 'store',
            clearColor: [0, 0, 0, 1],
          },
        ],
        prepare(frame, res) {
          const u = res.writeUniform(
            new Float32Array([frame.tint[0], frame.tint[1], frame.tint[2], 1]),
          );
          const bs = res.beginBindingSet();
          bs.bindUniformSlice(0, u.offset, u.length);
          res.bindTexture(bs, 1, mip1);
          res.bindTexture(bs, 2, meta);
          bs.bindSampler(3, frame.sampler);
          bgId = bs.finish();
        },
        encode(pass, frame) {
          pass.drawFullscreen(frame.featureShader, bgId as never);
        },
      });
    },
  };

  const pipeline: KernelRenderPipeline<WebGlGraphFrame> = {
    name: 'webgl-mrt-mip-pipeline',
    build(builder, features) {
      const color = builder
        .createTexture('color', { format: 'rgba8unorm', mipLevelCount: 3 })
        .unwrap();
      const meta = builder.createTexture('meta', { format: 'rgba8unorm' }).unwrap();
      const surface = builder.importSurface('swapchain', { format: 'rgba8unorm' }).unwrap();
      let mrtBg = 0;
      builder
        .addRasterPass('mrt-scene', {
          colorAttachments: [
            { target: color, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
            { target: meta, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
          ],
          prepare(_frame, res) {
            const u = res.writeUniform(new Float32Array([0.6, 0.8, 0.4, 1, 0.5, 0.25, 0, 1]));
            mrtBg = res.beginBindingSet().bindUniformSlice(0, u.offset, u.length).finish();
          },
          encode(pass, frame) {
            pass.setShaderPipeline(frame.mrtShader, 0, 1, 1);
            pass.setBindGroup(0, mrtBg as never);
            pass.setVertexBuffer(0, frame.quadMesh);
            pass.draw(6, 1, 0, 0);
          },
        })
        .unwrap();
      builder.addMipGenPass('color-mipgen', color).unwrap();
      return builder.installFeatures('before-present', features, {
        sceneColor: color,
        outputTarget: surface,
        extras: { meta },
      });
    },
  };

  try {
    const quadVerts = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
    const quadMesh = kernel.assets
      .createMesh(
        { vertexLayoutId: 1, vertexCount: 6, indexCount: 0 },
        new Uint8Array(quadVerts.buffer),
      )
      .unwrap();
    const sampler = kernel.assets
      .createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
      .unwrap();
    const mrtShader = kernel.assets
      .registerShaderProgram({
        code: MRT_WGSL,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: 'fs_main',
        layoutFamilyId: 0,
        vertexBufferLayouts: [
          { arrayStride: 8, attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }] },
        ],
        colorTargets: [
          { format: 'rgba8unorm', blendMode: 'none' },
          { format: 'rgba8unorm', blendMode: 'none' },
        ],
        label: 'webgl-mrt',
      })
      .unwrap();
    const featureShader = kernel.assets
      .registerShaderProgram({
        code: FEATURE_WGSL,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: 'fs_main',
        layoutFamilyId: 0,
        colorFormats: ['rgba8unorm'],
        label: 'webgl-feature',
      })
      .unwrap();

    const compiled = compileKernelRenderPipeline(pipeline, [feature], {
      surfaceSize: { width: w, height: h },
    }).unwrap();

    const tex = ctx.getCurrentTexture().unwrap();
    const view = device.createTextureView(tex, {}).unwrap();
    kernel.assets.registerExternalSurface(tex, view, w, h);

    const receipt = compiled
      .execute(kernel, {
        quadMesh,
        mrtShader,
        featureShader,
        sampler,
        tint: [1.0, 0.5, 0.75],
      })
      .unwrap();
    expect(receipt.status).toBe('ready');
    await Promise.resolve();

    const px = readCanvasCenterPixel(canvas);
    // R = 0.6*1.0 + 0.5*0.2 = 0.70 (~178), G = 0.8*0.5 + 0.25*0.2 = 0.45 (~115), B = 0.4*0.75 = 0.30 (~76)
    expect(px[0]).toBeGreaterThan(165);
    expect(px[0]).toBeLessThan(192);
    expect(px[1]).toBeGreaterThan(102);
    expect(px[1]).toBeLessThan(128);
    expect(px[2]).toBeGreaterThan(64);
    expect(px[2]).toBeLessThan(90);
    expect(px[3]).toBe(255);
  } finally {
    kernel.dispose();
    ctx.unconfigure();
    disposeDevice(device);
    canvas.remove();
  }
});

it('executes full KernelStandardSceneRenderer (Skybox + 3D PBR + Bloom + Tonemap + FXAA + custom post KernelRenderFeature) in single Browser WebGL2 WASM closure', async () => {
  const wgpuWasmMod = (await ensureReady()) as unknown as WasmWgpuKernelModule;
  const w = 96;
  const h = 96;
  const canvas = createCanvas(w, h);
  const adapter = (await requestAdapter(undefined, canvas)).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const ctx = rhi.acquireCanvasContext(canvas).unwrap();
  ctx.configure({ device, format: 'rgba8unorm', usage: 0x10, alphaMode: 'opaque' }).unwrap();

  const kernel = (
    await createRenderKernel({
      device,
      wgpuWasmModule: wgpuWasmMod,
    })
  ).unwrap();
  expect(kernel.backendKind).toBe('rust-wgpu-wasm');
  const renderer = KernelStandardSceneRenderer.create(kernel, {
    headless: false,
    outputFormat: 'rgba8unorm',
  }).unwrap();

  const WEBGL_GRADE_WGSL = /* wgsl */ `
struct Grade { mul: vec4<f32> };
@group(0) @binding(0) var t_in: texture_2d<f32>;
@group(0) @binding(1) var s_in: sampler;
@group(0) @binding(2) var<uniform> u_g: Grade;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut; o.pos = vec4<f32>(p[idx], 0.0, 1.0); o.uv = uv[idx]; return o;
}
@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(t_in, s_in, in.uv);
  return vec4<f32>(clamp(c.rgb * u_g.mul.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

  try {
    const quadVerts = packKernelMeshVertices(
      [-1.3, -1.3, 0, 1.3, -1.3, 0, 1.3, 1.3, 0, -1.3, 1.3, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 0, 1, 0, 1, 1, 0, 1],
    );
    const quadIdx = new Uint16Array([0, 1, 2, 0, 2, 3]);
    renderer.ensureMesh({ key: 'quad', vertices: quadVerts, indices: quadIdx }).unwrap();
    renderer
      .ensureMaterial({
        key: 'white',
        baseColor: [0.95, 0.95, 0.95, 1.0],
        roughness: 0.4,
      })
      .unwrap();

    const gradeShader = kernel.assets
      .registerShaderProgram({
        code: WEBGL_GRADE_WGSL,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: 'fs_main',
        layoutFamilyId: 0,
        colorFormats: ['rgba8unorm'],
        label: 'webgl.post-grade',
      })
      .unwrap();

    const gradeFeature: KernelRenderFeature<KernelStandardPipelineFrame> = {
      name: 'webgl-post-grade',
      stage: 'post',
      install(builder, targets) {
        const src = targets.currentColor ?? targets.sceneColor;
        const dst = builder.createTexture('webgl-grade-out', { format: 'rgba8unorm' });
        if (!dst.ok) return dst;
        let bg = 0;
        const res = builder.addRasterPass('webgl-grade-pass', {
          reads: [src],
          colorAttachments: [{ target: dst.value, loadOp: 'clear', storeOp: 'store' }],
          prepare(frame, r) {
            const u = r.writeUniform(new Float32Array([1.0, 0.35, 0.25, 1.0]));
            const b = r.beginBindingSet();
            r.bindTexture(b, 0, src);
            b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
            bg = b.finish();
          },
          encode(pass) {
            pass.drawFullscreen(gradeShader, bg as never);
          },
        });
        if (!res.ok) return res;
        targets.setCurrentColor?.(dst.value);
        return res;
      },
    };
    renderer.registerFeature(gradeFeature).unwrap();

    const proj = kernelMat4Perspective((50 * Math.PI) / 180, w / h, 0.1, 100, new Float32Array(16));
    const view = kernelMat4LookAt([0, 0, 3.8], [0, 0, 0], [0, 1, 0], new Float32Array(16));
    const viewProj = kernelMat4Multiply(proj, view, new Float32Array(16));

    const tex = ctx.getCurrentTexture().unwrap();
    const viewTex = device.createTextureView(tex, {}).unwrap();
    kernel.assets.registerExternalSurface(tex, viewTex, w, h);

    const receipt = renderer
      .renderFrame({
        width: w,
        height: h,
        camera: {
          viewProj,
          position: [0, 0, 3.8],
          clearColor: [0.02, 0.03, 0.05, 1],
          exposure: 1.2,
          tonemap: 'aces',
          bloom: { enabled: true, threshold: 0.7, intensity: 0.35 },
          fxaa: true,
        },
        skybox: { zenithColor: [0.1, 0.2, 0.45], horizonColor: [0.3, 0.4, 0.6], intensity: 1.0 },
        skylight: { skyColor: [0.35, 0.35, 0.4], intensity: 0.4 },
        lights: [
          { id: 1, kind: 'directional', direction: [0, 0, -1], color: [1, 1, 1], intensity: 3.0 },
        ],
        objects: [
          {
            entityId: 1,
            meshKey: 'quad',
            materialKey: 'white',
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
          },
        ],
      })
      .unwrap();
    expect(receipt.status).toBe('ready');
    await Promise.resolve();

    const px = readCanvasCenterPixel(canvas);
    // White lit quad graded by [1.0, 0.35, 0.25] -> strongly warm red center!
    expect(px[0]).toBeGreaterThan(145);
    expect(px[1]).toBeLessThan(px[0] * 0.65);
    expect(px[2]).toBeLessThan(px[0] * 0.55);
    expect(px[3]).toBe(255);
  } finally {
    renderer.dispose();
    kernel.dispose();
    ctx.unconfigure();
    disposeDevice(device);
    canvas.remove();
  }
});
