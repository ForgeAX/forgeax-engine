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

// Split source block: GPU residency device resource contract.
{
  // --- from device/gpu-residency.test.ts (__tests__/) ---
  const okShim = <T>(v: T) => ({ ok: true as const, value: v });

  interface DeviceProbe {
    buffers: number;
    textures: number;
    views: number;
    submits: number;
  }

  // Minimal mock device covering the mesh-buffer + texture + mipmap-pipeline
  // surfaces the store exercises. Distinct opaque objects per create call so
  // reference-equality assertions (cache hit reuse) are meaningful.
  // biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
  function makeMockDevice(probe: DeviceProbe): any {
    const makePass = () => ({
      setPipeline: () => {},
      setBindGroup: () => {},
      setVertexBuffer: () => {},
      draw: () => {},
      end: () => {},
    });
    return {
      createShaderModule: () => okShim({ __mock: 'shader' }),
      createSampler: () => okShim({ __mock: 'sampler' }),
      createBindGroupLayout: () => okShim({ __mock: 'bgl' }),
      createPipelineLayout: () => okShim({ __mock: 'layout' }),
      createRenderPipeline: () => okShim({ __mock: `pipeline-${probe.views}` }),
      createBindGroup: () => okShim({ __mock: 'bindGroup' }),
      createBuffer: (desc: { size?: number }) => {
        probe.buffers += 1;
        return okShim({ __mock: `buffer-${probe.buffers}`, size: desc.size ?? 0 });
      },
      createTexture: () => {
        probe.textures += 1;
        return okShim({ __mock: `texture-${probe.textures}` });
      },
      createTextureView: () => {
        probe.views += 1;
        return okShim({ __mock: `view-${probe.views}` });
      },
      createCommandEncoder: () =>
        okShim({
          beginRenderPass: () => makePass(),
          finish: () => okShim({ __mock: 'commandBuffer' }),
        }),
      queue: {
        writeBuffer: () => okShim(undefined),
        writeTexture: () => okShim(undefined),
        submit: () => {
          probe.submits += 1;
          return okShim(undefined);
        },
      },
    };
  }

  function freshProbe(): DeviceProbe {
    return { buffers: 0, textures: 0, views: 0, submits: 0 };
  }

  // biome-ignore lint/suspicious/noExplicitAny: shader-module factory shim
  const shaderFactory = async (_d: any, desc: { code: string; label?: string }) =>
    rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as never;

  const mockCaps: RhiCaps = {
    backendKind: 'webgpu',
    compute: true,
    timestampQuery: false,
    timestampPeriodNanoseconds: null,
    indirectDrawing: false,
    textureCompressionBc: false,
    textureCompressionEtc2: false,
    textureCompressionAstc: false,
    multiDrawIndirect: false,
    pushConstants: false,
    textureBindingArray: false,
    samplerAliasing: false,
    firstInstanceIndirect: false,
    storageBuffer: true,
    storageTexture: false,
    rgba16floatRenderable: true,
    rg11b10ufloatRenderable: false,
    float32Filterable: false,
    textureImport: false,
    externalTexture: false,
  };

  // A registerCube relay that mints sequential cube handles without a registry.
  function makeRegisterCube(): (
    pod: EquirectAsset,
  ) => Result<Handle<'EquirectAsset', 'shared'>, AssetError> {
    let next = 1000;
    return () => rhiOk(toShared<'EquirectAsset'>(next++));
  }

  function meshPod(verts = 4): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(verts * 12),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
      attributes: buildMeshAttributeMapForUvSets(1),
      aabb: new Float32Array(6),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 6,
          vertexCount: 0,
          topology: 'triangle-list',
        },
      ],
    };
  }

  function texturePod(mipmap: boolean, format: GPUTextureFormat = 'rgba8unorm-srgb'): TextureAsset {
    return {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      format,
      data: new Uint8Array(2 * 2 * 4).fill(188),
      colorSpace: format.endsWith('-srgb') ? 'srgb' : 'linear',
      mips: mipmap ? { kind: 'generate' } : { kind: 'none' },
    };
  }

  function configured(probe: DeviceProbe): GpuResidencyCache {
    const store = new GpuResidencyCache();
    store.configureGpuDevice(makeMockDevice(probe), shaderFactory, makeRegisterCube(), mockCaps);
    return store;
  }

  describe('GpuResidencyCache residency', () => {
    it('(1)+(2) mesh ensureResident miss builds buffers, hit is O(1) (same buffers)', () => {
      const probe = freshProbe();
      const store = configured(probe);
      const handle = toShared<'MeshAsset'>(1024);
      const pod = meshPod();

      const first = store.ensureResident(handle, pod);
      expect(first.ok).toBe(true);
      const buffersAfterFirst = probe.buffers;
      expect(buffersAfterFirst).toBe(2); // vbo + ibo

      const second = store.ensureResident(handle, pod);
      expect(second.ok).toBe(true);
      // Cache hit: no new buffers allocated.
      expect(probe.buffers).toBe(buffersAfterFirst);
      if (first.ok && second.ok) {
        expect(first.value.vertexBuffer).toBe(second.value.vertexBuffer);
      }
    });

    it('(7b) no-device ensureResident returns a structured error (OOS-3 legacy degradation made explicit)', () => {
      const store = new GpuResidencyCache(); // configureGpuDevice never called
      const meshRes = store.ensureResident(toShared<'MeshAsset'>(1024), meshPod());
      expect(meshRes.ok).toBe(false);
      const texRes = store.ensureResident(toShared<'TextureAsset'>(2048), texturePod(false));
      expect(texRes.ok).toBe(false);
    });
  });
}
