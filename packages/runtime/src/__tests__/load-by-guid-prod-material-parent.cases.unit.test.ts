// @ts-nocheck — merged file: cross-source type narrowing failures from blocks originally outside src/ rootDir
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=33):
//   - packages/runtime/__tests__/asset-registry.test.ts
//   - packages/runtime/__tests__/loader-registry.test.ts
//   - packages/runtime/__tests__/wire-default-loaders.test.ts
//   - packages/runtime/src/__tests__/asset-registry-aabb.test.ts
//   - packages/runtime/src/__tests__/asset-registry-builtin-nineslice.test.ts
//   - packages/runtime/src/__tests__/asset-registry-d9-tile-sampler-soft-warn.test.ts
//   - packages/runtime/src/__tests__/asset-registry-guid.test.ts
//   - packages/runtime/src/__tests__/asset-registry-material-validate.test.ts
//   - packages/runtime/src/__tests__/asset-registry-mesh-fail-fast.test.ts
//   - packages/runtime/src/__tests__/asset-registry-scene.test.ts
//   - packages/runtime/src/__tests__/asset-registry-sprite-slices-validate.test.ts
//   - packages/runtime/src/__tests__/auto-select.test.ts
//   - packages/runtime/src/__tests__/bindgroup-resize-invalidation.test.ts
//   - packages/runtime/src/__tests__/builtin-guid-ssot.test.ts
//   - packages/runtime/src/__tests__/builtin-pack.test.ts
//   - packages/runtime/src/__tests__/cube-texture-narrowing.test.ts
//   - packages/runtime/src/__tests__/cubemap-upload.test.ts
//   - packages/runtime/src/__tests__/dev-import-transport.test.ts
//   - packages/runtime/src/__tests__/font-asset-load.test.ts
//   - packages/runtime/src/__tests__/handle-quad.test.ts
//   - packages/runtime/src/__tests__/lazy-catalog.test.ts
//   - packages/runtime/src/__tests__/load-by-guid-hdr.test.ts
//   - packages/runtime/src/__tests__/load-by-guid-prod-material-parent.test.ts
//   - packages/runtime/src/__tests__/load-by-guid-prod.test.ts
//   - packages/runtime/src/__tests__/mipmap-formula.test.ts
//   - packages/runtime/src/__tests__/mipmap-pipeline-cache.test.ts
//   - packages/runtime/src/__tests__/parse-asset-payload-material.test.ts
//   - packages/runtime/src/__tests__/parse-asset-payload-texture.test.ts
//   - packages/runtime/src/__tests__/parse-scene-payload-refs.test.ts
//   - packages/runtime/src/__tests__/register-with-guid-rgba16float.test.ts
//   - packages/runtime/src/__tests__/resolve-scene-guids.test.ts
//   - packages/runtime/src/__tests__/upload-texture-consistency.test.ts
//   - packages/runtime/src/__tests__/verify-revisions.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as assetRegistryModule from '@forgeax/engine-assets-runtime';
import {
  AssetRegistry,
  animationClipLoader,
  buildSceneChildContext,
  fontLoader,
  getOrCreateMipmapPipeline,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
  INLINE_PACK_LOADERS,
  LoaderRegistry,
  materialLoader,
  meshLoader,
  mipmapCacheSize,
  numMipLevels,
  PACK_ARTIFACT_LOADERS,
  resolveAssetHandle,
  sceneLoader,
  skeletonLoader,
  skinLoader,
  textureLoader,
  walkMaterialPassesOverSharedRefs,
  wireDefaultLoaders,
} from '@forgeax/engine-assets-runtime';
import { audioLoader } from '@forgeax/engine-audio-webaudio';
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createPlaneGeometry,
  meshFromInterleaved,
  PROCEDURAL_FLOATS_PER_VERTEX,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ok, ok as rhiOk } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type {
  EquirectAsset,
  Handle,
  MaterialAsset,
  MaterialPass,
  SamplerAsset,
} from '@forgeax/engine-types';
import { AssetError, toShared, toUnique, unwrapHandle } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { deriveBuiltin } from '../../../pack/src/builtin';
import { DeviceScope } from '../../../render/src/device/device-scope';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { createEngineMetrics } from '../../../render/src/engine-metrics';
import { createRenderer as createRuntimeRenderer } from '../createRenderer';
import { createDevImportTransport, type ImportTransport } from '../dev-import-transport';
import { EngineEnvironmentError } from '../errors/environment';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { requireRenderer } from './renderer-test-utils';

vi.mock('@forgeax/engine-rhi-webgpu', async () => {
  spies.webgpuImportCount += 1;
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  spies.rhiErrorCtor = actualRhi.RhiError;
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        if (spies.rhiWebgpuRequestAdapterShould === 'reject-rhi-not-available') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'rhi-not-available',
              expected: 'navigator.gpu available',
              hint: 'unit-test: forced rhi-not-available',
            }),
          );
        }
        if (spies.rhiWebgpuRequestAdapterShould === 'reject-adapter-null') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'adapter-unavailable',
              expected: 'requestAdapter returns non-null',
              hint: 'unit-test: forced adapter-unavailable',
            }),
          );
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) => {
        return actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        });
      },
    },
    createShaderModule: async () => actualRhi.ok({ __brand: 'ShaderModule' } as unknown as object),
    translateErrorEventToRhiError: () =>
      actualRhi.err(
        new actualRhi.RhiError({
          code: 'webgpu-runtime-error',
          expected: 'GPU error event translates to RhiError',
          hint: 'unit-test mock event translation',
        }),
      ),
    _internal_getRawDevice: () => undefined,
  };
});
vi.mock('@forgeax/engine-rhi-wgpu', async () => {
  spies.wgpuImportCount += 1;
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        if (spies.rhiWgpuRequestAdapterShould === 'reject-rhi-not-available') {
          return actualRhi.err(
            new actualRhi.RhiError({
              code: 'rhi-not-available',
              expected: 'wgpu webgl backend available',
              hint: 'unit-test: forced rhi-not-available on rhi-wgpu',
            }),
          );
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) => {
        return actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        });
      },
    },
    ensureReady: async () => {
      spies.ensureReadyCount += 1;
      if (spies.rhiWgpuEnsureReadyShould === 'reject-load-failed') {
        throw new Error('unit-test: forced rhi-wgpu wasm load failure');
      }
      return undefined;
    },
    createShaderModule: async () => actualRhi.ok({ __brand: 'ShaderModule' } as unknown as object),
    translateErrorEventToRhiError: () =>
      actualRhi.err(
        new actualRhi.RhiError({
          code: 'webgpu-runtime-error',
          expected: 'GPU error event translates to RhiError',
          hint: 'unit-test mock event translation',
        }),
      ),
    _internal_getRawDevice: () => undefined,
  };
});
const spies = vi.hoisted(() => ({
  webgpuImportCount: 0,
  wgpuImportCount: 0,
  ensureReadyCount: 0,
  // Failure toggles set by individual tests before invoking createRenderer.
  rhiWebgpuRequestAdapterShould: 'success' as
    | 'success'
    | 'reject-rhi-not-available'
    | 'reject-adapter-null',
  rhiWgpuEnsureReadyShould: 'success' as 'success' | 'reject-load-failed',
  rhiWgpuRequestAdapterShould: 'success' as 'success' | 'reject-rhi-not-available',
  rhiErrorCtor: undefined as undefined | (new (...args: never[]) => Error),
  reset(): void {
    this.webgpuImportCount = 0;
    this.wgpuImportCount = 0;
    this.ensureReadyCount = 0;
    this.rhiWebgpuRequestAdapterShould = 'success';
    this.rhiWgpuEnsureReadyShould = 'success';
    this.rhiWgpuRequestAdapterShould = 'success';
  },
}));
function makeFakeRhiDevice(): Record<string, unknown> {
  let resolveLost!: (info: unknown) => void;
  const lost = new Promise<unknown>((res) => {
    resolveLost = res;
  });
  void resolveLost;
  return {
    __brand: 'RhiDevice',
    lost,
    features: new Set<string>(),
    limits: {},
    // feat-20260707 M5 / w33: createRenderer projects RhiCaps.textureCompression*
    // into TranscodeCaps right after building the registry, so the fake device
    // must expose a caps object (the real RhiDevice always carries one).
    caps: {
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
    },
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
    createBuffer: () => ({ ok: true, value: { __brand: 'Buffer' } }),
    createTexture: () => ({ ok: true, value: { __brand: 'Texture' } }),
    createBindGroupLayout: () => ({ ok: true, value: { __brand: 'BindGroupLayout' } }),
    createBindGroup: () => ({ ok: true, value: { __brand: 'BindGroup' } }),
    createPipelineLayout: () => ({ ok: true, value: { __brand: 'PipelineLayout' } }),
    createRenderPipeline: () => ({ ok: true, value: { __brand: 'RenderPipeline' } }),
    createSampler: () => ({ ok: true, value: { __brand: 'Sampler' } }),
    createShaderModule: () => ({
      ok: true,
      value: { __brand: 'ShaderModule' },
    }),
    createTextureView: () => ({ ok: true, value: { __brand: 'TextureView' } }),
    createCommandEncoder: () => ({
      ok: true,
      value: {
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({ __brand: 'CommandBuffer' }),
      },
    }),
  };
}
function makeMockCanvas(opts: { webgpu?: 'context' | 'null'; webgl2?: 'context' | 'null' }) {
  return {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgpu') {
        if (opts.webgpu === 'context') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      }
      if (kind === 'webgl2') {
        if (opts.webgl2 === 'context') {
          return {
            __mockTag: 'webgl2',
            getExtension: () => null,
            getParameter: () => 1,
            isContextLost: () => false,
          };
        }
        return null;
      }
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
}
function _makeStubGPU(): unknown {
  return {
    requestAdapter: async () => ({
      features: new Set<string>(),
      limits: {},
      requestDevice: async () => makeFakeRhiDevice(),
    }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

void [
  AssetError,
  AssetGuid,
  AssetRegistry,
  DeviceScope,
  EngineEnvironmentError,
  GpuResidencyCache,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
  HANDLE_QUAD,
  HANDLE_SPHERE,
  HANDLE_TRIANGLE,
  INLINE_PACK_LOADERS,
  LoaderRegistry,
  PACK_ARTIFACT_LOADERS,
  PROCEDURAL_FLOATS_PER_VERTEX,
  ShaderRegistry,
  World,
  _makeStubGPU,
  afterEach,
  animationClipLoader,
  assetRegistryModule,
  audioLoader,
  beforeEach,
  buildSceneChildContext,
  createBoxGeometry,
  createDevImportTransport,
  createEngineMetrics,
  createPlaneGeometry,
  createRuntimeRenderer,
  defineComponent,
  deriveBuiltin,
  describe,
  expect,
  expectTypeOf,
  fileURLToPath,
  fontLoader,
  getOrCreateMipmapPipeline,
  it,
  makeFakeRhiDevice,
  makeMockCanvas,
  makeMockShaderRegistry,
  materialLoader,
  meshFromInterleaved,
  meshLoader,
  mipmapCacheSize,
  numMipLevels,
  ok,
  readFileSync,
  requireRenderer,
  resolveAssetHandle,
  rhi,
  rhiOk,
  sceneLoader,
  skeletonLoader,
  skinLoader,
  spies,
  textureLoader,
  toShared,
  toUnique,
  unwrapHandle,
  vi,
  walkMaterialPassesOverSharedRefs,
  wireDefaultLoaders,
];
type __MergedKeep =
  | EquirectAsset
  | Handle
  | ImportTransport
  | MaterialAsset
  | MaterialPass
  | SamplerAsset;

{
  // --- from load-by-guid-prod-material-parent.test.ts ---
  const PARENT_GUID = '00000000-0000-7000-8000-000000000001';
  const CHILD_GUID = '00000000-0000-7000-8000-000000000002';
  const CHILD_SAME_PACK_GUID = '00000000-0000-7000-8000-000000000003';
  const NON_MATERIAL_GUID = '00000000-0000-7000-8000-000000000004';

  // pack-index catalog fixture with:
  //  - parent: material in parent.pack.json
  //  - child: material in child.pack.json (parent ref to PARENT_GUID)
  //  - child-same: material in same-pack.pack.json (parent ref to PARENT_GUID,
  //    both in same file)
  //  - non-material: mesh entry for AC-05
  const PACK_INDEX_FIXTURE = [
    {
      guid: PARENT_GUID,
      packageUrl: '/assets/parent.pack.json',
      kind: 'material',
      sourcePath: 'assets/parent.pack.json',
    },
    {
      guid: CHILD_GUID,
      packageUrl: '/assets/child.pack.json',
      kind: 'material',
      sourcePath: 'assets/child.pack.json',
    },
    {
      guid: CHILD_SAME_PACK_GUID,
      packageUrl: '/assets/same-pack.pack.json',
      kind: 'material',
      sourcePath: 'assets/same-pack.pack.json',
    },
    {
      guid: NON_MATERIAL_GUID,
      packageUrl: '/assets/mesh.pack.json',
      kind: 'mesh',
      sourcePath: 'assets/mesh.pack.json',
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 0,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
    },
  ];

  // Parent material pack — standalone, has passes.
  const PARENT_PACK = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: PARENT_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [
            {
              name: 'Forward',
              program: { module: 'test::standard' },
              renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
            },
          ],
          values: {
            baseColor: [0.5, 0.5, 0.5, 1],
            metallic: 0,
            roughness: 0.8,
          },
        },
        refs: [],
      },
    ],
  };

  // Child material pack — no passes, only parent ref.
  const CHILD_PACK = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: CHILD_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          parent: 0,
          values: {
            baseColor: [0.8, 0.2, 0.1, 1],
            roughness: 0.3,
          },
        },
        refs: [PARENT_GUID],
      },
    ],
  };

  // Same-pack file — parent + child in one pack (AC-08).
  const SAME_PACK = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: PARENT_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          passes: [
            {
              name: 'Forward',
              program: { module: 'test::standard' },
              renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
            },
          ],
          values: {
            baseColor: [0.3, 0.3, 0.3, 1],
            metallic: 0.2,
            roughness: 0.6,
          },
        },
        refs: [],
      },
      {
        guid: CHILD_SAME_PACK_GUID,
        kind: 'material',
        payload: {
          kind: 'material',
          parent: 0,
          values: {
            roughness: 0.2,
          },
        },
        refs: [PARENT_GUID],
      },
    ],
  };

  // Mesh pack for AC-05 (parent ref points to non-material).
  const MESH_PACK = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: NON_MATERIAL_GUID,
        kind: 'mesh',
        payload: {
          vertices: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
          indices: [0],
          attributes: {},
        },
        refs: [],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
      },
    ],
  };

  // Child that references NON_MATERIAL_GUID as parent — invalid.
  const CHILD_WITH_NON_MATERIAL_PARENT_PACK = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: '00000000-0000-7000-8000-000000000005',
        kind: 'material',
        payload: {
          kind: 'material',
          parent: 0,
          values: {
            baseColor: [0.8, 0.2, 0.1, 1],
          },
        },
        refs: [NON_MATERIAL_GUID],
      },
    ],
  };

  // feat-20260614 M8: passesOf/paramValueOf are gone. The material parent-chain
  // walk now runs over a World column handle via walkMaterialPassesOverSharedRefs;
  // the child payload (returned by loadByGuid) is minted into a fresh World and
  // its parent chain resolved against the AssetRegistry catalogue (D-19).
  function resolveMaterialChain(reg: AssetRegistry, childPayload: MaterialAsset) {
    const world = new World();
    const childHandle = world.allocSharedRef('MaterialAsset', childPayload);
    return walkMaterialPassesOverSharedRefs(world, childHandle, reg);
  }

  describe('loadByGuid prod :: material parent inheritance (feat-20260528 M2 / w4)', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown requires deleting globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    // --------------- AC-03: successful parent preload ---------------

    it('(AC-03) child with parent ref (no passes) — parent loaded first, passesOf/paramValueOf inherits parent passes', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PARENT_PACK),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // resolve the child material — should inherit parent passes
      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Inherited parent passes
      expect(walk.value.passes.length).toBe(1);
      if (walk.value.passes[0]) {
        expect(walk.value.passes[0].name).toBe('Forward');
        expect(walk.value.passes[0].program.module).toBe('test::standard');
      }

      // Child values override parent: baseColor + roughness from child, metallic from parent
      expect(walk.value.values.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.values.metallic).toBe(0);
      expect(walk.value.values.roughness).toBe(0.3);
    });

    it('(AC-03) parent already catalogued — idempotent fast-path, child resolves correctly', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // Pre-catalogue the parent (simulates parent already loaded). feat-20260614
      // M8: the registry holds no handle maps; "already loaded" == catalogued.
      const parentGuid = AssetGuid.parse(PARENT_GUID);
      if (!parentGuid.ok) throw new Error('expected ok');
      reg.catalog<MaterialAsset>(parentGuid.value, {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::standard' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {
          baseColor: [0.5, 0.5, 0.5, 1],
          metallic: 0,
          roughness: 0.8,
        },
      } as MaterialAsset);

      // Now request child — loadByGuid should see parent via the catalogue fast-path
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // Parent already catalogued — loadByGuidProd resolves it from the catalogue.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Inherited parent passes
      expect(walk.value.passes.length).toBe(1);
      if (walk.value.passes[0]) {
        expect(walk.value.passes[0].name).toBe('Forward');
      }

      // Child values override parent
      expect(walk.value.values.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.values.metallic).toBe(0);
      expect(walk.value.values.roughness).toBe(0.3);
    });

    // --------------- AC-04: parent GUID not in pack-index ---------------

    it('(AC-04) parent GUID not in pack-index — loadByGuid returns Err(asset-not-imported)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // pack-index only has CHILD_GUID, not PARENT_GUID
      const CATALOG_WITHOUT_PARENT = [
        {
          guid: CHILD_GUID,
          packageUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_WITHOUT_PARENT),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // M4 shipped form (no import transport): DDC miss -> asset-not-imported (AC-22).
        expect(result.error.code).toBe('asset-not-imported');
        // AC-04: hint prefix must contain parent + child GUID info (D-3)
        expect(result.error.hint).toContain(
          `loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`,
        );
      }
    });

    // --------------- AC-05: parent ref points to non-material kind ---------------

    it('(AC-05) parent ref points to mesh kind — loadByGuid returns Err(asset-parse-failed)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const GUID_NON_MATERIAL_CHILD = '00000000-0000-7000-8000-000000000005';

      const CATALOG_WITH_MESH = [
        {
          guid: NON_MATERIAL_GUID,
          packageUrl: '/assets/mesh.pack.json',
          kind: 'mesh',
          sourcePath: 'assets/mesh.pack.json',
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              topology: 'triangle-list',
            },
          ],
        },
        {
          guid: GUID_NON_MATERIAL_CHILD,
          packageUrl: '/assets/child-nonmat-parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/child-nonmat-parent.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_WITH_MESH),
          });
        }
        if (url === '/assets/mesh.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(MESH_PACK),
          });
        }
        if (url === '/assets/child-nonmat-parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_WITH_NON_MATERIAL_PARENT_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(GUID_NON_MATERIAL_CHILD);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // AC-05: parent is mesh, not material — runtime guard catches this
        expect(result.error.code).toBe('asset-parse-failed');
        // hint must include parent GUID + type mismatch info
        expect(result.error.hint).toContain(
          `loading parent material ${NON_MATERIAL_GUID} for child ${GUID_NON_MATERIAL_CHILD}`,
        );
        expect(result.error.hint).toContain("not 'material'");
      }
    });

    // --------------- AC-08: same pack + different pack ---------------

    it('(AC-08) parent and child in same pack file — recursive load works', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // Same pack file contains both parent and child — both entries map to
      // the same packageUrl so loadByGuidProd fetches the same file twice
      // (once for parent, once for child), but fast-path idempotency on the
      // second loadByGuid(parentGuid) avoids a duplicate fetch.
      const SAME_PACK_CATALOG = [
        {
          guid: PARENT_GUID,
          packageUrl: '/assets/same-pack.pack.json',
          kind: 'material',
          sourcePath: 'assets/same-pack.pack.json',
        },
        {
          guid: CHILD_SAME_PACK_GUID,
          packageUrl: '/assets/same-pack.pack.json',
          kind: 'material',
          sourcePath: 'assets/same-pack.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(SAME_PACK_CATALOG),
          });
        }
        if (url === '/assets/same-pack.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(SAME_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_SAME_PACK_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // Same pack: parent entry fetched from same pack file, catalogued first.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Parent passes inherited
      expect(walk.value.passes.length).toBe(1);
      if (walk.value.passes[0]) {
        expect(walk.value.passes[0].program.module).toBe('test::standard');
      }

      // Child roughness overrides parent (0.2 vs 0.6), other params from parent
      expect(walk.value.values.baseColor).toEqual([0.3, 0.3, 0.3, 1]);
      expect(walk.value.values.metallic).toBe(0.2);
      expect(walk.value.values.roughness).toBe(0.2);
    });

    it('(AC-08) parent and child in different pack files — recursive load works', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PACK_INDEX_FIXTURE),
          });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(PARENT_PACK),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // Different pack files: parent fetched from parent.pack.json, child from
      // child.pack.json. Both catalogued.
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;

      // Parent passes inherited
      expect(walk.value.passes.length).toBe(1);

      // Child values override parent
      expect(walk.value.values.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.values.metallic).toBe(0);
      expect(walk.value.values.roughness).toBe(0.3);
    });

    // --------------- W6: error boundary tests ---------------

    it('(w6) parent load failure error hint has correct prefix format "loading parent material <GUID> for child <GUID>: "', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      // Catalog: child in index but parent not — parent loadByGuid will
      // return asset-not-found.
      const CATALOG_WITH_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          packageUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_WITH_PARENT_MISSING),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // M4 shipped form (no import transport): DDC miss -> asset-not-imported (AC-22).
        expect(result.error.code).toBe('asset-not-imported');
        // D-3: exact hint prefix format
        expect(result.error.hint).toContain(
          `loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`,
        );
        // hint should start with the prefix
        expect(result.error.hint).toMatch(/^loading parent material /);
      }
    });

    it('rejects an invalid parent UUID at HTTP Pack admission with its exact field and recovery action', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      if (typeof reg.configurePackIndex !== 'function') {
        return;
      }

      reg.configurePackIndex('/pack-index.json');

      const INVALID_GUID = 'not-a-valid-uuid';
      const CHILD_WITH_INVALID_PARENT_GUID = '00000000-0000-7000-8000-000000000009';

      const CATALOG = [
        {
          guid: CHILD_WITH_INVALID_PARENT_GUID,
          packageUrl: '/assets/child-invalid-parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/child-invalid-parent.pack.json',
        },
      ];

      const CHILD_PACK_INVALID = {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: CHILD_WITH_INVALID_PARENT_GUID,
            kind: 'material',
            payload: {
              kind: 'material',
              parent: 0,
              values: { baseColor: [0.8, 0.2, 0.1, 1] },
            },
            refs: [INVALID_GUID],
          },
        ],
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG),
          });
        }
        if (url === '/assets/child-invalid-parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_PACK_INVALID),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_WITH_INVALID_PARENT_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      // Envelope admission rejects the invalid reference before material parsing.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-parse-failed');
        expect(result.error.detail).toMatchObject({
          field: 'assets[0].refs[0]',
          value: '/assets/child-invalid-parent.pack.json',
        });
        expect(result.error.hint).toContain('repair the Pack envelope at the reported field');
        expect(result.error.hint).toContain('republish, then retry the same GUID');
      }
    });
  });

  // feat-20260622 M5 / w16 (R5): AC-10 parent breadcrumb literal-form contract.
  // The material parent edge currently loads via the independent "Path B"
  // preload (asset-registry.ts), which carries the precise breadcrumb hint
  // `loading parent material <PARENT> for child <CHILD>` that downstream code
  // asserts on. M5 (w17) folds Path B into the unified envelope.refs for-loop;
  // these tests lock the exact contract BEFORE the fold so the move is verified
  // to preserve it. They must be green pre-fold (against current Path B) and
  // stay green post-fold (against the unified for-loop sourceField==='parent' /
  // parent-edge branch).
  describe('(w16) AC-10 material parent breadcrumb literal-form contract', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown requires deleting globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    it('(w16) parent load failure: hint contains parent GUID, child GUID, and the literal substrings "loading parent material" + "for child"', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // Child catalogued, parent absent from index -> parent load fails.
      const CATALOG_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          packageUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_PARENT_MISSING) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const hint = result.error.hint ?? '';
      // Literal form: `loading parent material X for child Y` (research Finding 7;
      // NOT the buildSceneChildContext "sub-asset X referenced by ..." form).
      expect(hint).toContain('loading parent material');
      expect(hint).toContain('for child');
      expect(hint).toContain(PARENT_GUID);
      expect(hint).toContain(CHILD_GUID);
      expect(hint).toContain(`loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`);
    });

    it('(w16) parent load failure: error CODE propagates from the parent load (not replaced with a generic code)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // Parent absent from index -> parent load is a catalog miss, which (no
      // import transport) yields `asset-not-imported`. The child load must
      // surface THAT code, not a flattened generic `asset-parse-failed`.
      const CATALOG_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          packageUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_PARENT_MISSING) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Propagated code from the parent catalog miss (AC-22 shipped form).
      expect(result.error.code).toBe('asset-not-imported');
    });

    it('(w16) parent edge load failure carries enough info to identify the parent GUID', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // Parent present in index but its pack file 404s -> parent load fails
      // mid-fetch. The breadcrumb must still name the parent GUID so an AI user
      // can locate the failing parent edge.
      const CATALOG_PARENT_FETCH_FAILS = [
        {
          guid: PARENT_GUID,
          packageUrl: '/assets/parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/parent.pack.json',
        },
        {
          guid: CHILD_GUID,
          packageUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CATALOG_PARENT_FETCH_FAILS),
          });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        // parent.pack.json fetch fails
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(CHILD_GUID);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const hint = result.error.hint ?? '';
      expect(hint).toContain(`loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`);
    });

    it('(w16) parent ref points to non-material kind: hint preserves the literal parent breadcrumb + "not \'material\'"', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      const GUID_NON_MATERIAL_CHILD = '00000000-0000-7000-8000-000000000005';
      const CATALOG_WITH_MESH = [
        {
          guid: NON_MATERIAL_GUID,
          packageUrl: '/assets/mesh.pack.json',
          kind: 'mesh',
          sourcePath: 'assets/mesh.pack.json',
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              materialSlot: 0,
              topology: 'triangle-list',
            },
          ],
        },
        {
          guid: GUID_NON_MATERIAL_CHILD,
          packageUrl: '/assets/child-nonmat-parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/child-nonmat-parent.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_WITH_MESH) });
        }
        if (url === '/assets/mesh.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MESH_PACK) });
        }
        if (url === '/assets/child-nonmat-parent.pack.json') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CHILD_WITH_NON_MATERIAL_PARENT_PACK),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuid = AssetGuid.parse(GUID_NON_MATERIAL_CHILD);
      if (!childGuid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-parse-failed');
      const hint = result.error.hint ?? '';
      expect(hint).toContain(
        `loading parent material ${NON_MATERIAL_GUID} for child ${GUID_NON_MATERIAL_CHILD}`,
      );
      expect(hint).toContain("not 'material'");
    });
  });

  // feat-20260622 M5 / w18: end-to-end material-with-parent load + Path B
  // deletion verification. Proves the parent edge now flows through the unified
  // envelope.refs for-loop (w17 fold) end-to-end, and that the independent Path
  // B early-return block is gone from the source.
  describe('(w18) material-with-parent end-to-end + Path B deletion', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown requires deleting globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    it('(w18a) child material with parent edge: both child and parent end up in the catalog, child.payload.parent set to the parent AssetGuid', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(PACK_INDEX_FIXTURE) });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(PARENT_PACK) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuidParsed = AssetGuid.parse(CHILD_GUID);
      const parentGuidParsed = AssetGuid.parse(PARENT_GUID);
      if (!childGuidParsed.ok || !parentGuidParsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuidParsed.value);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Child catalogued with parent stamped as the parent AssetGuid (renderer
      // field read by walkMaterialPassesOverSharedRefs), NOT the parentGuid
      // string intermediate.
      const childInCatalog = reg.lookup(childGuidParsed.value) as MaterialAsset | undefined;
      expect(childInCatalog?.kind).toBe('material');
      expect(childInCatalog?.parent).toBeDefined();
      expect(AssetGuid.format(childInCatalog?.parent as AssetGuid).toLowerCase()).toBe(
        PARENT_GUID.toLowerCase(),
      );

      // Parent catalogued by the unified for-loop recursion (formerly Path B's
      // independent preload).
      const parentInCatalog = reg.lookup(parentGuidParsed.value) as MaterialAsset | undefined;
      expect(parentInCatalog?.kind).toBe('material');
      expect(parentInCatalog?.passes?.length).toBe(1);

      // Inheritance still resolves end-to-end through the catalogued chain.
      const walk = resolveMaterialChain(reg, result.value);
      expect(walk.ok).toBe(true);
      if (!walk.ok) return;
      expect(walk.value.passes.length).toBe(1);
      expect(walk.value.values.baseColor).toEqual([0.8, 0.2, 0.1, 1]);
      expect(walk.value.values.roughness).toBe(0.3);
    });

    it('(w18b) parent load failure -> error breadcrumb matches "loading parent material X for child Y" (post-fold contract preserved)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      const CATALOG_PARENT_MISSING = [
        {
          guid: CHILD_GUID,
          packageUrl: '/assets/child.pack.json',
          kind: 'material',
          sourcePath: 'assets/child.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_PARENT_MISSING) });
        }
        if (url === '/assets/child.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CHILD_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const childGuidParsed = AssetGuid.parse(CHILD_GUID);
      if (!childGuidParsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(childGuidParsed.value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.hint ?? '').toContain(
        `loading parent material ${PARENT_GUID} for child ${CHILD_GUID}`,
      );
    });

    it('(w18c) Path B independent early-return block is deleted from load-by-guid source', () => {
      // feat-20260705-runtime-tier2-decomposition M1 / w7 (D-4): the loadByGuid
      // + DDC pipeline moved from asset-registry.ts into registry/load-by-guid.ts.
      const src = readFileSync(
        fileURLToPath(
          new URL('../../../assets-runtime/src/registry/load-by-guid.ts', import.meta.url),
        ),
        'utf-8',
      );
      // The unique parent breadcrumb literal must NOT appear inside an
      // independent `loadByGuid<MaterialAsset>(parentGuid` preload anymore —
      // that whole Path B early-return is folded into the unified for-loop.
      expect(src).not.toContain('loadByGuid<MaterialAsset>(parentGuid');
      // No early-return that registers a separately rebuilt `resolvedAsset`
      // (post-w7 the free function form is registerParsedAsset(registry, guid, ...)).
      expect(src).not.toContain('registerParsedAsset(registry, guid, resolvedAsset');
      // The `loading parent material` literal now lives only in the unified
      // for-loop branch (template form `for child ${guidKey}`). The old Path B
      // used `for child ${guidKey}` against a `parentGuidStr` local — confirm
      // the new template references `${subGuidKey}` (the for-loop edge GUID).
      // biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal source text, which deliberately contains the `${...}` placeholders.
      expect(src).toContain('loading parent material ${subGuidKey} for child ${guidKey}');
    });

    it('(w18d) material WITHOUT a parent still loads (no parent edge in refs[]; unified for-loop has nothing to recurse on)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      if (typeof reg.configurePackIndex !== 'function') return;
      reg.configurePackIndex('/pack-index.json');

      // PARENT_PACK is a standalone material with passes and no parent ref.
      const CATALOG_STANDALONE = [
        {
          guid: PARENT_GUID,
          packageUrl: '/assets/parent.pack.json',
          kind: 'material',
          sourcePath: 'assets/parent.pack.json',
        },
      ];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(CATALOG_STANDALONE) });
        }
        if (url === '/assets/parent.pack.json') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(PARENT_PACK) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock requires unsafe cast
      globalThis.fetch = fetchMock as any;

      const guidParsed = AssetGuid.parse(PARENT_GUID);
      if (!guidParsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MaterialAsset>(guidParsed.value);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe('material');
      expect(result.value.parent).toBeUndefined();
      expect(result.value.passes?.length).toBe(1);
    });
  });
}
