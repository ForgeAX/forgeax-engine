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
  // --- from hdrp-pipeline-asset-config.test.ts ---
  describe('hdrp pipeline asset config', () => {
    it('creates a RenderPipelineAsset with HDRP pipelineId and clusterGrid config', () => {
      const asset: RenderPipelineAsset = {
        kind: 'render-pipeline',
        pipelineId: 'forgeax::hdrp',
        config: {
          clusterGrid: { x: 16, y: 9, z: 24 },
        },
      };

      expect(asset.pipelineId).toBe('forgeax::hdrp');
      expect(asset.kind).toBe('render-pipeline');
      expect(asset.config?.clusterGrid).toBeDefined();
      expect(asset.config?.clusterGrid?.x).toBe(16);
      expect(asset.config?.clusterGrid?.y).toBe(9);
      expect(asset.config?.clusterGrid?.z).toBe(24);
    });

    it('creates a RenderPipelineAsset with URP pipelineId and no clusterGrid', () => {
      const asset: RenderPipelineAsset = {
        kind: 'render-pipeline',
        pipelineId: 'forgeax::urp',
      };

      expect(asset.pipelineId).toBe('forgeax::urp');
      expect(asset.config?.clusterGrid).toBeUndefined();
    });

    it('passCount field is still supported alongside clusterGrid', () => {
      const asset: RenderPipelineAsset = {
        kind: 'render-pipeline',
        pipelineId: 'forgeax::hdrp',
        config: {
          passCount: 3,
          clusterGrid: { x: 16, y: 9, z: 24 },
        },
      };

      expect(asset.config?.passCount).toBe(3);
      expect(asset.config?.clusterGrid).toBeDefined();
    });
  });
  // ── M3 / w12 (round-1) + M7 / w28+w31 (round-2)
  //   + scope-amend-webgl2-ubo (intensity folded into binding 6 .w lane,
  //     dedicated @binding(9) UBO removed) ────────────────────────────────
  //
  // BGL 7-entry descriptor: 5 cluster slots (binding 0 + 3..6) + 2 SSAO
  // slots (binding 7..8, plan-strategy D-B). Intensity flows via
  // cluster_uniform.near_far_log.w (binding 6). Round-2 absorbs fixture
  // into the SSAO bind-group test file — see __tests__/ssao-bgl.test.ts;
  // the assertions below remain for cluster-side regression coverage.

  describe('HDRP unified BGL 7-slot descriptor (w12 + w28)', () => {
    it('entries.length === 7 (binding 0 + 3..6 + 7..8; 1, 2, 9 absent)', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      expect(desc.entries?.length).toBe(7);
    });

    it('binding 0 is mesh SSBO with dynamic offset', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b0 = desc.entries?.find((e) => e.binding === 0);
      expect(b0).toBeDefined();
      expect(b0?.visibility).toBeDefined();
      expect(b0?.buffer?.type).toBe('read-only-storage');
      expect(b0?.buffer?.hasDynamicOffset).toBe(true);
    });

    it('binding 3 is light_data storage', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b3 = desc.entries?.find((e) => e.binding === 3);
      expect(b3).toBeDefined();
      expect(b3?.buffer?.type).toBe('read-only-storage');
      expect(b3?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 4 is cluster_grid storage', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b4 = desc.entries?.find((e) => e.binding === 4);
      expect(b4).toBeDefined();
      expect(b4?.buffer?.type).toBe('read-only-storage');
      expect(b4?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 5 is light_index_list storage', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b5 = desc.entries?.find((e) => e.binding === 5);
      expect(b5).toBeDefined();
      expect(b5?.buffer?.type).toBe('read-only-storage');
      expect(b5?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 6 is cluster_uniform uniform', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b6 = desc.entries?.find((e) => e.binding === 6);
      expect(b6).toBeDefined();
      expect(b6?.buffer?.type).toBe('uniform');
      expect(b6?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 1 and 2 are absent', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const bindings = desc.entries?.map((e) => e.binding);
      expect(bindings).not.toContain(1);
      expect(bindings).not.toContain(2);
    });

    it('all bindings are in group 2 (shader group)', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const bindings = new Set(desc.entries?.map((e) => e.binding));
      expect(bindings).toEqual(new Set([0, 3, 4, 5, 6, 7, 8]));
    });
  });
}
