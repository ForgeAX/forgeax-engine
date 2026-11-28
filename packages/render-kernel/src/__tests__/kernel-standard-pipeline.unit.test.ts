import { describe, expect, it } from 'vitest';
import {
  createDesktopNativeSceneRenderer,
  createNativeRenderKernel,
  isNativeRenderKernelAvailable,
} from '../desktop/index.js';
import {
  compileKernelRenderPipeline,
  createPipelineTargets,
  type KernelRenderFeature,
  type KernelRenderPipeline,
} from '../graph/index.js';
import type { BindingSetId } from '../handles.js';
import { createRenderKernel } from '../index.js';
import {
  type KernelStandardFrameInput,
  type KernelStandardPipelineFrame,
  KernelStandardSceneRenderer,
  kernelMat4LookAt,
  kernelMat4Multiply,
  kernelMat4Perspective,
  packKernelMeshVertices,
} from '../pipeline/index.js';

function makeBoxGeometry(
  halfX: number,
  halfY: number,
  halfZ: number,
): {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array;
} {
  const faces: readonly {
    readonly n: readonly [number, number, number];
    readonly c: readonly (readonly [number, number, number])[];
  }[] = [
    {
      n: [0, 0, 1],
      c: [
        [-halfX, -halfY, halfZ],
        [halfX, -halfY, halfZ],
        [halfX, halfY, halfZ],
        [-halfX, halfY, halfZ],
      ],
    },
    {
      n: [0, 0, -1],
      c: [
        [halfX, -halfY, -halfZ],
        [-halfX, -halfY, -halfZ],
        [-halfX, halfY, -halfZ],
        [halfX, halfY, -halfZ],
      ],
    },
    {
      n: [0, 1, 0],
      c: [
        [-halfX, halfY, halfZ],
        [halfX, halfY, halfZ],
        [halfX, halfY, -halfZ],
        [-halfX, halfY, -halfZ],
      ],
    },
    {
      n: [0, -1, 0],
      c: [
        [-halfX, -halfY, -halfZ],
        [halfX, -halfY, -halfZ],
        [halfX, -halfY, halfZ],
        [-halfX, -halfY, halfZ],
      ],
    },
    {
      n: [1, 0, 0],
      c: [
        [halfX, -halfY, halfZ],
        [halfX, -halfY, -halfZ],
        [halfX, halfY, -halfZ],
        [halfX, halfY, halfZ],
      ],
    },
    {
      n: [-1, 0, 0],
      c: [
        [-halfX, -halfY, -halfZ],
        [-halfX, -halfY, halfZ],
        [-halfX, halfY, halfZ],
        [-halfX, halfY, -halfZ],
      ],
    },
  ];
  const pos: number[] = [];
  const norm: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let f = 0; f < faces.length; f++) {
    const face = faces[f];
    if (face === undefined) continue;
    const base = f * 4;
    for (const p of face.c) {
      pos.push(p[0], p[1], p[2]);
      norm.push(face.n[0], face.n[1], face.n[2]);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    vertices: packKernelMeshVertices(pos, norm, uvs),
    indices: new Uint16Array(idx),
  };
}

function translationMat4(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

const POST_TINT_WGSL = /* wgsl */ `
struct TintUniform { factor: vec4<f32> };
@group(0) @binding(0) var t_in: texture_2d<f32>;
@group(0) @binding(1) var s_in: sampler;
@group(0) @binding(2) var<uniform> u_tint: TintUniform;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut; o.pos = vec4<f32>(p[idx], 0.0, 1.0); o.uv = uv[idx]; return o;
}
@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(t_in, s_in, in.uv);
  return vec4<f32>(clamp(c.rgb * u_tint.factor.rgb + vec3<f32>(u_tint.factor.a), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

describe('KernelStandardPipeline & KernelRenderGraph composition', () => {
  it('orders stage features topologically by dependencies and rejects dependency cycles', () => {
    const order: string[] = [];
    const makeFeat = (
      name: string,
      dependencies?: readonly string[],
    ): KernelRenderFeature<Record<string, never>> => ({
      name,
      stage: 'post',
      ...(dependencies === undefined ? {} : { dependencies }),
      install(builder, targets) {
        order.push(name);
        const out = builder.createTexture(`${name}.out`, { format: 'rgba8unorm' });
        if (!out.ok) return out;
        const src = targets.currentColor ?? targets.sceneColor;
        const r = builder.addCopyTexturePass(`${name}.copy`, {
          source: src,
          destination: out.value,
        });
        if (!r.ok) return r;
        targets.setCurrentColor?.(out.value);
        return r;
      },
    });

    const pipe: KernelRenderPipeline<Record<string, never>> = {
      name: 'dep-test',
      build(builder, features) {
        const sc = builder.createTexture('sc', { format: 'rgba8unorm' }).unwrap();
        const out = builder.importSurface('out', { format: 'rgba8unorm' }).unwrap();
        builder
          .addRasterPass('seed', {
            colorAttachments: [{ target: sc, loadOp: 'clear', storeOp: 'store' }],
            encode() {},
          })
          .unwrap();
        const targets = createPipelineTargets({ sceneColor: sc, outputTarget: out });
        return builder.installFeatures('post', features, targets);
      },
    };

    const okRes = compileKernelRenderPipeline(
      pipe,
      [makeFeat('second', ['first']), makeFeat('first')],
      { surfaceSize: { width: 32, height: 32 } },
    );
    expect(okRes.ok).toBe(true);
    expect(order).toEqual(['first', 'second']);

    const cycRes = compileKernelRenderPipeline(pipe, [makeFeat('a', ['b']), makeFeat('b', ['a'])], {
      surfaceSize: { width: 32, height: 32 },
    });
    expect(cycRes.ok).toBe(false);
    if (!cycRes.ok) expect(cycRes.error.code).toBe('kernel-pass-resource-conflict');
  });

  it.skipIf(!isNativeRenderKernelAvailable())(
    'renders identical 3D PBR + Shadow + Bloom + Multi-Curve Tonemap + FXAA + Chained Features on Native wgpu and Dawn WebGPU (4-BGL + RHI Debug)',
    async () => {
      const W = 96;
      const H = 96;
      const proj = kernelMat4Perspective(
        (50 * Math.PI) / 180,
        W / H,
        0.1,
        100,
        new Float32Array(16),
      );
      const view = kernelMat4LookAt([0, 3.2, 6.2], [0, 0.4, 0], [0, 1, 0], new Float32Array(16));
      const viewProj = kernelMat4Multiply(proj, view, new Float32Array(16));

      const box = makeBoxGeometry(0.9, 0.9, 0.9);
      const ground = makeBoxGeometry(6, 0.1, 6);
      const panel = makeBoxGeometry(0.7, 0.7, 0.05);

      const buildSceneFrame = (
        tonemap: 'aces' | 'agx',
        ticketId: number,
        tintBias = 0.0,
      ): KernelStandardFrameInput => ({
        width: W,
        height: H,
        camera: {
          viewProj,
          position: [0, 3.2, 6.2],
          clearColor: [0.04, 0.05, 0.08, 1],
          exposure: 1.15,
          tonemap,
          bloom: { enabled: true, threshold: 0.85, intensity: 0.45 },
          fxaa: true,
        },
        skybox: {
          zenithColor: [0.12, 0.24, 0.55],
          horizonColor: [0.65, 0.75, 0.88],
          groundColor: [0.12, 0.1, 0.09],
          intensity: 1.0,
        },
        skylight: { skyColor: [0.5, 0.6, 0.8], groundColor: [0.2, 0.18, 0.15], intensity: 0.4 },
        fog: { mode: 'linear', color: [0.5, 0.6, 0.7], near: 12, far: 45, maxOpacity: 0.4 },
        lights: [
          {
            id: 1,
            kind: 'directional',
            direction: [-0.45, -1.0, -0.35],
            color: [1.0, 0.96, 0.9],
            intensity: 3.2,
            castShadow: true,
            cascadeCount: 2,
            shadowDistance: 16,
          },
          {
            id: 2,
            kind: 'point',
            position: [2.2, 1.5, 1.8],
            color: [0.3, 0.7, 1.0],
            intensity: 6.0,
            range: 12,
          },
        ],
        objects: [
          {
            entityId: 1,
            meshKey: 'ground',
            materialKey: 'mat-ground',
            worldMatrix: translationMat4(0, -0.5, 0),
          },
          {
            entityId: 2,
            meshKey: 'box',
            materialKey: 'mat-red',
            worldMatrix: translationMat4(-0.6, 0.45, 0),
          },
          {
            entityId: 3,
            meshKey: 'box',
            materialKey: 'mat-emissive',
            worldMatrix: translationMat4(1.4, 0.45, -0.4),
          },
          {
            entityId: 4,
            meshKey: 'panel',
            materialKey: 'mat-glass',
            worldMatrix: translationMat4(-0.2, 0.7, 1.6),
            castShadow: false,
          },
        ],
        readbackTicketId: ticketId,
        userData: { tintBias },
      });

      const registerAssetsAndFeatures = (
        renderer: KernelStandardSceneRenderer,
        assets: NonNullable<typeof renderer.kernel.assets>,
      ) => {
        renderer
          .ensureMesh({ key: 'ground', vertices: ground.vertices, indices: ground.indices })
          .unwrap();
        renderer.ensureMesh({ key: 'box', vertices: box.vertices, indices: box.indices }).unwrap();
        renderer
          .ensureMesh({ key: 'panel', vertices: panel.vertices, indices: panel.indices })
          .unwrap();
        renderer
          .ensureMaterial({ key: 'mat-ground', baseColor: [0.65, 0.65, 0.62, 1], roughness: 0.85 })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'mat-red',
            baseColor: [0.85, 0.18, 0.14, 1],
            roughness: 0.35,
            metallic: 0.15,
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'mat-emissive',
            baseColor: [1, 0.9, 0.5, 1],
            emissive: [3.2, 2.2, 0.6],
            roughness: 0.2,
          })
          .unwrap();
        renderer
          .ensureMaterial({
            key: 'mat-glass',
            baseColor: [0.2, 0.6, 1.0, 0.45],
            transparent: true,
            doubleSided: true,
          })
          .unwrap();

        const postShader = assets
          .registerShaderProgram({
            code: POST_TINT_WGSL,
            vertexEntryPoint: 'vs_main',
            fragmentEntryPoint: 'fs_main',
            layoutFamilyId: 0,
            colorFormats: ['rgba8unorm'],
            label: 'test.post-tint',
          })
          .unwrap();

        // Chained user features in 'post' stage exercising topological dependencies + currentColor ping-pong!
        const featWarm: KernelRenderFeature<KernelStandardPipelineFrame> = {
          name: 'user-warm-grade',
          stage: 'post',
          install(builder, targets) {
            const src = targets.currentColor ?? targets.sceneColor;
            const dst = builder.createTexture('user-warm-out', { format: 'rgba8unorm' });
            if (!dst.ok) return dst;
            let bg = 0;
            const passRes = builder.addRasterPass('user-warm-pass', {
              reads: [src],
              colorAttachments: [{ target: dst.value, loadOp: 'clear', storeOp: 'store' }],
              prepare(frame, res) {
                const u = res.writeUniform(new Float32Array([1.05, 0.98, 0.92, 0.0]));
                const b = res.beginBindingSet();
                res.bindTexture(b, 0, src);
                b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
                bg = b.finish();
              },
              encode(pass) {
                pass.drawFullscreen(postShader, bg as BindingSetId);
              },
            });
            if (!passRes.ok) return passRes;
            targets.setCurrentColor?.(dst.value);
            return passRes;
          },
        };
        const featLift: KernelRenderFeature<KernelStandardPipelineFrame> = {
          name: 'user-lift',
          stage: 'post',
          dependencies: ['user-warm-grade'],
          install(builder, targets) {
            const src = targets.currentColor ?? targets.sceneColor;
            const dst = builder.createTexture('user-lift-out', { format: 'rgba8unorm' });
            if (!dst.ok) return dst;
            let bg = 0;
            const passRes = builder.addRasterPass('user-lift-pass', {
              reads: [src],
              colorAttachments: [{ target: dst.value, loadOp: 'clear', storeOp: 'store' }],
              prepare(frame, res) {
                const bias = (frame.userData as { tintBias?: number } | undefined)?.tintBias ?? 0;
                const u = res.writeUniform(new Float32Array([1.0, 1.0, 1.0, bias]));
                const b = res.beginBindingSet();
                res.bindTexture(b, 0, src);
                b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
                bg = b.finish();
              },
              encode(pass) {
                pass.drawFullscreen(postShader, bg as BindingSetId);
              },
            });
            if (!passRes.ok) return passRes;
            targets.setCurrentColor?.(dst.value);
            return passRes;
          },
        };
        // Register in reverse order to prove topological sorting works!
        renderer.registerFeature(featLift).unwrap();
        renderer.registerFeature(featWarm).unwrap();
      };

      // --- 1. Native wgpu (macOS Metal / Windows DX12 or Vulkan) ---
      const nativeKernel = createNativeRenderKernel({ maxInFlight: 2 }).unwrap();
      const nativeRenderer = KernelStandardSceneRenderer.create(nativeKernel, {
        headless: true,
        shadowMapSize: 512,
      }).unwrap();
      let nativePixelsAces: Uint8Array;
      try {
        registerAssetsAndFeatures(
          nativeRenderer,
          nativeKernel.assets as NonNullable<typeof nativeRenderer.kernel.assets>,
        );
        nativeRenderer.renderFrame(buildSceneFrame('aces', 101, 0.04)).unwrap();
        const rb1 = (await nativeRenderer.readbackTicket(101)).unwrap();
        expect(rb1.width).toBe(W);
        expect(rb1.height).toBe(H);
        nativePixelsAces = rb1.pixels;

        // Verify graph inspection shows all passes & topologically ordered features
        const info = nativeRenderer.inspectGraph();
        expect(info).toBeDefined();
        expect(info?.installedFeatures.map((f) => f.name)).toEqual([
          'user-warm-grade',
          'user-lift',
        ]);
        expect(info?.passes.some((p) => p.name === 'standard-shadow-depth')).toBe(true);
        expect(info?.passes.some((p) => p.name === 'standard-bloom-composite')).toBe(true);
        expect(info?.passes.some((p) => p.name === 'standard-fxaa')).toBe(true);

        // Steady-state frame reuses compiled graph (0 recompilations) & AgX changes output visibly
        nativeRenderer.renderFrame(buildSceneFrame('agx', 102, 0.04)).unwrap();
        const rb2 = (await nativeRenderer.readbackTicket(102)).unwrap();
        expect(nativeRenderer.stats().graphCompilations).toBe(1);
        expect(nativeRenderer.stats().graphCacheHits).toBe(1);

        let curveDiffs = 0;
        let nonZeroPixels = 0;
        for (let i = 0; i < nativePixelsAces.length; i += 4) {
          const r = nativePixelsAces[i] as number;
          const g = nativePixelsAces[i + 1] as number;
          const b = nativePixelsAces[i + 2] as number;
          if (r + g + b > 40) nonZeroPixels++;
          if (Math.abs(r - (rb2.pixels[i] as number)) > 4) curveDiffs++;
        }
        expect(nonZeroPixels).toBeGreaterThan(W * H * 0.6);
        expect(curveDiffs).toBeGreaterThan(200);
      } finally {
        nativeRenderer.dispose();
        nativeKernel.dispose();
      }

      // --- 2. Dawn WebGPU (WasmRenderKernel + RhiScene4BglState + RHI Debug Capture) ---
      let dawnDevice: import('@forgeax/engine-rhi').RhiDevice | undefined;
      let dawnShaderFactory: import('../contract.js').KernelCreateShaderModuleImmediate | undefined;
      let getCapturedFrameModel: (() => unknown) | undefined;
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
        const rhiDebug = await import('@forgeax/engine-rhi-debug');
        const attached = rhiDebug
          .attachRecorder({
            rhi: webgpu.webgpuRhi,
            createShaderModule: webgpu.createShaderModule,
            createShaderModuleImmediate: webgpu.createShaderModuleImmediate,
          })
          .unwrap();
        const adapterRes = await attached.backend.rhi.requestAdapter();
        if (adapterRes.ok) {
          const devRes = await adapterRes.value.requestDevice();
          if (devRes.ok) {
            dawnDevice = devRes.value;
            dawnShaderFactory = attached.backend.createShaderModuleImmediate;
            getCapturedFrameModel = () => {
              const cap = attached.controller.captureNextFrame();
              return cap;
            };
          }
        }
      } catch {
        // Dawn optional when unavailable
      }

      if (dawnDevice !== undefined && dawnShaderFactory !== undefined) {
        const wasmKernel = (
          await createRenderKernel({
            device: dawnDevice,
            createShaderModuleImmediate: dawnShaderFactory,
            backend: 'wasm',
          })
        ).unwrap();
        expect(wasmKernel.supportsScene4Bgl).toBe(true);
        const dawnRenderer = KernelStandardSceneRenderer.create(wasmKernel, {
          headless: true,
          shadowMapSize: 512,
        }).unwrap();
        try {
          registerAssetsAndFeatures(dawnRenderer, wasmKernel.assets);
          getCapturedFrameModel?.();
          dawnRenderer.renderFrame(buildSceneFrame('aces', 201, 0.04)).unwrap();
          const dawnRb = (await dawnRenderer.readbackTicket(201)).unwrap();
          expect(dawnRb.width).toBe(W);
          expect(dawnRb.height).toBe(H);

          // Compare Native Metal/DX12/Vulkan vs Dawn WebGPU pixel-for-pixel!
          let meanAbsDiff = 0;
          for (let i = 0; i < nativePixelsAces.length; i++) {
            meanAbsDiff += Math.abs((nativePixelsAces[i] as number) - (dawnRb.pixels[i] as number));
          }
          meanAbsDiff /= nativePixelsAces.length;
          expect(meanAbsDiff).toBeLessThan(2.5);
        } finally {
          dawnRenderer.dispose();
          wasmKernel.dispose();
        }
      }
    },
  );

  it.skipIf(!isNativeRenderKernelAvailable())(
    'executes user KernelRenderFeature installed on DesktopNativeSceneRenderer',
    () => {
      const desktop = createDesktopNativeSceneRenderer({ headless: true }).unwrap();
      try {
        const shader = desktop.kernel.assets
          .registerShaderProgram({
            code: POST_TINT_WGSL,
            vertexEntryPoint: 'vs_main',
            fragmentEntryPoint: 'fs_main',
            layoutFamilyId: 0,
            colorFormats: ['rgba8unorm'],
            blendMode: 'additive',
            label: 'desktop.custom-feature',
          })
          .unwrap();
        const box = makeBoxGeometry(0.8, 0.8, 0.8);
        desktop.ensureMesh({ key: 'cube', vertices: box.vertices, indices: box.indices }).unwrap();
        desktop
          .ensureMaterial({ key: 'gray', baseColor: [0.4, 0.4, 0.4, 1], roughness: 0.5 })
          .unwrap();
        const proj = kernelMat4Perspective((50 * Math.PI) / 180, 1, 0.1, 100, new Float32Array(16));
        const view = kernelMat4LookAt([0, 1.5, 4], [0, 0, 0], [0, 1, 0], new Float32Array(16));
        const vp = kernelMat4Multiply(proj, view, new Float32Array(16));
        const frame = {
          width: 64,
          height: 64,
          camera: {
            viewProj: vp,
            position: [0, 1.5, 4] as const,
            clearColor: [0.05, 0.05, 0.05, 1] as const,
          },
          lights: [
            {
              id: 1,
              kind: 'directional' as const,
              direction: [0, -1, -0.5] as const,
              color: [1, 1, 1] as const,
              intensity: 2,
            },
          ],
          objects: [
            {
              entityId: 1,
              meshKey: 'cube',
              materialKey: 'gray',
              worldMatrix: translationMat4(0, 0, 0),
            },
          ],
        };

        const before = desktop.renderWitnessFrame(frame).unwrap();
        const center = (32 * 64 + 32) * 4;
        const rBefore = before.image.pixels[center] as number;

        desktop
          .registerFeature({
            name: 'desktop-red-boost',
            stage: 'before-present',
            install(builder, targets) {
              let bg = 0;
              return builder.addRasterPass('desktop-boost', {
                reads: [targets.sceneColor],
                colorAttachments: [
                  { target: targets.outputTarget, loadOp: 'load', storeOp: 'store' },
                ],
                prepare(ctx, res) {
                  const u = res.writeUniform(new Float32Array([0.0, 0.0, 0.0, 0.35]));
                  const b = res.beginBindingSet();
                  res.bindTexture(b, 0, targets.sceneColor);
                  b.bindSampler(1, ctx.postSampler).bindUniformSlice(2, u.offset, u.length);
                  bg = b.finish();
                },
                encode(pass) {
                  pass.drawFullscreen(shader, bg as BindingSetId);
                },
              });
            },
          })
          .unwrap();

        const after = desktop.renderWitnessFrame(frame).unwrap();
        const rAfter = after.image.pixels[center] as number;
        expect(rAfter).toBeGreaterThan(rBefore + 40);
      } finally {
        desktop.dispose();
      }
    },
  );
});
