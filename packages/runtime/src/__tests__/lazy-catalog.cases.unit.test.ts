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
import { AssetError, numMipLevels, toShared, toUnique, unwrapHandle } from '@forgeax/engine-types';
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
  // --- from lazy-catalog.test.ts ---
  function makeMockShaderRegistry() {
    return {
      getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
      materialArtifact: () => undefined,
      findMaterialArtifact: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
      getPipeline: vi.fn().mockReturnValue(undefined),
      installMaterialArtifact: vi.fn(),
      inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
    } as unknown as import('@forgeax/engine-shader').ShaderRegistry;
  }

  const UNKNOWN_GUID = 'ffffffff-ffff-7fff-bfff-ffffffffffff';

  function mockGlobalFetch(impl: (url: string) => Promise<unknown>) {
    // biome-ignore lint/suspicious/noExplicitAny: test mock needs unsafe globalThis cast
    globalThis.fetch = vi.fn().mockImplementation(impl) as any;
  }

  function emptyCatalogResponse() {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    });
  }

  describe('M4 lazy catalog + ImportTransport (AC-19 / AC-22)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      delete (globalThis as any).fetch;
    });

    it('(AC-19) DDC miss with transport present triggers fetchPack', async () => {
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockResolvedValue({ ok: true }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);

      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch(() => emptyCatalogResponse());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      // DDC miss (empty catalog -> resolveCatalogEntry returns undefined)
      // -> transportOrFail -> transport.fetchPack called.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-imported');
      }
      // AC-19: transport WAS called (DDC miss triggers it).
      expect(transport.fetchPack).toHaveBeenCalledTimes(1);
    });

    it('(AC-22) no transport wired + DDC miss -> asset-not-imported fail-fast', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch(() => emptyCatalogResponse());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AssetError);
        expect(result.error.code).toBe('asset-not-imported');
        expect(result.error.hint).toContain('pre-import');
      }
    });

    it('transport fetchPack returns error -> asset-not-imported', async () => {
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockResolvedValue({ ok: false }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);

      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch(() => emptyCatalogResponse());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('asset-not-imported');
      }
      expect(transport.fetchPack).toHaveBeenCalledTimes(1);
    });

    it('(AC-19) DDC hit path never touches transport (fetch succeeds, transport call count = 0)', async () => {
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockResolvedValue({ ok: true }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);

      reg.configurePackIndex('/pack-index.json');

      const guid = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                {
                  guid,
                  packageUrl: '/pack/asset.pack.json',
                  kind: 'mesh',
                },
              ]),
          });
        }
        if (url === '/pack/asset.pack.json') {
          // Return a mesh with 12-float-per-vertex stride (validateMeshPayload
          // requires vertices.length % 12 === 0). 2 vertices x 12 floats.
          // position(3) + normal(3) + uv(2) + tangent(4) = 12.
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                schemaVersion: '2.0.0',
                kind: 'internal-text-package',
                assets: [
                  {
                    guid,
                    kind: 'mesh',
                    payload: {
                      vertices: [
                        0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
                      ],
                      indices: [0, 1],
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
              }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(guid);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      // DDC hit: catalog has the entry, pack fetch succeeds.
      // validateMeshPayload requires vertices.length === 24 (2 * 12).
      // Indices [0,1] -> maxIndex=1, vertexCount=24/12=2. maxIndex+1===2.
      expect(result.ok).toBe(true);

      // AC-19 lazy iron law: transport must NOT be called when DDC hit.
      expect(transport.fetchPack).toHaveBeenCalledTimes(0);
    });

    it('resolveGuid (dev/fallback, no packIndexUrl) still returns asset-not-found', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const parsed = AssetGuid.parse(UNKNOWN_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<MeshAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The dev path (no packIndexUrl) goes through resolveGuid, not the
        // transport-aware loadByGuidProd path. It should still return
        // asset-not-found for unregistered GUIDs.
        expect(result.error.code).toBe('asset-not-found');
      }
    });
  });

  // ─── w16: createRenderer transport injection + invariants ────────────────────
  //
  // createRenderer needs a real GPU device, so the injection wiring is asserted
  // against the source SSOT (the constructor call site + signature) rather than
  // by booting a renderer. The behavioural fail-fast (AC-08) + transport-call
  // (AC-19) semantics are exercised by the AssetRegistry-level tests above; here
  // we lock the load-bearing structural invariants the injection channel must
  // preserve.

  const createRendererSrc = readFileSync(
    fileURLToPath(new URL('../../../render/src/assembly/webgpu-renderer.ts', import.meta.url)),
    'utf-8',
  );
  const rendererBootstrapSrc = readFileSync(
    fileURLToPath(
      new URL('../../../render/src/assembly/webgpu-renderer-bootstrap.ts', import.meta.url),
    ),
    'utf-8',
  );
  const rendererInternalsSrc = readFileSync(
    fileURLToPath(
      new URL('../../../render/src/assembly/webgpu-renderer-contract.ts', import.meta.url),
    ),
    'utf-8',
  );
  const rendererTypeSrc = readFileSync(
    fileURLToPath(new URL('../../../render/src/render-contract.ts', import.meta.url)),
    'utf-8',
  );
  // feat-20260705-runtime-tier2-decomposition M1 / w7 (D-4): the load-by-guid +
  // DDC/pack-fetch method cluster moved out of asset-registry.ts into
  // registry/load-by-guid.ts. Source guards for that pipeline read the new file.
  // (The former assetRegistrySrc read was dropped -- its sole remaining consumer,
  // the transport-eligible guard, now reads loadByGuidSrc.)
  const loadByGuidSrc = readFileSync(
    fileURLToPath(new URL('../../../assets-runtime/src/registry/load-by-guid.ts', import.meta.url)),
    'utf-8',
  );

  describe('w16 createRenderer transport injection (AC-03 / AC-05 / AC-08)', () => {
    it('(AC-05) createRenderer threads transport into the AssetRegistry ctor', () => {
      // The AssetRegistry constructor is wired directly at the assembly owner;
      // the injected transport remains the second positional argument (D-3:
      // ctor-readonly single injection point).
      // The loaders are now self-contained: AssetRegistry internally builds its
      // own LoaderRegistry via createDefaultLoaderRegistry() (M3 w9).
      expect(createRendererSrc).toMatch(
        /new AssetRegistry\(\s*shaderCatalog,\s*internals\.importTransport\s*,\s*\[audioLoader\]\s*,\s*postSpawnResolveJoints/,
      );
      // The renderer implementation and backend bootstrap are split owners:
      // WebGPURendererInternals carries the dedicated non-RendererOptions
      // channel, and the bootstrap derives it from BundlerOptions.
      expect(rendererInternalsSrc).toMatch(/importTransport\?\s*:\s*ImportTransport/);
      expect(rendererBootstrapSrc).toMatch(/const importTransport = bundler\?\.importTransport/);
    });

    it('(AC-05) RendererOptions gains no asset-layer transport field', () => {
      // The injection channel must NOT pollute RendererOptions with an
      // asset-layer concept (R-4): the transport rides a separate internal param.
      expect(rendererTypeSrc).not.toMatch(/importTransport/);
      expect(rendererTypeSrc).not.toMatch(/ImportTransport/);
    });
  });

  // ─── w5: import-on-demand sentinel routing (feat-20260604 M2 / D-1) ────────────
  //
  // Four routes (AC-02 / AC-03 / AC-08, plan-strategy section 5.3 + Risk-1):
  //   (a) studio form: an unimported (non-.bin) texture row surfaces the
  //       texture-source-not-imported sentinel -> loadByGuidProd routes it through
  //       transport.fetchPack -> after the import the rebuilt catalog has a .bin
  //       row -> the re-entered DDC load succeeds with a TextureAsset handle.
  //   (b) shipped form (no transport): the SAME unimported row fails fast with
  //       asset-not-imported (never silently lazy-imports, AC-08).
  //   (c) Risk-1 falsification: a genuinely corrupt .bin path produces an
  //       image-decode-failed ImageError, which is NOT transport-eligible (the
  //       :2334 guard is `instanceof AssetError`, and ImageError is a distinct
  //       class) -> transport.fetchPack is never called.
  //   (d) after the import the same GUID resolves to a SINGLE .bin row (AC-02).

  const TEXTURE_GUID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const RAW_SOURCE_URL = '/textures/wall-source.pack.json';
  const IMPORTED_BIN_URL = '/textures/wall.pack.json';

  const TEXTURE_METADATA = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
    format: 'rgba8unorm',
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  } as const;

  function unimportedTextureRow() {
    return {
      guid: TEXTURE_GUID,
      packageUrl: RAW_SOURCE_URL,
      kind: 'texture',
    };
  }
  function importedTextureRow() {
    return {
      guid: TEXTURE_GUID,
      packageUrl: IMPORTED_BIN_URL,
      kind: 'texture',
    };
  }

  function jsonResponse(body: unknown) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }
  function binaryResponse() {
    // 2x2 rgba8 = 16 bytes; loadTextureAsset does not validate byte length, any
    // buffer registers as the TextureAsset POD.
    return Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array(16).buffer),
    });
  }

  describe('w5 import-on-demand sentinel routing (AC-02 / AC-03 / AC-08)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      delete (globalThis as any).fetch;
    });

    it('(a/d AC-03/AC-02) studio form: unimported texture row -> sentinel -> transport imports -> single .bin row resolves', async () => {
      let imported = false;
      const transport: ImportTransport = {
        fetchPack: vi.fn().mockImplementation(() => {
          // The transport (dev POST /__import) imports the .bin and the rebuilt
          // pack-index now carries a single imported .bin row for this GUID.
          imported = true;
          return Promise.resolve({ ok: true });
        }),
      };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);
      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') {
          // Before import: the cooked package is unavailable. After import:
          // the transport publishes one Pack v2 package row.
          return jsonResponse([imported ? importedTextureRow() : unimportedTextureRow()]);
        }
        if (url === IMPORTED_BIN_URL) {
          return jsonResponse({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: TEXTURE_GUID,
                kind: 'texture',
                payload: TEXTURE_METADATA,
                refs: [],
                artifacts: {
                  body: { path: 'wall.bin', mediaType: 'application/x-forgeax-rgba8' },
                },
              },
            ],
          });
        }
        if (url === '/textures/wall.bin') return binaryResponse();
        // The raw source must NOT be fetched as a .bin (it never reaches
        // fetchBinary because the sentinel short-circuits before fetch).
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(TEXTURE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(parsed.value);

      expect(transport.fetchPack).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
    });

    it('(b AC-08) shipped form (no transport): same unimported row -> asset-not-imported fail-fast', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') return jsonResponse([unimportedTextureRow()]);
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(TEXTURE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AssetError);
        expect(result.error.code).toBe('asset-not-imported');
      }
    });

    it('(c Risk-1) image-decode-failed (ImageError) is NOT transport-eligible (corrupt .bin never routes transport)', async () => {
      // A custom texture loader that mimics a genuinely corrupt imported artifact:
      // it returns an image-decode-failed ImageError (a distinct class from
      // AssetError). The :2334 transport-eligibility guard is
      // `instanceof AssetError`, so this error must fail straight through and
      // NEVER reach transport.fetchPack.
      const decodeError: ImageError = {
        name: 'ImageError',
        message: 'corrupt .bin',
        code: 'image-decode-failed',
        detail: { code: 'image-decode-failed', reason: 'corrupt bytes', path: IMPORTED_BIN_URL },
      } as unknown as ImageError;

      const transport: ImportTransport = { fetchPack: vi.fn().mockResolvedValue({ ok: true }) };
      const reg = new AssetRegistry(makeMockShaderRegistry(), transport);
      reg.loaders.registerPackLoader({
        kind: 'texture',
        load: () => ({ ok: false as const, error: decodeError }),
      });
      reg.configurePackIndex('/pack-index.json');

      mockGlobalFetch((url: string) => {
        if (url === '/pack-index.json') return jsonResponse([importedTextureRow()]);
        if (url === IMPORTED_BIN_URL) {
          return jsonResponse({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: TEXTURE_GUID,
                kind: 'texture',
                payload: TEXTURE_METADATA,
                refs: [],
                artifacts: {},
              },
            ],
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const parsed = AssetGuid.parse(TEXTURE_GUID);
      if (!parsed.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(parsed.value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('image-decode-failed');
        expect(result.error).not.toBeInstanceOf(AssetError);
      }
      // Risk-1 falsification: a real decode failure must not be lazy-imported.
      expect(transport.fetchPack).toHaveBeenCalledTimes(0);
    });
  });

  describe('w16 createRenderer transport injection (AC-03 / AC-05 / AC-08) cont.', () => {
    it('(AC-03 / w6 D-1) transport-eligible set = {asset-not-found, asset-fetch-failed, texture-source-not-imported}, excludes image-decode-failed', () => {
      // R-2 + feat-20260604 Risk-1: a DDC miss routes through transport only for
      // asset-not-found / asset-fetch-failed (missing pack file) or
      // texture-source-not-imported (unimported texture source, D-1 import-on-demand).
      // The eligibility block is layout-robust (the formatter may wrap the
      // clauses), so we slice the guard region and assert by substring.
      const transportGuard = loadByGuidSrc.slice(
        loadByGuidSrc.indexOf('ddcError instanceof AssetError'),
        loadByGuidSrc.indexOf('transportOrFail<T>(registry, guid, guidKey, ddcError.code)'),
      );
      expect(transportGuard).toContain("ddcError.code === 'asset-not-found'");
      expect(transportGuard).toContain("ddcError.code === 'asset-fetch-failed'");
      expect(transportGuard).toContain("ddcError.code === 'texture-source-not-imported'");
      // image-decode-failed (a genuinely corrupt imported .bin) is an ImageError --
      // it must NEVER be listed in the AssetError-only eligibility guard (a real
      // decode failure must not be silently lazy-imported).
      expect(transportGuard).not.toContain('image-decode-failed');
    });
  });
}
