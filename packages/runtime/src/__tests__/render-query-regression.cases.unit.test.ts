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
  // --- from render-query-regression.test.ts ---
  const MATERIAL_SENTINEL = 0 as unknown as Handle<'MaterialAsset', 'shared'>;

  describe('Bug 1: registerComponent before spawn does not break render query', () => {
    it('entities are included in renderables when an unrelated component is pre-registered', () => {
      const world = new World();

      defineComponent('Bug1Unrelated', { value: 'f32' });

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [MATERIAL_SENTINEL] } },
        )
        .unwrap();

      const frame = extractFrame(world, prepareExtractContext(world, { cull: 'none' }));
      expect(frame.renderables.length).toBe(1);
    });

    it('query still matches when the render component itself is pre-registered', () => {
      const world = new World();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [MATERIAL_SENTINEL] } },
        )
        .unwrap();

      const frame = extractFrame(world, prepareExtractContext(world, { cull: 'none' }));
      expect(frame.renderables.length).toBe(1);
    });
  });

  describe('Bug 2: ChildOf entities are included in renderables', () => {
    it('entity with ChildOf + Transform + MeshFilter + MeshRenderer is rendered', () => {
      const world = new World();

      const parent = world
        .spawn({
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        })
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [MATERIAL_SENTINEL] } },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();

      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.renderables.length).toBe(1);
    });

    it('multiple ChildOf entities all appear in renderables', () => {
      const world = new World();

      const parent = world
        .spawn({
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        })
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();

      for (let n = 0; n < 3; n++) {
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [n, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
            { component: MeshRenderer, data: { materials: [MATERIAL_SENTINEL] } },
            { component: ChildOf, data: { parent } },
          )
          .unwrap();
      }

      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.renderables.length).toBe(3);
    });
  });

  describe('Bug 3: unlit material renders without DirectionalLight', () => {
    it('extractFrame returns renderables for unlit entities even with zero lights', () => {
      const world = new World();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [MATERIAL_SENTINEL] } },
        )
        .unwrap();

      const frame = extractFrame(world, prepareExtractContext(world));
      // No lights spawned - but unlit material should still produce renderables.
      expect(frame.lights.directional).toBeUndefined();
      expect(frame.lights.directionalCount).toBe(0);
      expect(frame.renderables.length).toBe(1);
    });

    it('extractFrame does not early-return when no light entity exists', () => {
      const world = new World();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
        )
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [MATERIAL_SENTINEL] } },
        )
        .unwrap();

      world
        .spawn(
          {
            component: Transform,
            data: { pos: [2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: { materials: [MATERIAL_SENTINEL] } },
        )
        .unwrap();

      const frame = extractFrame(world, prepareExtractContext(world));
      expect(frame.renderables.length).toBe(2);
      expect(frame.cameras.length).toBe(1);
    });
  });
}
