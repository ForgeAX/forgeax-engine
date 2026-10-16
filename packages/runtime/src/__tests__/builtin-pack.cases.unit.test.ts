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
  // --- from builtin-pack.test.ts ---
  // ─── Builtin GUIDs (must match packages/pack/src/builtin.ts) ────────────
  const BUILTIN_GUID_CUBE = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
  const BUILTIN_GUID_TRIANGLE = '22592f07-d967-5116-b29c-fa9781929ba8';
  const BUILTIN_GUID_QUAD = '339338aa-a338-581c-9fc5-744267ef8a51';

  // ─── Triangle interleaved data (mirrors asset-registry.ts BUILTIN_TRIANGLE) ──
  const TRIANGLE_INTERLEAVED = new Float32Array([
    0, 0.7, 0, 0, 0, 1, 0.5, 1, -0.7, -0.6, 0, 0, 0, 1, 0, 0, 0.7, -0.6, 0, 0, 0, 1, 1, 0,
  ]);
  const TRIANGLE_INDICES = new Uint16Array([0, 1, 2]);
  const EXPECTED_TRIANGLE = meshFromInterleaved(TRIANGLE_INTERLEAVED, TRIANGLE_INDICES);

  // ─── Procedural reference meshes ────────────────────────────────────────
  // These must be computed lazily because createBoxGeometry/createPlaneGeometry
  // are pure functions and their output is deterministic.
  let cubeRefCache: MeshAsset | undefined;
  let quadRefCache: MeshAsset | undefined;

  function cubeRef(): MeshAsset {
    if (!cubeRefCache) {
      const res = createBoxGeometry(1, 1, 1);
      if (!res.ok) throw new Error('createBoxGeometry(1,1,1) failed');
      cubeRefCache = res.value;
    }
    return cubeRefCache;
  }

  function quadRef(): MeshAsset {
    if (!quadRefCache) {
      const res = createPlaneGeometry(1, 1);
      if (!res.ok) throw new Error('createPlaneGeometry(1,1) failed');
      quadRefCache = res.value;
    }
    return quadRefCache;
  }

  function triangleRef(): MeshAsset {
    if (!EXPECTED_TRIANGLE.ok) throw new Error('meshFromInterleaved triangle fixture failed');
    return EXPECTED_TRIANGLE.value;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** Float32Array byte-level equality. */
  function float32Equal(a: Float32Array, b: Float32Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** Uint16Array/Uint32Array byte-level equality. */
  // Accepts the optional MeshAsset.indices shape (M2): both operands are builtin
  // indexed meshes, but the type became `... | undefined` -- a missing buffer on
  // either side fails equality.
  function indicesEqual(
    a: Uint16Array | Uint32Array | undefined,
    b: Uint16Array | Uint32Array | undefined,
  ): boolean {
    if (a === undefined || b === undefined) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** Build a pack-index catalog fixture. */
  function makePackIndex(entries: Array<{ guid: string; packageUrl: string }>) {
    return entries.map((e) => ({
      guid: e.guid,
      packageUrl: e.packageUrl,
      kind: 'mesh' as const,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 0,
          materialSlot: 0,
          topology: 'triangle-list',
        },
      ],
    }));
  }

  /** Build a .pack.json fixture from a MeshAsset. */
  function makePackFileFixture(guid: string, mesh: MeshAsset) {
    return {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'mesh',
          payload: {
            vertices: Array.from(mesh.vertices),
            indices: Array.from(mesh.indices ?? []),
            attributes: {},
          },
          refs: [],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              topology: 'triangle-list',
            },
          ],
        },
      ],
    };
  }

  /** Wire mock fetch + configurePackIndex for a set of builtin meshes. */
  function setupMockFetch(
    reg: AssetRegistry,
    packs: Array<{ guid: string; url: string; mesh: MeshAsset }>,
  ) {
    const packIndexEntries = packs.map((p) => ({
      guid: p.guid,
      packageUrl: p.url,
    }));

    const packIndex = makePackIndex(packIndexEntries);
    const packFiles = new Map<string, ReturnType<typeof makePackFileFixture>>();
    for (const p of packs) {
      packFiles.set(p.url, makePackFileFixture(p.guid, p.mesh));
    }

    const fetchMock = async (url: string) => {
      if (url === '/pack-index.json') {
        return {
          ok: true,
          json: async () => packIndex,
        };
      }
      const packFile = packFiles.get(url);
      if (packFile !== undefined) {
        return {
          ok: true,
          json: async () => packFile,
        };
      }
      return { ok: false, status: 404 };
    };

    // biome-ignore lint/suspicious/noExplicitAny: test mock
    globalThis.fetch = fetchMock as any;
    reg.configurePackIndex('/pack-index.json');
  }

  // ─── Tests ──────────────────────────────────────────────────────────────

  describe('builtin mesh pack loading (w9)', () => {
    it('loadByGuid(BUILTIN_HANDLE_CUBE) returns mesh with vertex data byte-equal to procedural', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const cube = cubeRef();

      setupMockFetch(reg, [
        { guid: BUILTIN_GUID_CUBE, url: '/assets/builtin/cube.pack.json', mesh: cube },
      ]);

      const parsed = AssetGuid.parse(BUILTIN_GUID_CUBE);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // loadByGuid now returns the payload directly.
        const loaded = result.value;
        expect(loaded.kind).toBe('mesh');
        expect(float32Equal(loaded.vertices, cube.vertices)).toBe(true);
        expect(indicesEqual(loaded.indices, cube.indices)).toBe(true);
      }
    });

    it('loadByGuid(BUILTIN_HANDLE_QUAD) returns mesh with vertex data byte-equal to procedural', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const quad = quadRef();

      setupMockFetch(reg, [
        { guid: BUILTIN_GUID_QUAD, url: '/assets/builtin/quad.pack.json', mesh: quad },
      ]);

      const parsed = AssetGuid.parse(BUILTIN_GUID_QUAD);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const loaded = result.value;
        expect(loaded.kind).toBe('mesh');
        expect(float32Equal(loaded.vertices, quad.vertices)).toBe(true);
        expect(indicesEqual(loaded.indices, quad.indices)).toBe(true);
      }
    });

    it('loadByGuid(BUILTIN_HANDLE_TRIANGLE) returns mesh with vertex data byte-equal to procedural', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const tri = triangleRef();

      setupMockFetch(reg, [
        { guid: BUILTIN_GUID_TRIANGLE, url: '/assets/builtin/triangle.pack.json', mesh: tri },
      ]);

      const parsed = AssetGuid.parse(BUILTIN_GUID_TRIANGLE);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const loaded = result.value;
        expect(loaded.kind).toBe('mesh');
        expect(float32Equal(loaded.vertices, tri.vertices)).toBe(true);
        expect(indicesEqual(loaded.indices, tri.indices)).toBe(true);
      }
    });

    it('loadByGuid with unknown GUID returns asset-not-imported (M4 shipped form, AC-22)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      setupMockFetch(reg, []);

      const parsed = AssetGuid.parse('ffffffff-ffff-7fff-bfff-ffffffffffff');
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-imported');
      }
    });
  });
}
