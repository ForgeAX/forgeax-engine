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
  // --- from renderstate-pipeline-cache.test.ts ---
  function renderStateHashSuffix(renderState: MaterialRenderState | undefined): string {
    if (renderState === undefined) return '';
    const sorted = Object.keys(renderState).sort();
    if (sorted.length === 0) return '';
    const payload: Record<string, unknown> = {};
    for (const k of sorted) {
      const v = renderState[k as keyof MaterialRenderState];
      if (v !== undefined) payload[k] = v;
    }
    return `:${JSON.stringify(payload)}`;
  }

  /**
   * Produces the full cache key as build in createRenderer.ts:
   *   `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}${renderStateHashSuffix(renderState)}`
   */
  function cacheKey(
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
  ): string {
    return `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}${renderStateHashSuffix(renderState)}`;
  }

  // ─── Mock helpers (same pattern as material-render-state.test.ts) ───────

  function makeMockEntry() {
    return {
      source: '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
      paramSchema: [
        { name: 'baseColor', type: 'color' },
        { name: 'time', type: 'f32' },
      ],
    };
  }

  function makeMocks() {
    const shaderModule = { __tag: 'mock-shader-module' } as unknown as ShaderModule;
    const renderPipeline = { __tag: 'mock-render-pipeline' } as unknown as RenderPipeline;
    const createShaderModule = vi.fn(() => ({
      ok: true as const,
      value: shaderModule,
      unwrap: () => shaderModule,
      unwrapOr: (_d: unknown) => shaderModule,
    }));
    const createRenderPipeline = vi.fn(() => ({
      ok: true as const,
      value: renderPipeline,
      unwrap: () => renderPipeline,
      unwrapOr: (_d: unknown) => renderPipeline,
    }));
    return {
      factory: { createShaderModule } as unknown as PipelineBuilderShaderModuleFactory,
      device: { createRenderPipeline } as unknown as Pick<RhiDevice, 'createRenderPipeline'>,
      createShaderModule,
      createRenderPipeline,
    };
  }

  function makeMockContext(mocks: ReturnType<typeof makeMocks>): PipelineBuilderContext {
    return {
      device: mocks.device as unknown as RhiDevice,
      shaderModuleFactory: mocks.factory,
      pipelineLayout: { __tag: 'mock-pipeline-layout' } as unknown as PipelineLayout,
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

  // ─── AC-01 / AC-02 / AC-03: Cache key determinism (white-box) ──────────

  describe('renderState pipeline cache key (AC-01/02/03)', () => {
    it('(a) AC-01: same renderState produces identical cache key (deterministic hash)', () => {
      const rs: MaterialRenderState = {
        cullMode: 'none',
        depthCompare: 'always',
        depthWriteEnabled: false,
      };

      const k1 = cacheKey('my-game::ghost-material', false, rs);
      const k2 = cacheKey('my-game::ghost-material', false, { ...rs });

      expect(k1).toBe(k2);
    });

    it('(a) AC-01: cache key is stable across different key declaration orders', () => {
      // Object.keys sort ensures key order doesn't matter.
      const rs1: MaterialRenderState = { cullMode: 'none', depthCompare: 'always' };
      const rs2: MaterialRenderState = { depthCompare: 'always', cullMode: 'none' };

      expect(cacheKey('my-game::a', false, rs1)).toBe(cacheKey('my-game::a', false, rs2));
    });

    it('(a) AC-01: undefined fields are excluded from the hash payload', () => {
      const rs1: MaterialRenderState = { cullMode: 'none' };
      const rs2 = { cullMode: 'none', depthCompare: undefined } as unknown as MaterialRenderState;

      expect(cacheKey('my-game::a', false, rs1)).toBe(cacheKey('my-game::a', false, rs2));
    });

    it('(b) AC-02: different renderState produces different cache keys', () => {
      const rsA: MaterialRenderState = { cullMode: 'none' };
      const rsB: MaterialRenderState = { cullMode: 'front' };
      const rsC: MaterialRenderState = { depthWriteEnabled: false };
      const rsD: MaterialRenderState = { cullMode: 'none', depthCompare: 'never' };

      const keyA = cacheKey('my-game::pulse', false, rsA);
      const keyB = cacheKey('my-game::pulse', false, rsB);
      const keyC = cacheKey('my-game::pulse', false, rsC);
      const keyD = cacheKey('my-game::pulse', false, rsD);

      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyC);
      expect(keyA).not.toBe(keyD);
      expect(keyB).not.toBe(keyC);
    });

    it('(b) AC-02: different renderState yields different full cache key from same base', () => {
      const withCull: MaterialRenderState = { cullMode: 'none' };
      const withoutCull: MaterialRenderState = {};

      const kWith = cacheKey('forgeax::default-pbr', true, withCull);
      const kWithout = cacheKey('forgeax::default-pbr', true, withoutCull);

      expect(kWith).not.toBe(kWithout);
    });

    it('(c) AC-03: undefined renderState produces same cache key as before (backward compat)', () => {
      // The cache key for undefined renderState must equal the pre-bugfix key
      // (materialShaderId + ':hdr' or ':ldr' with no suffix).
      const kUndef1 = cacheKey('forgeax::default-pbr', false, undefined);
      const kUndef2 = cacheKey('forgeax::default-pbr', false, undefined);

      // Two calls with undefined renderState produce identical keys (idempotent).
      expect(kUndef1).toBe(kUndef2);

      // The key must match the legacy format (no suffix appended).
      expect(kUndef1).toBe('forgeax::default-pbr:ldr');
    });

    it('(c) AC-03: undefined renderState cache key equals pre-fix key for HDR too', () => {
      expect(cacheKey('forgeax::default-pbr', true, undefined)).toBe('forgeax::default-pbr:hdr');
    });

    it('(c) AC-03: undefined renderState does not collide with empty-object renderState', () => {
      const kUndef = cacheKey('my-game::x', false, undefined);
      const kEmpty = cacheKey('my-game::x', false, {});

      // Both produce the same key since empty object has no keys.
      // renderStateHashSuffix({}) returns '' (sorted.length === 0).
      // renderStateHashSuffix(undefined) returns ''.
      // Both → 'my-game::x:ldr' — same key, same pipeline.
      expect(kUndef).toBe(kEmpty);
    });

    it('renderStateHashSuffix returns empty string for undefined', () => {
      expect(renderStateHashSuffix(undefined)).toBe('');
    });

    it('renderStateHashSuffix returns empty string for empty object', () => {
      expect(renderStateHashSuffix({})).toBe('');
    });

    it('renderStateHashSuffix includes all supplied keys sorted', () => {
      const rs: MaterialRenderState = {
        depthWriteEnabled: false,
        cullMode: 'none',
      };
      const suffix = renderStateHashSuffix(rs);
      // Keys must be sorted → cullMode before depthWriteEnabled.
      expect(suffix).toBe(`:${JSON.stringify({ cullMode: 'none', depthWriteEnabled: false })}`);
    });
  });

  // ─── AC-08: buildPipelineForMaterialShader respects renderState ─────────

  describe('buildPipelineForMaterialShader renderState plumbing (AC-08)', () => {
    it('(d) AC-08: custom cullMode reaches createRenderPipeline descriptor', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const rs: MaterialRenderState = { cullMode: 'none' };
      buildPipelineForMaterialShader('test::no-cull', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const primitive = desc.primitive as { cullMode: string };
      expect(primitive.cullMode).toBe('none');
    });

    it('(d) AC-08: custom depthCompare reaches createRenderPipeline descriptor', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const rs: MaterialRenderState = { depthCompare: 'always' };
      buildPipelineForMaterialShader('test::always-depth', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const depthStencil = desc.depthStencil as { depthCompare: string };
      expect(depthStencil.depthCompare).toBe('always');
    });

    it('(d) AC-08: depthWriteEnabled false reaches createRenderPipeline descriptor', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const rs: MaterialRenderState = { depthWriteEnabled: false };
      buildPipelineForMaterialShader('test::no-depth-write', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const depthStencil = desc.depthStencil as { depthWriteEnabled: boolean };
      expect(depthStencil.depthWriteEnabled).toBe(false);
    });

    it('(d) AC-08: custom blend reaches createRenderPipeline descriptor via color target', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      const blend: GPUBlendState = {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
      const rs: MaterialRenderState = { blend };
      buildPipelineForMaterialShader('test::blend', entry, ctx, rs);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const fragment = desc.fragment as { targets: Array<{ blend?: GPUBlendState }> };
      expect(fragment.targets[0]?.blend).toEqual(blend);
    });

    it('(d) AC-08: undefined renderState falls back to engine defaults', () => {
      const mocks = makeMocks();
      const ctx = makeMockContext(mocks);
      const entry = makeMockEntry();

      buildPipelineForMaterialShader('test::defaults', entry, ctx);

      const desc = (mocks.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const primitive = desc.primitive as { cullMode: string };
      expect(primitive.cullMode).toBe('back');

      const depthStencil = desc.depthStencil as {
        depthCompare: string;
        depthWriteEnabled: boolean;
      };
      expect(depthStencil.depthCompare).toBe('greater');
      expect(depthStencil.depthWriteEnabled).toBe(true);
    });

    it('(d) AC-08: two calls with different renderState produce different pipeline descriptors', () => {
      const mocks1 = makeMocks();
      const ctx1 = makeMockContext(mocks1);
      const entry1 = makeMockEntry();
      buildPipelineForMaterialShader('test::cull-back', entry1, ctx1, { cullMode: 'back' });

      const mocks2 = makeMocks();
      const ctx2 = makeMockContext(mocks2);
      const entry2 = makeMockEntry();
      buildPipelineForMaterialShader('test::cull-none', entry2, ctx2, { cullMode: 'none' });

      const desc1 = (mocks1.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;
      const desc2 = (mocks2.createRenderPipeline.mock.calls as unknown[][])[0]?.[0] as Record<
        string,
        unknown
      >;

      const prim1 = desc1.primitive as { cullMode: string };
      const prim2 = desc2.primitive as { cullMode: string };
      expect(prim1.cullMode).toBe('back');
      expect(prim2.cullMode).toBe('none');
      expect(prim1.cullMode).not.toBe(prim2.cullMode);
    });
  });
}
