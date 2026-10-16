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
  // --- from hdrp-light-budget.test.ts ---

  // ── Budget gate unit logic (the pure gate w23 will embed) ─────────────────────

  const HDRP_BUDGET = 256;

  function enforceLightBudget(
    totalLightCount: number,
    oncePerFrameFired: Set<string>,
    fire: (code: string, errors: unknown[]) => void,
  ): number {
    if (totalLightCount <= HDRP_BUDGET) {
      return totalLightCount;
    }
    // Truncate to budget.
    const truncated = HDRP_BUDGET;
    if (!oncePerFrameFired.has('hdrp-light-budget-exceeded')) {
      oncePerFrameFired.add('hdrp-light-budget-exceeded');
      fire('hdrp-light-budget-exceeded', [totalLightCount, HDRP_BUDGET]);
    }
    return truncated;
  }

  describe('HDRP light budget enforcement gate (AC-06/AC-07)', () => {
    it('256 lights: no fire, returns 256 (AC-06 boundary)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(256, fired, fireFn);
      expect(result).toBe(256);
      expect(fired.size).toBe(0);
      expect(errors.length).toBe(0);
    });

    it('257 lights: fires once, returns 256 (AC-07 truncation)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(257, fired, fireFn);
      expect(result).toBe(256);
      expect(fired.size).toBe(1);
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(true);
      expect(errors.length).toBe(1);
      expect(errors[0]?.actual).toBe(257);
      expect(errors[0]?.budget).toBe(256);
    });

    it('same-frame subsequent overflow suppressed (warn-once-per-frame-bucket)', () => {
      // Simulate frame already having fired the budget error.
      const fired = new Set<string>(['hdrp-light-budget-exceeded']);
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      // Even with 300 lights on the same frame, it should not fire again.
      const result = enforceLightBudget(300, fired, fireFn);
      expect(result).toBe(256);
      expect(errors.length).toBe(0);
    });

    it('second frame fires again (fresh bucket)', () => {
      // New frame: empty Set.
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(258, fired, fireFn);
      expect(result).toBe(256);
      expect(errors.length).toBe(1);
      expect(errors[0]?.actual).toBe(258);
      expect(errors[0]?.budget).toBe(256);
    });

    it('second frame with exactly 256 does not fire (fresh bucket, under budget)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(256, fired, fireFn);
      expect(result).toBe(256);
      expect(errors.length).toBe(0);
    });

    it('0 lights returns 0 (empty scene, no fire)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(0, fired, fireFn);
      expect(result).toBe(0);
      expect(errors.length).toBe(0);
    });

    it('HDRP_BUDGET constant must be 256 (D-scope anchor)', () => {
      expect(HDRP_BUDGET).toBe(256);
    });
  });

  // ── Integration pattern: once-per-frame Set complements existing hdrpOncePerFrameFired ──

  describe('hdrpOncePerFrameFired Set dedup semantics', () => {
    it('empty set allows first fire', () => {
      const fired = new Set<string>();
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(false);
    });

    it('set with entry suppresses subsequent fires on the same code', () => {
      const fired = new Set<string>(['hdrp-light-budget-exceeded']);
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(true);
    });

    it('hdrp-light-budget-exceeded is independent from hdrp-index-list-overflow', () => {
      const fired = new Set<string>(['hdrp-index-list-overflow']);
      // Budget-exceeded should still fire even if index-list-overflow already fired this frame.
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(false);
      expect(fired.has('hdrp-index-list-overflow')).toBe(true);
    });

    it('clearing the set (new frame) allows re-fire', () => {
      const fired = new Set<string>(['hdrp-light-budget-exceeded']);
      fired.clear();
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(false);
      // The recordFrame entry clears hdrpOncePerFrameFired when frameNumber increments.
      // This test verifies the clear() semantics match the expected new-frame behaviour.
    });
  });
}
