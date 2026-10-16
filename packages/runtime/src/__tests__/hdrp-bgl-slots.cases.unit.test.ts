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
  // --- from hdrp-bgl-slots.test.ts ---
  const HDRP_BGL_SLOT_LIGHT_DATA = 3;
  const HDRP_BGL_SLOT_CLUSTER_GRID = 4;
  const HDRP_BGL_SLOT_LIGHT_INDEX_LIST = 5;
  const HDRP_BGL_SLOT_CLUSTER_UNIFORM = 6;

  const HDRP_BGL_SLOTS = [
    HDRP_BGL_SLOT_LIGHT_DATA,
    HDRP_BGL_SLOT_CLUSTER_GRID,
    HDRP_BGL_SLOT_LIGHT_INDEX_LIST,
    HDRP_BGL_SLOT_CLUSTER_UNIFORM,
  ] as const;

  // ── cluster_uniform std140 field layout ───────────────────────────────────────

  /**
   * cluster_uniform UBO fields (std140).
   *
   * Declared in WGSL as `@binding(6) var<uniform> cluster_uniform: ClusterUniform;`
   *
   *   [ 0.. 3] gridX           u32  (4 bytes)
   *   [ 4.. 7] gridY           u32  (4 bytes)
   *   [ 8..11] gridZ           u32  (4 bytes)
   *   [12..15] pad1            u32  (4 bytes, std140 vec4 alignment)
   *   [16..19] near            f32  (4 bytes)
   *   [20..23] far             f32  (4 bytes)
   *   [24..27] logFarOverNear  f32  (4 bytes)
   *   [28..31] pad2            u32  (4 bytes, std140 vec4 alignment)
   *   Total: 32 bytes (2 x vec4<u32> in std140)
   */
  const CLUSTER_UNIFORM_LAYOUT = {
    /** Byte size of ClusterUniform in std140 (2 x vec4). */
    byteSize: 32,
    /** Number of f32 slots (8). */
    floatCount: 8,
    /** Byte offset of gridX (first field). */
    gridXOffset: 0,
    /** Byte offset of gridY. */
    gridYOffset: 4,
    /** Byte offset of gridZ. */
    gridZOffset: 8,
    /** Byte offset of near (after first vec4). */
    nearOffset: 16,
    /** Byte offset of far. */
    farOffset: 20,
    /** Byte offset of logFarOverNear. */
    logFarOverNearOffset: 24,
  } as const;

  // ── BGL slot tests ────────────────────────────────────────────────────────────

  describe('HDRP BGL slot allocation', () => {
    it('slot 3 is light_data (storage)', () => {
      expect(HDRP_BGL_SLOT_LIGHT_DATA).toBe(3);
    });

    it('slot 4 is cluster_grid (storage)', () => {
      expect(HDRP_BGL_SLOT_CLUSTER_GRID).toBe(4);
    });

    it('slot 5 is light_index_list (storage)', () => {
      expect(HDRP_BGL_SLOT_LIGHT_INDEX_LIST).toBe(5);
    });

    it('slot 6 is cluster_uniform (uniform)', () => {
      expect(HDRP_BGL_SLOT_CLUSTER_UNIFORM).toBe(6);
    });

    it('slots 0..2 are NOT in HDRP slot set (URP physical isolation)', () => {
      expect(HDRP_BGL_SLOTS).not.toContain(0);
      expect(HDRP_BGL_SLOTS).not.toContain(1);
      expect(HDRP_BGL_SLOTS).not.toContain(2);
    });

    it('all HDRP slots are in [3, 6]', () => {
      for (const slot of HDRP_BGL_SLOTS) {
        expect(slot).toBeGreaterThanOrEqual(3);
        expect(slot).toBeLessThanOrEqual(6);
      }
    });

    it('exactly 4 HDRP slots', () => {
      expect(HDRP_BGL_SLOTS.length).toBe(4);
      expect(new Set(HDRP_BGL_SLOTS).size).toBe(4);
    });
  });

  // ── cluster_uniform field tests ───────────────────────────────────────────────

  describe('ClusterUniform layout', () => {
    it('byteSize is 32 (2 x vec4 in std140)', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.byteSize).toBe(32);
    });

    it('floatCount is 8', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.floatCount).toBe(8);
    });

    it('gridX at byte offset 0', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.gridXOffset).toBe(0);
    });

    it('gridY at byte offset 4', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.gridYOffset).toBe(4);
    });

    it('gridZ at byte offset 8', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.gridZOffset).toBe(8);
    });

    it('near at byte offset 16 (after first vec4)', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.nearOffset).toBe(16);
    });

    it('far at byte offset 20', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.farOffset).toBe(20);
    });

    it('logFarOverNear at byte offset 24', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.logFarOverNearOffset).toBe(24);
    });
  });

  // ── Float32Array representation ───────────────────────────────────────────────

  describe('ClusterUniform Float32Array representation', () => {
    it('Float32Array(8) holds one ClusterUniform (32 bytes)', () => {
      const buf = new Float32Array(8);
      expect(buf.byteLength).toBe(32);
    });
  });
}
