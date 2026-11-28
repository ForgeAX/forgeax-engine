import { describe, expect, it } from 'vitest';
import { createNativeRenderKernel, isNativeRenderKernelAvailable } from '../desktop/index.js';
import { ok } from '../errors.js';
import {
  compileKernelRenderPipeline,
  createRenderKernel,
  type KernelRenderFeature,
  KernelRenderGraphBuilder,
  type KernelRenderPipeline,
  type MeshId,
  type RenderKernelExecutionTarget,
  type SamplerId,
  type ShaderProgramId,
} from '../index.js';

interface TestPipelineFrame {
  readonly quadMesh: MeshId;
  readonly depthShader: ShaderProgramId;
  readonly mrtShader: ShaderProgramId;
  readonly featureShader: ShaderProgramId;
  readonly linearSampler: SamplerId;
  readonly tintRgb: readonly [number, number, number];
  readonly readbackTicketId: number;
}

const WGSL_SHADOW_DEPTH = /* wgsl */ `
struct DepthParams {
  z_val: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(0) var<uniform> u_params: DepthParams;
@vertex
fn vs_main(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(pos, u_params.z_val, 1.0);
}
`;

const WGSL_MRT_SCENE = /* wgsl */ `
struct SceneParams {
  albedo: vec4<f32>,
  aux_data: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_scene: SceneParams;
@group(0) @binding(1) var shadow_tex: texture_depth_2d;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
struct MrtOut {
  @location(0) hdr_color: vec4<f32>,
  @location(1) aux_rg: vec4<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec2<f32>) -> VsOut {
  var o: VsOut;
  o.pos = vec4<f32>(pos, 0.25, 1.0);
  o.uv = pos * 0.5 + vec2<f32>(0.5, 0.5);
  return o;
}

@fragment
fn fs_main(in: VsOut) -> MrtOut {
  let depth_sample = textureLoad(shadow_tex, vec2<i32>(8, 8), 0);
  // Shadow quad wrote depth ~0.40 at center; brighten color when depth is in (0.2, 0.6)
  let shadow_ok = select(0.25, 1.0, depth_sample > 0.2 && depth_sample < 0.6);
  var out: MrtOut;
  out.hdr_color = vec4<f32>(u_scene.albedo.rgb * shadow_ok, 1.0);
  out.aux_rg = vec4<f32>(u_scene.aux_data.x, u_scene.aux_data.y, 0.0, 1.0);
  return out;
}
`;

const WGSL_CUSTOM_FEATURE_COMPOSITE = /* wgsl */ `
struct FeatureParams {
  tint: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u_feat: FeatureParams;
@group(0) @binding(1) var hdr_mip1: texture_2d<f32>;
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
  let c = textureSample(hdr_mip1, smp, in.uv);
  let m = textureSample(meta_tex, smp, in.uv);
  return vec4<f32>(
    clamp(c.r * u_feat.tint.r + m.r * 0.2, 0.0, 1.0),
    clamp(c.g * u_feat.tint.g + m.g * 0.2, 0.0, 1.0),
    clamp(c.b * u_feat.tint.b, 0.0, 1.0),
    1.0,
  );
}
`;

function createUnifiedMultiPassPipeline(): {
  readonly pipeline: KernelRenderPipeline<TestPipelineFrame>;
  readonly feature: KernelRenderFeature<TestPipelineFrame>;
} {
  const feature: KernelRenderFeature<TestPipelineFrame> = {
    name: 'user-tint-mip-composite',
    stage: 'before-present',
    install(builder, targets) {
      const metaTex = targets.extras?.meta;
      if (metaTex === undefined) {
        throw new Error('expected MRT meta target');
      }
      const mip1View = builder.view(targets.sceneColor, { baseMipLevel: 1, mipLevelCount: 1 });
      let bindingSetId = 0;
      return builder.addRasterPass('feature-tint-composite', {
        reads: [mip1View, metaTex],
        colorAttachments: [
          {
            target: targets.outputTarget,
            loadOp: 'clear',
            storeOp: 'store',
            clearColor: [0, 0, 0, 1],
          },
        ],
        prepare(frame, resources) {
          const u = resources.writeUniform(
            new Float32Array([frame.tintRgb[0], frame.tintRgb[1], frame.tintRgb[2], 1.0]),
          );
          const bs = resources.beginBindingSet();
          bs.bindUniformSlice(0, u.offset, u.length);
          resources.bindTexture(bs, 1, mip1View);
          resources.bindTexture(bs, 2, metaTex);
          bs.bindSampler(3, frame.linearSampler);
          bindingSetId = bs.finish();
        },
        encode(pass, frame) {
          pass.drawFullscreen(frame.featureShader, bindingSetId as never);
        },
      });
    },
  };

  const pipeline: KernelRenderPipeline<TestPipelineFrame> = {
    name: 'unified-mrt-shadow-mip-pipeline',
    build(builder, features) {
      const shadowDepth = builder
        .createTexture('shadow-depth', { format: 'depth32float', width: 32, height: 32 })
        .unwrap();
      const hdrColor = builder
        .createTexture('scene-hdr', { format: 'rgba16float', mipLevelCount: 3 })
        .unwrap();
      const mrtMeta = builder.createTexture('scene-meta', { format: 'rg16float' }).unwrap();
      const sceneDepth = builder.createTexture('scene-depth', { format: 'depth32float' }).unwrap();
      const finalOut = builder.createTexture('final-out', { format: 'rgba8unorm' }).unwrap();

      let shadowBg = 0;
      builder
        .addRasterPass('shadow-depth-pass', {
          colorAttachments: [],
          depthAttachment: {
            target: shadowDepth,
            loadOp: 'clear',
            storeOp: 'store',
            clearDepth: 1.0,
          },
          prepare(_frame, resources) {
            const u = resources.writeUniform(new Float32Array([0.4, 0, 0, 0]));
            shadowBg = resources.beginBindingSet().bindUniformSlice(0, u.offset, u.length).finish();
          },
          encode(pass, frame) {
            pass.setShaderPipeline(frame.depthShader, 1, 1, 1);
            pass.setBindGroup(0, shadowBg as never);
            pass.setVertexBuffer(0, frame.quadMesh);
            pass.draw(6, 1, 0, 0);
          },
        })
        .unwrap();

      const shadowReadView = builder.view(shadowDepth, { aspect: 'depth-only' });
      let mrtBg = 0;
      builder
        .addRasterPass('mrt-scene-pass', {
          reads: [shadowReadView],
          colorAttachments: [
            { target: hdrColor, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
            { target: mrtMeta, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
          ],
          depthAttachment: {
            target: sceneDepth,
            loadOp: 'clear',
            storeOp: 'store',
            clearDepth: 1.0,
          },
          prepare(_frame, resources) {
            const u = resources.writeUniform(
              new Float32Array([0.6, 0.8, 0.4, 1.0, 0.5, 0.25, 0.0, 0.0]),
            );
            const bs = resources.beginBindingSet();
            bs.bindUniformSlice(0, u.offset, u.length);
            resources.bindTexture(bs, 1, shadowReadView);
            mrtBg = bs.finish();
          },
          encode(pass, frame) {
            pass.setShaderPipeline(frame.mrtShader, 1, 2, 1);
            pass.setBindGroup(0, mrtBg as never);
            pass.setVertexBuffer(0, frame.quadMesh);
            pass.draw(6, 1, 0, 0);
          },
        })
        .unwrap();

      builder.addMipGenPass('hdr-mipgen', hdrColor).unwrap();

      const installRes = builder.installFeatures('before-present', features, {
        sceneColor: hdrColor,
        sceneDepth,
        outputTarget: finalOut,
        extras: { meta: mrtMeta },
      });
      if (!installRes.ok) return installRes;

      builder
        .addReadbackPass('final-readback', {
          source: finalOut,
          ticketId: (frame) => frame.readbackTicketId,
        })
        .unwrap();
      return ok(undefined);
    },
  };

  return { pipeline, feature };
}

function registerSharedTestAssets(assets: {
  createMesh: (
    desc: {
      readonly vertexLayoutId: number;
      readonly vertexCount: number;
      readonly indexCount: number;
    },
    vertexBytes: Uint8Array,
  ) => { unwrap(): MeshId };
  createSampler: (desc: {
    readonly magFilter: GPUFilterMode;
    readonly minFilter: GPUFilterMode;
    readonly mipmapFilter: GPUMipmapFilterMode;
  }) => { unwrap(): SamplerId };
  registerShaderProgram: (desc: import('../contract.js').KernelShaderProgramDesc) => {
    unwrap(): ShaderProgramId;
  };
}): Omit<TestPipelineFrame, 'tintRgb' | 'readbackTicketId'> {
  const quadVerts = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const quadMesh = assets
    .createMesh(
      { vertexLayoutId: 1, vertexCount: 6, indexCount: 0 },
      new Uint8Array(quadVerts.buffer, quadVerts.byteOffset, quadVerts.byteLength),
    )
    .unwrap();
  const linearSampler = assets
    .createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
    .unwrap();
  const quadLayout: GPUVertexBufferLayout[] = [
    {
      arrayStride: 8,
      attributes: [{ format: 'float32x2', offset: 0, shaderLocation: 0 }],
    },
  ];
  const depthShader = assets
    .registerShaderProgram({
      code: WGSL_SHADOW_DEPTH,
      vertexEntryPoint: 'vs_main',
      layoutFamilyId: 0,
      vertexBufferLayouts: quadLayout,
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      label: 'shadow-depth',
    })
    .unwrap();
  const mrtShader = assets
    .registerShaderProgram({
      code: WGSL_MRT_SCENE,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      layoutFamilyId: 0,
      vertexBufferLayouts: quadLayout,
      colorTargets: [
        { format: 'rgba16float', blendMode: 'none' },
        { format: 'rg16float', blendMode: 'none' },
      ],
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      label: 'mrt-scene',
    })
    .unwrap();
  const featureShader = assets
    .registerShaderProgram({
      code: WGSL_CUSTOM_FEATURE_COMPOSITE,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      layoutFamilyId: 0,
      colorFormats: ['rgba8unorm'],
      label: 'custom-feature-composite',
    })
    .unwrap();
  return { quadMesh, depthShader, mrtShader, featureShader, linearSampler };
}

describe('KernelRenderGraph (declarative cross-backend RenderGraph + custom RenderFeature)', () => {
  it('validates uninitialized reads, same-pass conflicts, RAW/WAR deps, MSAA auto-discard, and raster batching', () => {
    // 1. Uninitialized transient texture read must fail compilation
    const b1 = new KernelRenderGraphBuilder<undefined>();
    const uninit = b1.createTexture('uninit', { format: 'rgba8unorm' }).unwrap();
    const out = b1.createTexture('out', { format: 'rgba8unorm' }).unwrap();
    b1.addRasterPass('bad-read', {
      reads: [uninit],
      colorAttachments: [{ target: out, loadOp: 'clear' }],
      encode() {},
    }).unwrap();
    const r1 = b1.compile({ surfaceSize: { width: 64, height: 64 } });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('kernel-pass-resource-conflict');

    // 2. Same-pass write + sampled read hazard must fail compilation
    const b2 = new KernelRenderGraphBuilder<undefined>();
    const rt = b2.createTexture('rt', { format: 'rgba8unorm' }).unwrap();
    b2.addRasterPass('init', {
      colorAttachments: [{ target: rt, loadOp: 'clear' }],
      encode() {},
    }).unwrap();
    b2.addRasterPass('hazard', {
      reads: [rt],
      colorAttachments: [{ target: rt, loadOp: 'load' }],
      encode() {},
    }).unwrap();
    const r2 = b2.compile({ surfaceSize: { width: 64, height: 64 } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('kernel-pass-resource-conflict');

    // 3. MSAA storeOp:'auto' discard + compatible adjacent raster batching + RAW dependency
    const b3 = new KernelRenderGraphBuilder<undefined>();
    const msaa = b3.createTexture('msaa-color', { format: 'rgba8unorm', sampleCount: 4 }).unwrap();
    const resolved = b3.createTexture('resolved-color', { format: 'rgba8unorm' }).unwrap();
    const finalTex = b3.createTexture('final', { format: 'rgba8unorm' }).unwrap();
    b3.addRasterPass('msaa-pass', {
      colorAttachments: [
        { target: msaa, resolveTarget: resolved, loadOp: 'clear', storeOp: 'auto' },
      ],
      encode() {},
    }).unwrap();
    b3.addRasterPass('post-a', {
      reads: [resolved],
      colorAttachments: [{ target: finalTex, loadOp: 'clear', storeOp: 'store' }],
      encode() {},
    }).unwrap();
    b3.addRasterPass('post-b', {
      reads: [resolved],
      colorAttachments: [{ target: finalTex, loadOp: 'load', storeOp: 'store' }],
      encode() {},
    }).unwrap();
    const compiled = b3.compile({ surfaceSize: { width: 128, height: 64 } }).unwrap();
    const info = compiled.inspect();
    expect(info.passes[0]?.autoDiscardedAttachments).toEqual(['msaa-color']);
    expect(info.passes[1]?.rasterBatch).toBe(info.passes[2]?.rasterBatch);
    expect(info.dependencies.some((d) => d.kind === 'RAW' && d.resource === 'resolved-color')).toBe(
      true,
    );
  });

  const runNative = isNativeRenderKernelAvailable() ? it : it.skip;
  runNative(
    'executes a 5-pass Shadow + 2-MRT + MipGen + Custom KernelRenderFeature + Readback pipeline on Native wgpu (Metal/DX12/Vulkan) and matches Dawn WebGPU pixels',
    async () => {
      const { pipeline, feature } = createUnifiedMultiPassPipeline();
      const compiled = compileKernelRenderPipeline(pipeline, [feature], {
        surfaceSize: { width: 64, height: 64 },
      }).unwrap();
      const info = compiled.inspect();
      expect(info.installedFeatures).toEqual([
        { name: 'user-tint-mip-composite', stage: 'before-present' },
      ]);
      expect(info.passes.map((p) => p.name)).toEqual([
        'shadow-depth-pass',
        'mrt-scene-pass',
        'hdr-mipgen',
        'feature-tint-composite',
        'final-readback',
      ]);

      // --- 1. Native Rust wgpu OS render thread (macOS Metal / Windows DX12 or Vulkan) ---
      const nativeKernel = createNativeRenderKernel({ maxInFlight: 2 }).unwrap();
      let nativePixels: Uint8Array;
      try {
        const assets = registerSharedTestAssets(nativeKernel.assets);
        const receipt = compiled
          .execute(nativeKernel as RenderKernelExecutionTarget, {
            ...assets,
            tintRgb: [1.0, 0.5, 0.75],
            readbackTicketId: 42,
          })
          .unwrap();
        expect(receipt.status).toBe('ready');
        expect(receipt.submittedPassCount).toBeGreaterThanOrEqual(3);

        const rb = (await nativeKernel.readbackTicket(42)).unwrap();
        expect(rb.width).toBe(64);
        expect(rb.height).toBe(64);
        expect(rb.format).toBe('rgba8unorm');
        nativePixels = rb.pixels;

        // Expected center pixel:
        // albedo=[0.6,0.8,0.4] * shadow_ok(1.0) -> hdr_mip1=[0.6,0.8,0.4]
        // meta=[0.5,0.25], tint=[1.0,0.5,0.75]
        // R = 0.6*1.0 + 0.5*0.2 = 0.70 -> ~178
        // G = 0.8*0.5 + 0.25*0.2 = 0.45 -> ~115
        // B = 0.4*0.75 = 0.30 -> ~76
        const center = (32 * 64 + 32) * 4;
        expect(nativePixels[center]).toBeGreaterThan(165);
        expect(nativePixels[center]).toBeLessThan(192);
        expect(nativePixels[center + 1]).toBeGreaterThan(102);
        expect(nativePixels[center + 1]).toBeLessThan(128);
        expect(nativePixels[center + 2]).toBeGreaterThan(64);
        expect(nativePixels[center + 2]).toBeLessThan(90);
        expect(nativePixels[center + 3]).toBe(255);

        // Execute a second frame with a different dynamic tint to prove zero-recompilation reuse!
        compiled
          .execute(nativeKernel as RenderKernelExecutionTarget, {
            ...assets,
            tintRgb: [0.2, 1.0, 0.5],
            readbackTicketId: 43,
          })
          .unwrap();
        const rb2 = (await nativeKernel.readbackTicket(43)).unwrap();
        // R = 0.6*0.2 + 0.1 = 0.22 (~56), G = 0.8*1.0 + 0.05 = 0.85 (~217)
        expect(rb2.pixels[center]).toBeLessThan(70);
        expect(rb2.pixels[center + 1]).toBeGreaterThan(200);
      } finally {
        nativeKernel.dispose();
      }

      // --- 2. Optional Dawn WebGPU cross-backend parity check using the EXACT same compiled graph ---
      let dawnDevice: import('@forgeax/engine-rhi').RhiDevice | undefined;
      let dawnShaderFactory: import('../contract.js').KernelCreateShaderModuleImmediate | undefined;
      try {
        if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
          const dawn = await import('@forgeax/engine-dawn-node');
          const gpu = dawn.create([]);
          Object.defineProperty(globalThis, 'navigator', {
            value: { gpu },
            configurable: true,
            writable: true,
          });
        }
        const webgpu = await import('@forgeax/engine-rhi-webgpu');
        const adapterRes = await webgpu.webgpuRhi.requestAdapter();
        if (adapterRes.ok) {
          const devRes = await adapterRes.value.requestDevice();
          if (devRes.ok) {
            dawnDevice = devRes.value;
            dawnShaderFactory = webgpu.createShaderModuleImmediate;
          }
        }
      } catch {
        // Dawn toolchain optional for unit tests per AGENTS.md
      }

      if (dawnDevice !== undefined && dawnShaderFactory !== undefined) {
        const wasmKernel = (
          await createRenderKernel({
            device: dawnDevice,
            createShaderModuleImmediate: dawnShaderFactory,
            backend: 'wasm',
          })
        ).unwrap();
        try {
          const assets = registerSharedTestAssets(wasmKernel.assets);
          compiled
            .execute(wasmKernel, {
              ...assets,
              tintRgb: [1.0, 0.5, 0.75],
              readbackTicketId: 99,
            })
            .unwrap();
          expect(wasmKernel.readbackTicket).toBeDefined();
          const dawnRb = (
            await (wasmKernel.readbackTicket as NonNullable<typeof wasmKernel.readbackTicket>)(99)
          ).unwrap();
          expect(dawnRb.width).toBe(64);
          expect(dawnRb.height).toBe(64);
          let maxDiff = 0;
          for (let i = 0; i < nativePixels.length; i++) {
            const diff = Math.abs((nativePixels[i] as number) - (dawnRb.pixels[i] as number));
            if (diff > maxDiff) maxDiff = diff;
          }
          expect(maxDiff).toBeLessThanOrEqual(2);
        } finally {
          wasmKernel.dispose();
        }
      }
    },
  );
});
