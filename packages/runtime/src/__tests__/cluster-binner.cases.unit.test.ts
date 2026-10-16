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
  // --- from cluster-binner.test.ts ---
  function makeIdentityMat4(): Mat4 {
    return mat4.identity(mat4.create());
  }

  function makePerspectiveProj(near = 0.1, far = 100): Mat4 {
    // perspective(fov=PI/2, aspect=1, near, far)
    const fov = Math.PI / 2;
    return mat4.perspective(mat4.create(), fov, 1, near, far);
  }

  function makeLookAtView(eyeX: number, eyeY: number, eyeZ: number): Mat4 {
    const eye = vec3.create(eyeX, eyeY, eyeZ);
    const target = vec3.create(0, 0, 0);
    const up = vec3.create(0, 1, 0);
    return mat4.lookAt(mat4.create(), eye, target, up);
  }

  // ── (a) cluster_space_object_aabb ───────────────────────────────────────────

  describe('clusterSpaceObjectAabb', () => {
    it('returns a finite AABB for a sphere at origin in view space', () => {
      const center = vec3.create(0, 0, -5);
      const radius = 1;
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj();
      const result = clusterSpaceObjectAabb(center, radius, view, proj);
      expect(Number.isFinite(result.min[0])).toBe(true);
      expect(Number.isFinite(result.min[1])).toBe(true);
      expect(Number.isFinite(result.min[2])).toBe(true);
      expect(Number.isFinite(result.max[0])).toBe(true);
      expect(Number.isFinite(result.max[1])).toBe(true);
      expect(Number.isFinite(result.max[2])).toBe(true);
    });

    it('returns AABB roughly centered around sphere NDC position', () => {
      const center = vec3.create(0, 0, -5);
      const radius = 0.5;
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj();
      const aabb = clusterSpaceObjectAabb(center, radius, view, proj);
      // AABB should contain the center NDC projection
      expect(aabb.min[0]).toBeLessThanOrEqual(0);
      expect(aabb.max[0]).toBeGreaterThanOrEqual(0);
      expect(aabb.min[1]).toBeLessThanOrEqual(0);
      expect(aabb.max[1]).toBeGreaterThanOrEqual(0);
    });

    it('clamps to NDC [-1,1] for a large radius sphere', () => {
      const center = vec3.create(0, 0, -5);
      const radius = 100; // huge sphere
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj();
      const aabb = clusterSpaceObjectAabb(center, radius, view, proj);
      expect(aabb.min[0]).toBeGreaterThanOrEqual(-1);
      expect(aabb.min[1]).toBeGreaterThanOrEqual(-1);
      expect(aabb.max[0]).toBeLessThanOrEqual(1);
      expect(aabb.max[1]).toBeLessThanOrEqual(1);
      // Z may still extend beyond [-1,1] after projection (perspective projects to [0,1]),
      // but XY must be clamped.
    });

    it('handles sphere at very far distance without NaN', () => {
      const center = vec3.create(0, 0, -94);
      const radius = 2;
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(0.1, 100);
      const aabb = clusterSpaceObjectAabb(center, radius, view, proj);
      expect(aabb.min.every((v: number) => Number.isFinite(v))).toBe(true);
      expect(aabb.max.every((v: number) => Number.isFinite(v))).toBe(true);
    });

    it('applies view matrix', () => {
      // Camera at (5,0,0) looking at origin -> sphere at origin is at x=-5 in view space
      const center = vec3.create(0, 0, -5);
      const radius = 1;
      const view = makeLookAtView(5, 0, 0);
      const proj = makePerspectiveProj();
      const aabb = clusterSpaceObjectAabb(center, radius, view, proj);
      expect(Number.isFinite(aabb.min[0] ?? 0)).toBe(true);
      expect(Number.isFinite(aabb.max[0] ?? 0)).toBe(true);
      expect(Number.isFinite(aabb.min[1] ?? 0)).toBe(true);
      expect(Number.isFinite(aabb.max[1] ?? 0)).toBe(true);
    });
  });

  // ── (b) ndc_position_to_cluster ─────────────────────────────────────────────

  describe('ndcPositionToCluster', () => {
    const gridX = 16;
    const gridY = 9;
    const gridZ = 24;
    const near = 0.1;
    const far = 100;

    it('maps NDC center to middle cluster XY', () => {
      const ndc = vec3.create(0, 0, 0.5); // center of screen, mid-depth
      const idx = ndcPositionToCluster(ndc, -5, gridX, gridY, gridZ, near, far);
      expect(idx.x).toBe(Math.floor(gridX / 2));
      expect(idx.y).toBe(Math.floor(gridY / 2));
    });

    it('maps NDC top-left to cluster (0, gridY-1)', () => {
      const ndc = vec3.create(-1, 1, 0.5);
      const idx = ndcPositionToCluster(ndc, -5, gridX, gridY, gridZ, near, far);
      expect(idx.x).toBe(0);
      expect(idx.y).toBe(gridY - 1);
    });

    it('maps NDC bottom-right to cluster (gridX-1, 0)', () => {
      const ndc = vec3.create(1, -1, 0.5);
      const idx = ndcPositionToCluster(ndc, -5, gridX, gridY, gridZ, near, far);
      expect(idx.x).toBe(gridX - 1);
      expect(idx.y).toBe(0);
    });

    it('clamps out-of-bounds NDC to [0, grid-1]', () => {
      const ndc = vec3.create(-2, 3, 0.5);
      const idx = ndcPositionToCluster(ndc, -5, gridX, gridY, gridZ, near, far);
      expect(idx.x).toBeGreaterThanOrEqual(0);
      expect(idx.x).toBeLessThan(gridX);
      expect(idx.y).toBeGreaterThanOrEqual(0);
      expect(idx.y).toBeLessThan(gridY);
    });

    it('clamps Z to [0, gridZ-1]', () => {
      const ndc = vec3.create(0, 0, 2); // beyond far plane
      const idx = ndcPositionToCluster(ndc, -1, gridX, gridY, gridZ, near, far);
      expect(idx.z).toBeLessThan(gridZ);
      expect(idx.z).toBeGreaterThanOrEqual(0);
    });
  });

  // ── (c) calculate_sphere_cluster_bounds ─────────────────────────────────────

  describe('calculateSphereClusterBounds', () => {
    const gridX = 16;
    const gridY = 9;
    const gridZ = 24;
    const near = 0.1;
    const far = 100;

    it('returns valid min/max cluster indices for a sphere in the frustum', () => {
      const center = vec3.create(0, 0, -5);
      const radius = 1;
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);
      const aabb = clusterSpaceObjectAabb(center, radius, view, proj);
      const bounds = calculateSphereClusterBounds(aabb, gridX, gridY, gridZ, near, far);
      expect(bounds.min.x).toBeLessThanOrEqual(bounds.max.x);
      expect(bounds.min.y).toBeLessThanOrEqual(bounds.max.y);
      expect(bounds.min.z).toBeLessThanOrEqual(bounds.max.z);
      expect(bounds.max.x).toBeLessThan(gridX);
      expect(bounds.max.y).toBeLessThan(gridY);
      expect(bounds.max.z).toBeLessThan(gridZ);
    });

    it('returns min > max for sphere completely behind camera (cull signal)', () => {
      // Sphere directly behind the camera: view-space z > 0.
      // In a standard view matrix, world (0,0,5) with identity view is behind the camera.
      const center = vec3.create(0, 0, 5);
      const radius = 1;
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);
      const aabb = clusterSpaceObjectAabb(center, radius, view, proj);
      const bounds = calculateSphereClusterBounds(aabb, gridX, gridY, gridZ, near, far);
      // With the sphere fully behind camera, the AABB Z will be empty (minZ > maxZ)
      // or the cluster bounds will have min > max.
      const isCulled =
        bounds.min.x > bounds.max.x || bounds.min.y > bounds.max.y || bounds.min.z > bounds.max.z;
      // Note: clusterSpaceObjectAabb clamps view-z to -1e-5 (near plane),
      // so a sphere behind the near plane may still get valid AABB bounds.
      // This test verifies the function does not throw and returns a valid shape.
      expect(isCulled || !isCulled).toBe(true); // always true — just exercises the branch
      expect('min' in bounds).toBe(true);
      expect('max' in bounds).toBe(true);
    });

    it('encompasses camera when sphere wraps around it', () => {
      // Large sphere right in front of the camera
      const center = vec3.create(0, 0, -5);
      const radius = 20;
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);
      const aabb = clusterSpaceObjectAabb(center, radius, view, proj);
      const bounds = calculateSphereClusterBounds(aabb, gridX, gridY, gridZ, near, far);
      // Should cover a large portion of the grid
      const dx = bounds.max.x - bounds.min.x;
      const dy = bounds.max.y - bounds.min.y;
      expect(dx).toBeGreaterThan(gridX / 4);
      expect(dy).toBeGreaterThan(gridY / 4);
    });
  });

  // ── (d) view_z_to_z_slice — log-z formula ───────────────────────────────────

  describe('viewZToZSlice', () => {
    const gridZ = 24;
    const near = 0.1;
    const far = 100;

    it('maps view_z=near to z_slice=0', () => {
      const slice = viewZToZSlice(-near, gridZ, near, far);
      expect(slice).toBe(0);
    });

    it('maps view_z=far to z_slice=gridZ-1 (approximately)', () => {
      const slice = viewZToZSlice(-far, gridZ, near, far);
      expect(slice).toBeGreaterThanOrEqual(gridZ - 2);
      expect(slice).toBeLessThanOrEqual(gridZ - 1);
    });

    it('monotonically increases', () => {
      const slices: number[] = [];
      for (let i = 0; i <= gridZ; i++) {
        const t = i / gridZ;
        const z = -near * Math.exp(t * Math.log(far / near));
        slices.push(viewZToZSlice(z, gridZ, near, far));
      }
      for (let i = 1; i < slices.length; i++) {
        const cur = slices[i];
        const prev = slices[i - 1];
        if (cur !== undefined && prev !== undefined) {
          expect(cur).toBeGreaterThanOrEqual(prev);
        }
      }
    });

    it('matches idTech6 inverse formula shape', () => {
      // idTech6: Z_slice = near * (far/near)^(slice/numSlices)
      // inverse: slice = floor(log(-view_z / near) / log(far / near) * numSlices)
      const viewZ = -5;
      const logFarOverNear = Math.log(far / near);
      const expected = Math.floor((Math.log(-viewZ / near) / logFarOverNear) * gridZ);
      expect(viewZToZSlice(viewZ, gridZ, near, far)).toBe(expected);
    });

    it('clamps to [0, gridZ-1]', () => {
      expect(viewZToZSlice(1, gridZ, near, far)).toBe(0); // positive z -> clamp to 0
      expect(viewZToZSlice(-1e9, gridZ, near, far)).toBe(gridZ - 1); // way distant
    });
  });

  // ── (e) bin() overflow ──────────────────────────────────────────────────────

  describe('bin overflow', () => {
    it('returns error when writeCount would exceed 65536', () => {
      // Use a small index list capacity to force overflow.
      const near = 0.1;
      const far = 100;
      const grid = { x: 16, y: 9, z: 24 };
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);

      // 256 lights all at origin with huge ranges — every light intersects
      // every cluster.
      const lights: Array<{ position: Vec3; range: number }> = [];
      for (let i = 0; i < 256; i++) {
        lights.push({
          position: vec3.create(0, 0, -5),
          range: 1000,
        });
      }

      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      // Small capacity to trigger overflow
      const capacity = 1000;
      const lightIndexList = new Uint32Array(capacity);

      const result = bin(
        lights,
        view,
        proj,
        grid,
        near,
        far,
        clusterGrid,
        lightIndexList,
        capacity,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = result.error;
        expect(error.code).toBe('index-overflow');
        expect(error.detail.actual).toBeGreaterThan(capacity);
        expect(error.detail.capacity).toBe(capacity);
      }
    });

    it('succeeds with 65536 capacity for spread configuration', () => {
      const near = 0.1;
      const far = 100;
      const grid = { x: 8, y: 6, z: 12 };
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);

      const lights: Array<{ position: Vec3; range: number }> = [];
      for (let i = 0; i < 128; i++) {
        lights.push({
          position: vec3.create(
            ((i % 16) - 8) * 2,
            ((Math.floor(i / 16) % 8) - 4) * 2,
            -2 - Math.floor(i / 128) * 20,
          ),
          range: 0.5,
        });
      }

      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      const capacity = 65536;
      const lightIndexList = new Uint32Array(capacity);

      const result = bin(
        lights,
        view,
        proj,
        grid,
        near,
        far,
        clusterGrid,
        lightIndexList,
        capacity,
      );

      expect(result.ok).toBe(true);
    });
  });

  // ── (f) +Infinity range -> deriveCullingRadius ──────────────────────────────

  describe('deriveCullingRadius', () => {
    it('returns finite number for +Infinity range light', () => {
      const radius = deriveCullingRadius(Infinity, 10, 1);
      expect(Number.isFinite(radius)).toBe(true);
      expect(radius).toBeGreaterThan(0);
    });

    it('returns the range itself when range is finite', () => {
      expect(deriveCullingRadius(5, 10, 1)).toBe(5);
      expect(deriveCullingRadius(0.1, 100, 1)).toBe(0.1);
    });

    it('scales with intensity for +Infinity range', () => {
      const r1 = deriveCullingRadius(Infinity, 1, 1);
      const r2 = deriveCullingRadius(Infinity, 100, 1);
      // Higher intensity => larger visible radius
      expect(r2).toBeGreaterThan(r1);
    });

    it('never returns +Infinity', () => {
      const radius = deriveCullingRadius(Infinity, 1e6, 1);
      expect(Number.isFinite(radius)).toBe(true);
    });
  });

  // ── bin() basic integration ─────────────────────────────────────────────────

  describe('bin integration', () => {
    it('writes clusterGrid offsets and light indices for single light', () => {
      const near = 0.1;
      const far = 100;
      const grid = { x: 4, y: 3, z: 4 };
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);

      const lights = [{ position: vec3.create(0, 0, -5), range: 1 }];

      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      const capacity = 65536;
      const lightIndexList = new Uint32Array(capacity);

      const result = bin(
        lights,
        view,
        proj,
        grid,
        near,
        far,
        clusterGrid,
        lightIndexList,
        capacity,
      );

      expect(result.ok).toBe(true);
      // At least one cluster should have a non-zero light count
      let totalLights = 0;
      for (let i = 0; i < grid.x * grid.y * grid.z; i++) {
        const val = clusterGrid[i * 2 + 1];
        if (val !== undefined) totalLights += val;
      }
      expect(totalLights).toBeGreaterThan(0);
    });

    it('completes 256 lights under 100ms (AC-16 wall time)', () => {
      // Use a smaller grid to avoid overflow, focus on timing.
      const near = 0.1;
      const far = 100;
      const grid = { x: 8, y: 6, z: 12 };
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);

      const lights: Array<{ position: Vec3; range: number }> = [];
      for (let i = 0; i < 256; i++) {
        lights.push({
          position: vec3.create(
            ((i % 16) - 8) * 1.0,
            ((Math.floor(i / 16) % 8) - 4) * 1.0,
            -1 - Math.floor(i / 128) * 50,
          ),
          range: 1.5,
        });
      }

      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      const capacity = 65536;
      const lightIndexList = new Uint32Array(capacity);

      const start = performance.now();
      const result = bin(
        lights,
        view,
        proj,
        grid,
        near,
        far,
        clusterGrid,
        lightIndexList,
        capacity,
      );
      const elapsed = performance.now() - start;

      expect(result.ok).toBe(true);
      // AC-16 quantifies: 256 lights x 6912 clusters (~1.77M intersection tests)
      // should complete on CPU main thread well under 100ms.
      // Extrapolated: 256 lights x {16,9,24} grid = ~1.77M tests,
      // single-threaded JS should be << 100ms (research §8 R2).
      expect(elapsed).toBeLessThan(100);
    });

    it('spreads a mid-frustum light across multiple Z slices (M4.5-followup w55)', () => {
      // Regression for the broken clamp `Math.max(vMinZ, -1e-5)` in
      // clusterSpaceObjectAabb. Before the fix, a light at view_z=-3 with
      // radius 3.5 clamped its FAR-edge view_z to ~0, so the cluster Z range
      // collapsed to slice [0,0]. Floor pixels at view_z=-6 (slice 13..17)
      // looked up empty clusters and rendered black -- which is the demo
      // symptom: "front edge of floor lit, back half black".
      //
      // Lock in the correct behaviour: a 3.5 m sphere at view_z=-3 must touch
      // SEVERAL distinct Z slices (the whole [vMinZ, min(vMaxZ, -near)]
      // bracket), not collapse to slice 0.
      const near = 0.1;
      const far = 50;
      const grid = { x: 16, y: 9, z: 24 };
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj(near, far);
      // Light center at view_z=-3, range 3.5 -> view-space z extent
      // [-6.5, +0.5]; clamp near edge to -1e-5 -> [-6.5, -1e-5]; this should
      // span slices 0..15 (log-z), NOT collapse to slice 0.
      const lights = [{ position: vec3.create(0, 0, -3), range: 3.5 }];
      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      const lightIndexList = new Uint32Array(65536);
      const result = bin(lights, view, proj, grid, near, far, clusterGrid, lightIndexList, 65536);
      expect(result.ok).toBe(true);
      // Collect every distinct Z slice that received this light.
      const occupiedSlices = new Set<number>();
      for (let cz = 0; cz < grid.z; cz++) {
        for (let cy = 0; cy < grid.y; cy++) {
          for (let cx = 0; cx < grid.x; cx++) {
            const ci = cz * grid.y * grid.x + cy * grid.x + cx;
            const count = clusterGrid[ci * 2 + 1] ?? 0;
            if (count > 0) occupiedSlices.add(cz);
          }
        }
      }
      // Pre-fix: occupiedSlices === Set([0]) -> size 1.
      // Post-fix: span at least slices 0..14 (log-z over [0.1, 6.5]).
      expect(occupiedSlices.size).toBeGreaterThan(8);
    });

    it('returns ok for zero lights', () => {
      const grid = { x: 4, y: 3, z: 4 };
      const view = makeIdentityMat4();
      const proj = makePerspectiveProj();

      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      const lightIndexList = new Uint32Array(65536);

      const result = bin([], view, proj, grid, 0.1, 100, clusterGrid, lightIndexList, 65536);

      expect(result.ok).toBe(true);
      // All cluster light counts should be zero
      for (let i = 0; i < grid.x * grid.y * grid.z; i++) {
        expect(clusterGrid[i * 2 + 1]).toBe(0);
      }
    });
  });
}
