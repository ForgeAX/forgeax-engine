// @ts-nocheck — merged file: cross-source node:fs/node:path imports outside @types/node coverage in runtime tsconfig
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=33):
//   - packages/runtime/__tests__/create-renderer-fallback.test.ts
//   - packages/runtime/src/__tests__/cluster-binner.test.ts
//   - packages/runtime/src/__tests__/create-renderer-fallback-shader-manifest.test.ts
//   - packages/runtime/src/__tests__/create-renderer-uniform-fallback.test.ts
//   - packages/runtime/src/__tests__/createRenderer.test.ts
//   - packages/runtime/src/__tests__/dispatch-sort.test.ts
//   - packages/runtime/src/__tests__/engine-metrics.test.ts
//   - packages/runtime/src/__tests__/device/gpu-residency-caps-guard.test.ts
//   - packages/runtime/src/__tests__/pass-selector.test.ts
//   - packages/runtime/src/__tests__/pipeline-builder.test.ts
//   - packages/runtime/src/__tests__/pipeline-cache-key-topology.test.ts
//   - packages/runtime/src/__tests__/pipeline-rename-grep-gate.test.ts
//   - packages/runtime/src/__tests__/pipeline-vertex-stride-branch.test.ts
//   - packages/runtime/src/__tests__/post-process-register.test.ts
//   - packages/runtime/src/__tests__/record-all-topology.test.ts
//   - packages/runtime/src/__tests__/record-draw-branch.test.ts
//   - packages/runtime/src/__tests__/record-strip-index-format.test.ts
//   - packages/runtime/src/__tests__/render-query-regression.test.ts
//   - packages/runtime/src/__tests__/renderer-draw-world.test.ts
//   - packages/runtime/src/__tests__/renderer-input-snapshot.test.ts
//   - packages/runtime/src/__tests__/renderer-read-pixels.test.ts
//   - packages/runtime/src/__tests__/renderer-ready.test.ts
//   - packages/runtime/src/__tests__/renderstate-pipeline-cache.test.ts
//   - packages/runtime/src/__tests__/storage-buffer-caps.test.ts
//   - packages/runtime/src/__tests__/device/gpu-residency.test.ts
//   - packages/runtime/src/__tests__/render-data.test.ts
//   - packages/runtime/src/__tests__/hdrp-bgl-slots.test.ts
//   - packages/runtime/src/__tests__/hdrp-caps-gate.test.ts
//   - packages/runtime/src/__tests__/hdrp-grid-invalid.test.ts
//   - packages/runtime/src/__tests__/hdrp-index-list-overflow-once.test.ts
//   - packages/runtime/src/__tests__/hdrp-light-budget.test.ts
//   - packages/runtime/src/__tests__/hdrp-pipeline-asset-config.test.ts
//   - packages/runtime/src/__tests__/m7-hdrp-demo-shape.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDLE_CUBE, HANDLE_TRIANGLE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World as WorldType } from '@forgeax/engine-ecs';
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  buildMeshAttributeMapForUvSets,
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  createTorusGeometry,
  PROCEDURAL_FLOATS_PER_VERTEX,
} from '@forgeax/engine-geometry';
import { type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import type { Renderer as RendererType } from '@forgeax/engine-render';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import {
  err,
  ok,
  type PipelineLayout,
  type RenderPipeline,
  type Result,
  type RhiCaps,
  type RhiDevice,
  RhiError,
  ok as rhiOk,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import {
  acquireCanvasContext as acquireNullCanvasContext,
  createShaderModule as createNullShaderModule,
  RhiNullAdapter,
} from '@forgeax/engine-rhi-null';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import {
  findVariantByKey,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
} from '@forgeax/engine-shader';
import {
  type AssetError,
  type EquirectAsset,
  type Handle,
  type MaterialRenderState,
  type MeshAsset,
  type PassSelector,
  type PrimitiveTopology,
  type RenderPipelineAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bin,
  type ClusterBinError,
  calculateSphereClusterBounds,
  clusterSpaceObjectAabb,
  deriveCullingRadius,
  ndcPositionToCluster,
  viewZToZSlice,
} from '../../../render/src/cluster-binner';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { createEngineMetrics } from '../../../render/src/engine-metrics';
import { assertStorageBufferCap } from '../../../render/src/light-buffer-layout';
import {
  buildPbrPipelineLayouts,
  buildPbrViewBglEntries,
  type PbrCaps,
} from '../../../render/src/pbr-pipeline';
import {
  HdrpInstallError,
  validateClusterGrid,
} from '../../../render/src/pipeline/standard-pipeline';
import {
  buildPipelineForMaterialShader,
  type PipelineBuilderContext,
  type PipelineBuilderShaderModuleFactory,
} from '../../../render/src/pipeline-builder';
import {
  cacheKeyOf,
  createHdrpBindGroupLayoutDescriptor,
  type PipelineSpec,
} from '../../../render/src/pipeline-spec';
import {
  deriveRenderDataCubemap,
  deriveRenderDataMesh,
  deriveRenderDataTexture,
} from '../../../render/src/render-data';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';
import { matchPass } from '../../../render/src/systems/pass-selector';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';

function makeExplicitNullRhi(spies: {
  setIndexBuffer: ReturnType<typeof vi.fn>;
  setVertexBuffer: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  drawIndexed: ReturnType<typeof vi.fn>;
}): unknown {
  const adapter = new RhiNullAdapter();
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async () => {
    const result = await requestDevice();
    if (result.ok) {
      const device = result.value;
      const createCommandEncoder = device.createCommandEncoder.bind(device);
      device.createCommandEncoder = (desc) => {
        const encoderResult = createCommandEncoder(desc);
        if (!encoderResult.ok) return encoderResult;
        const encoder = encoderResult.value;
        const beginRenderPass = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (passDesc) => {
          const pass = beginRenderPass(passDesc);
          const draw = pass.draw.bind(pass);
          const drawIndexed = pass.drawIndexed.bind(pass);
          const setIndexBuffer = pass.setIndexBuffer.bind(pass);
          const setVertexBuffer = pass.setVertexBuffer.bind(pass);
          pass.draw = (...args) => {
            spies.draw(...args);
            draw(...args);
          };
          pass.drawIndexed = (...args) => {
            spies.drawIndexed(...args);
            drawIndexed(...args);
          };
          pass.setIndexBuffer = (...args) => {
            spies.setIndexBuffer(...args);
            setIndexBuffer(...args);
          };
          pass.setVertexBuffer = (...args) => {
            spies.setVertexBuffer(...args);
            setVertexBuffer(...args);
          };
          return pass;
        };
        return { ok: true, value: encoder };
      };
    }
    return result;
  };
  return {
    requestAdapter: async () => ({ ok: true, value: adapter }),
    acquireCanvasContext: acquireNullCanvasContext,
    createShaderModule: (device: unknown, desc: { code: string; label?: string }) =>
      createNullShaderModule(device as never, desc),
  };
}

vi.mock('@forgeax/engine-rhi-wgpu', () => {
  return {
    rhi: {
      requestAdapter: async () => ({
        ok: false,
        error: {
          code: 'adapter-unavailable',
          expected: 'adapter available',
          hint: 'default mock fail',
        },
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
      acquireCanvasContext: () => ({
        ok: false,
        error: {
          code: 'webgpu-runtime-error',
          expected: 'context available',
          hint: 'default mock fail',
        },
      }),
    },
    ensureReady: async () => undefined,
  };
});

void [
  Camera,
  ChildOf,
  GpuResidencyCache,
  HANDLE_CUBE,
  HANDLE_TRIANGLE,
  HdrpInstallError,
  MeshFilter,
  MeshRenderer,
  PROCEDURAL_FLOATS_PER_VERTEX,
  RhiError,
  RhiNullAdapter,
  Transform,
  World,
  acquireNullCanvasContext,
  afterEach,
  assertStorageBufferCap,
  beforeEach,
  bin,
  buildMeshAttributeMapForUvSets,
  buildPbrPipelineLayouts,
  buildPbrViewBglEntries,
  buildPipelineForMaterialShader,
  cacheKeyOf,
  calculateSphereClusterBounds,
  clusterSpaceObjectAabb,
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createEngineMetrics,
  createHdrpBindGroupLayoutDescriptor,
  createNullShaderModule,
  createPlaneGeometry,
  createSphereGeometry,
  createTorusGeometry,
  defineComponent,
  deriveCullingRadius,
  deriveRenderDataCubemap,
  deriveRenderDataMesh,
  deriveRenderDataTexture,
  describe,
  dirname,
  err,
  existsSync,
  expect,
  extractFrame,
  fileURLToPath,
  findVariantByKey,
  it,
  makeExplicitNullRhi,
  makeMockShaderRegistry,
  mat4,
  matchPass,
  ndcPositionToCluster,
  ok,
  prepareExtractContext,
  readFileSync,
  resolve,
  resolveAssetHandle,
  rhiOk,
  standardMaterialShaderVariants,
  toShared,
  validateClusterGrid,
  vec3,
  vi,
  viewZToZSlice,
];
type __MergedKeep =
  | AssetError
  | ClusterBinError
  | EquirectAsset
  | Handle
  | Mat4
  | MaterialRenderState
  | MaterialShaderEntry
  | MaterialShaderManifestEntry
  | MaterialShaderManifestVariant
  | MeshAsset
  | PassSelector
  | PbrCaps
  | PipelineBuilderContext
  | PipelineBuilderShaderModuleFactory
  | PipelineLayout
  | PipelineSpec
  | PrimitiveTopology
  | RenderPipeline
  | RenderPipelineAsset
  | RendererType
  | Result
  | RhiCaps
  | RhiDevice
  | ShaderModule
  | TextureAsset
  | Vec3
  | WorldType;

{
  // --- from pipeline-builder.test.ts ---
  const SHADER_MODULE_SENTINEL = Symbol('mock-shader-module');
  const RENDER_PIPELINE_SENTINEL = Symbol('mock-render-pipeline');
  const PIPELINE_LAYOUT_SENTINEL = Symbol('mock-pipeline-layout');

  function makeMockEntry(): MaterialShaderEntry {
    return {
      source: '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
      paramSchema: [
        { name: 'baseColor', type: 'color' },
        { name: 'time', type: 'f32' },
      ],
    };
  }

  interface MockSet {
    factory: PipelineBuilderShaderModuleFactory;
    device: Pick<RhiDevice, 'createRenderPipeline'>;
    createShaderModule: ReturnType<typeof vi.fn>;
    createRenderPipeline: ReturnType<typeof vi.fn>;
  }

  function makeMocks(opts?: {
    createShaderModuleResult?: Result<ShaderModule, RhiError>;
    createRenderPipelineResult?: Result<RenderPipeline, RhiError>;
  }): MockSet {
    const shaderModule = { [SHADER_MODULE_SENTINEL]: 'mock' } as unknown as ShaderModule;
    const renderPipeline = { [RENDER_PIPELINE_SENTINEL]: 'mock' } as unknown as RenderPipeline;
    const createShaderModule = vi.fn(
      (): Result<ShaderModule, RhiError> => opts?.createShaderModuleResult ?? ok(shaderModule),
    );
    const createRenderPipeline = vi.fn(
      (): Result<RenderPipeline, RhiError> =>
        opts?.createRenderPipelineResult ?? ok(renderPipeline),
    );
    return {
      factory: { createShaderModule } as PipelineBuilderShaderModuleFactory,
      device: { createRenderPipeline } as unknown as Pick<RhiDevice, 'createRenderPipeline'>,
      createShaderModule,
      createRenderPipeline,
    };
  }

  function makeMockContext(mocks: MockSet): PipelineBuilderContext {
    return {
      device: mocks.device as unknown as RhiDevice,
      shaderModuleFactory: mocks.factory,
      pipelineLayout: { [PIPELINE_LAYOUT_SENTINEL]: 'mock' } as unknown as PipelineLayout,
      colorFormat: 'bgra8unorm-srgb',
      depthFormat: 'depth24plus-stencil8',
      vertexBuffers: [
        {
          arrayStride: 12 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },
            { shaderLocation: 2, offset: 6 * 4, format: 'float32x2' },
            { shaderLocation: 3, offset: 8 * 4, format: 'float32x4' },
          ],
        },
      ] as unknown as readonly GPUVertexBufferLayout[],
    };
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe('buildPipelineForMaterialShader (M9-T01)', () => {
    it('(a) valid call returns Ok(RenderPipeline) and invokes createShaderModule + createRenderPipeline once', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(result.ok).toBe(true);
      expect(mocks.createShaderModule).toHaveBeenCalledTimes(1);
      expect(mocks.createRenderPipeline).toHaveBeenCalledTimes(1);
      // The shader source flows through unchanged.
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(entry.source);
    });

    it('(b) shaderModuleFactory.createShaderModule failure propagates as Result.err(RhiError)', () => {
      const shaderErr = new RhiError({
        code: 'shader-compile-failed',
        expected: 'WGSL compiles',
        hint: 'inspect WGSL source for syntax errors',
      });
      const mocks = makeMocks({
        createShaderModuleResult: err(shaderErr),
      });
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('shader-compile-failed');
      }
      expect(mocks.createRenderPipeline).not.toHaveBeenCalled();
    });

    it('(c) device.createRenderPipeline failure propagates as Result.err(shader-compile-failed)', () => {
      const pipelineErr = new RhiError({
        code: 'shader-compile-failed',
        expected: 'pipeline build succeeds',
        hint: 'check binding layout matches shader bindings',
      });
      const mocks = makeMocks({
        createRenderPipelineResult: err(pipelineErr),
      });
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('shader-compile-failed');
      }
      expect(mocks.createShaderModule).toHaveBeenCalledTimes(1);
      expect(mocks.createRenderPipeline).toHaveBeenCalledTimes(1);
    });

    it('(d) repeated invocations build equivalent pipelines (caller owns cache; helper is pure)', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const r1 = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);
      const r2 = buildPipelineForMaterialShader('my-game::pulse-material', entry, ctx);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // The helper itself does not cache -- each call re-invokes the device.
      expect(mocks.createShaderModule).toHaveBeenCalledTimes(2);
      expect(mocks.createRenderPipeline).toHaveBeenCalledTimes(2);
      // The pipeline descriptor passed to createRenderPipeline carries the
      // pipelineLayout from ctx (charter P4 consistent abstraction: same
      // 4-BGL chain reused across MaterialShader entries).
      const firstDesc = mocks.createRenderPipeline.mock.calls[0]?.[0] as { layout: unknown };
      expect(firstDesc.layout).toBe(ctx.pipelineLayout);
    });

    // ─── w11: entry point parameterization tests (TDD red phase) ──────────

    it('(e) pass with vertexEntry and fragmentEntry uses them as entry points', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::shadow',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        'vs_shadow',
        'fs_shadow',
      );

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        vertex: { entryPoint: string };
        fragment: { entryPoint: string };
      };
      expect(desc.vertex.entryPoint).toBe('vs_shadow');
      expect(desc.fragment.entryPoint).toBe('fs_shadow');
    });

    it('(f) pass without vertexEntry/fragmentEntry defaults to vs_main/fs_main', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader('my-game::default-entry', entry, ctx);

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        vertex: { entryPoint: string };
        fragment: { entryPoint: string };
      };
      expect(desc.vertex.entryPoint).toBe('vs_main');
      expect(desc.fragment.entryPoint).toBe('fs_main');
    });

    // ─── w13: per-pass defines injection tests (TDD red phase) ──────────────

    it('(g) defines={USE_ALPHA_TEST:"1"} prepends #define to shader source', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::alpha-test',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        undefined, // vertexEntry
        undefined, // fragmentEntry
        { USE_ALPHA_TEST: '1' },
      );

      expect(result.ok).toBe(true);
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(`#define USE_ALPHA_TEST 1\n${entry.source}`);
    });

    it('(h) empty defines records inject nothing', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::no-defines',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        undefined, // vertexEntry
        undefined, // fragmentEntry
        {},
      );

      expect(result.ok).toBe(true);
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(entry.source);
    });

    it('(i) multiple defines keys produce multiple #define lines', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const result = buildPipelineForMaterialShader(
        'my-game::multi-defines',
        entry,
        ctx,
        undefined, // renderState
        undefined, // geometry
        undefined, // vertexEntry
        undefined, // fragmentEntry
        { USE_ALPHA_TEST: '1', LIGHT_COUNT: '4' },
      );

      expect(result.ok).toBe(true);
      const shaderArg = mocks.createShaderModule.mock.calls[0]?.[0] as { code: string };
      expect(shaderArg.code).toBe(
        `#define USE_ALPHA_TEST 1\n#define LIGHT_COUNT 4\n${entry.source}`,
      );
    });

    // ─── w1: mask + frontFace pipeline descriptor pass-through (TDD red phase) ─

    it('(k) renderState with frontFace="cw" lands in GPUPrimitiveState.frontFace', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();
      const renderState = {
        frontFace: 'cw' as const,
      } as MaterialRenderState;

      const result = buildPipelineForMaterialShader(
        'my-game::frontface-cw-red',
        entry,
        ctx,
        renderState,
      );

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        primitive: { frontFace?: string };
      };
      expect(desc.primitive.frontFace).toBe('cw');
    });

    it('(l) renderState without new fields defaults to mask=undefined + frontFace=ccw (equiv status quo)', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();
      // omit stencilReadMask / stencilWriteMask / frontFace entirely
      const renderState: MaterialRenderState = { cullMode: 'none' };

      const result = buildPipelineForMaterialShader(
        'my-game::default-fields-red',
        entry,
        ctx,
        renderState,
      );

      expect(result.ok).toBe(true);
      const desc = mocks.createRenderPipeline.mock.calls[0]?.[0] as {
        depthStencil: { stencilReadMask?: number; stencilWriteMask?: number };
        primitive: { frontFace?: string };
      };
      // Mask fields are undefined when not provided (WebGPU defaults to 0xFFFFFFFF internally).
      expect(desc.depthStencil.stencilReadMask).toBeUndefined();
      expect(desc.depthStencil.stencilWriteMask).toBeUndefined();
      // frontFace defaults to 'ccw' (existing hardcoded behavior).
      expect(desc.primitive.frontFace).toBe('ccw');
    });
  });
}
