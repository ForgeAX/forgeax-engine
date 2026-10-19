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
import { makeExplicitNullRhi } from './mock-render-bundles';

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
  // --- from record-all-topology.test.ts ---
  const ENGINE = new URL('../../../render/src/assembly/factory.ts', import.meta.url).href;

  interface PassSpies {
    setIndexBuffer: ReturnType<typeof vi.fn>;
    setVertexBuffer: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
    drawIndexed: ReturnType<typeof vi.fn>;
  }

  function makeMockGL2(): unknown {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants:
        identifier === 'forgeax::default-standard-pbr' ? standardMaterialShaderVariants() : [],
    });
    const manifest = {
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  function makePassSpies(): PassSpies {
    return {
      setIndexBuffer: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
    };
  }

  interface RendererLike {
    ready: Promise<void>;
    draw: (worlds: unknown, opts: { cameraOwner: number; resourceOwner: number }) => void;
    onError: (cb: (err: { code: string }) => void) => () => void;
    assets: { register: (asset: unknown) => { ok: boolean; value: unknown } };
  }

  async function importEngine(): Promise<{
    createRenderer: (canvas: unknown, opts?: unknown, bundler?: unknown) => Promise<RendererLike>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => { spawn: (...componentDatas: unknown[]) => unknown };
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
  }> {
    return {
      ...(await import(new URL('../../../render/src/index.ts', import.meta.url).href)),
      ...(await import('@forgeax/engine-scene')),
    } as never;
  }

  function cameraTransform() {
    return {
      pos: [0, 0, 5],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  function originTransform() {
    return {
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  // Vertex-only topologies omit indices (point-list / line-list); strip and
  // triangle-list topologies carry indices (line-strip / triangle-list /
  // triangle-strip). 3 vertices x 12 floats covers every case.
  function meshForTopology(topology: PrimitiveTopology): MeshAsset {
    const vertices = new Float32Array(3 * 12);
    const indexed =
      topology === 'line-strip' || topology === 'triangle-list' || topology === 'triangle-strip';
    if (indexed) {
      return {
        kind: 'mesh',
        vertices,
        indices: new Uint16Array([0, 1, 2]),
        attributes: buildMeshAttributeMapForUvSets(1),
        aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
        materialSlots: [{ slotName: 'Default' }],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 3,
            materialSlot: 0,
            topology,
          },
        ],
      };
    }
    return {
      kind: 'mesh',
      vertices,
      attributes: buildMeshAttributeMapForUvSets(1),
      aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      materialSlots: [{ slotName: 'Default' }],
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 3,
          materialSlot: 0,
          topology,
        },
      ],
    };
  }

  async function setupRenderer(spies: PassSpies): Promise<{ renderer: RendererLike }> {
    const { createRenderer } = await importEngine();
    const renderer = await createRenderer(
      makeMockCanvas(),
      { rhi: makeExplicitNullRhi(spies) },
      { shaderManifestUrl: buildManifestDataUrl() },
    );
    await renderer.ready;
    return { renderer };
  }

  async function spawnScene(_renderer: RendererLike, meshAsset: MeshAsset): Promise<unknown> {
    const { World } = await importEcs();
    const C = await importComponents();
    const { registerPropagateTransforms } = await import('@forgeax/engine-scene');
    const world = new World();
    registerPropagateTransforms(world);
    const meshHandle = world.allocSharedRef('MeshAsset', meshAsset) as Handle<
      'MeshAsset',
      'shared'
    >;

    world.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      { component: C.Transform, data: cameraTransform() },
    );
    world.spawn(
      { component: C.DirectionalLight, data: {} },
      { component: C.Transform, data: cameraTransform() },
    );
    world
      .spawn(
        { component: C.MeshRenderer, data: { materials: [] } },
        { component: C.MeshFilter, data: { assetHandle: meshHandle } },
        { component: C.Transform, data: originTransform() },
      )
      .unwrap();
    expect(world.update(1 / 60).ok).toBe(true);
    return world;
  }

  const ALL_TOPOLOGIES: readonly PrimitiveTopology[] = [
    'point-list',
    'line-list',
    'line-strip',
    'triangle-list',
    'triangle-strip',
  ];

  describe('w10 - AC-04 every primitive topology builds PSO + records a draw', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    for (const topology of ALL_TOPOLOGIES) {
      it(`${topology}: records a mesh draw with 0 RhiError`, async () => {
        const spies = makePassSpies();
        const { renderer } = await setupRenderer(spies);
        const errors: string[] = [];
        renderer.onError((e) => errors.push(e.code));

        const world = await spawnScene(renderer, meshForTopology(topology));
        if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
          throw new Error('World attachment failed');
        }
        (world as WorldType).update().unwrap();
        renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        spies.draw.mockClear();
        spies.drawIndexed.mockClear();
        spies.setIndexBuffer.mockClear();
        spies.setVertexBuffer.mockClear();
        renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });

        // Some dispatch verb must have fired for this topology's mesh.
        const dispatched = spies.draw.mock.calls.length + spies.drawIndexed.mock.calls.length;
        expect(dispatched).toBeGreaterThan(0);

        // Vertex-only topologies (point-list / line-list) dispatch via draw();
        // indexed topologies via drawIndexed().
        const indexed =
          topology === 'line-strip' ||
          topology === 'triangle-list' ||
          topology === 'triangle-strip';
        if (indexed) {
          expect(spies.drawIndexed).toHaveBeenCalled();
        } else {
          const drewVertexCount = spies.draw.mock.calls.some((c) => c[0] === 3);
          expect(drewVertexCount).toBe(true);
          expect(spies.drawIndexed).not.toHaveBeenCalled();
        }

        expect(errors).toEqual([]);
      });
    }

    it('vertex-only mesh uses draw() without an index buffer', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnScene(renderer, meshForTopology('line-list'));
      if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
        throw new Error('World attachment failed');
      }
      (world as WorldType).update().unwrap();
      renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      spies.draw.mockClear();
      spies.drawIndexed.mockClear();
      spies.setIndexBuffer.mockClear();
      spies.setVertexBuffer.mockClear();
      renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });

      expect(spies.draw).toHaveBeenCalled();
      expect(spies.drawIndexed).not.toHaveBeenCalled();
      expect(spies.setIndexBuffer).not.toHaveBeenCalled();
      expect(spies.setVertexBuffer).toHaveBeenCalled();
      expect(spies.draw.mock.calls[0]?.[0]).toBe(3);
      expect(errors).toEqual([]);
    });

    it('indexed mesh uses setIndexBuffer() and drawIndexed()', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnScene(renderer, meshForTopology('triangle-list'));
      if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
        throw new Error('World attachment failed');
      }
      (world as WorldType).update().unwrap();
      renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      spies.draw.mockClear();
      spies.drawIndexed.mockClear();
      spies.setIndexBuffer.mockClear();
      spies.setVertexBuffer.mockClear();
      renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });

      expect(spies.setIndexBuffer).toHaveBeenCalled();
      expect(spies.drawIndexed).toHaveBeenCalled();
      expect(spies.setVertexBuffer).toHaveBeenCalled();
      expect(errors).toEqual([]);
    });
  });
}
