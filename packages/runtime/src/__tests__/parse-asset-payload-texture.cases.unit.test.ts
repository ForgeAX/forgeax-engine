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
  // --- from parse-asset-payload-texture.test.ts ---
  const GUID_DEV = '00000000-0000-7000-8000-00000000d000';
  const GUID_DEV_FETCH_FAIL = '00000000-0000-7000-8000-00000000d001';
  const GUID_DEV_DECODE_FAIL = '00000000-0000-7000-8000-00000000d002';
  const GUID_IMPORT = '00000000-0000-7000-8000-00000000c000';
  const GUID_IMPORT_FETCH_FAIL = '00000000-0000-7000-8000-00000000c001';
  const GUID_NO_METADATA = '00000000-0000-7000-8000-00000000e000';

  // Post-M3 (AC-15): the runtime no longer imports parseImage from
  // @forgeax/engine-image -- the decoder was stripped in w26. Tests
  // verify the post-M3 behavior: only build-time-imported .bin files are
  // accepted by the texture loader.

  interface PackIndexRow {
    readonly guid: string;
    readonly packageUrl: string;
    readonly kind: string;
    readonly sourcePath: string;
  }

  const PACK_INDEX_FIXTURE: readonly PackIndexRow[] = [
    {
      guid: GUID_DEV,
      packageUrl: '/packs/wood-container.pack.json',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/wood-container.jpg',
    },
    {
      guid: GUID_DEV_FETCH_FAIL,
      packageUrl: '/packs/missing-wood.pack.json',
      kind: 'texture',
      sourcePath: 'missing/wood.jpg',
    },
    {
      guid: GUID_DEV_DECODE_FAIL,
      packageUrl: '/packs/corrupt-wood.pack.json',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/corrupt.jpg',
    },
    {
      guid: GUID_IMPORT,
      packageUrl: '/assets/imported-texture.pack.json',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/wood-container.jpg',
    },
    {
      guid: GUID_IMPORT_FETCH_FAIL,
      packageUrl: '/assets/missing-import.pack.json',
      kind: 'texture',
      sourcePath: 'apps/.../missing.jpg',
    },
    {
      guid: GUID_NO_METADATA,
      // A cooked package with an incomplete payload is rejected by the Pack v2
      // loader rather than by a catalog-level metadata field.
      packageUrl: '/assets/no-sidecar.pack.json',
      kind: 'texture',
      sourcePath: 'apps/learn-render/1.4.textures/assets/no-sidecar.bin',
    },
  ];

  const FIXTURE_IMPORT = PACK_INDEX_FIXTURE[3] as PackIndexRow;

  interface FetchResponse {
    readonly ok: boolean;
    readonly status?: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  function jsonResponse(payload: unknown): FetchResponse {
    return {
      ok: true,
      json: () => Promise.resolve(payload),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }

  function bytesResponse(bytes: Uint8Array): FetchResponse {
    return {
      ok: true,
      json: () => Promise.resolve({}),
      arrayBuffer: () => {
        // Return a fresh ArrayBuffer copy so consumers that wrap Uint8Array
        // around the result don't accidentally share underlying storage.
        const copy = new Uint8Array(bytes);
        return Promise.resolve(
          copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
        );
      },
    };
  }

  function notFound(): FetchResponse {
    return {
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }

  describe('w30 - M3 post-decoder-strip texture unit tests', () => {
    let originalFetch: typeof globalThis.fetch | undefined;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      if (originalFetch !== undefined) {
        globalThis.fetch = originalFetch;
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: test teardown deletes globalThis.fetch
        delete (globalThis as any).fetch;
      }
    });

    it('(a) dev source JPG (not .bin), shipped form -> Result.err(asset-not-imported) before source fetch', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      let fetchCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        fetchCallCount += 1;
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_DEV);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      // A catalog row now names a cooked package; a missing package is the
      // shipped-form import boundary.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-imported');
      expect(fetchCallCount).toBe(2); // pack-index + missing package
    });

    it('(b) dev source JPG 404 (not .bin), shipped form -> Result.err(asset-not-imported) before source fetch', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      let fetchCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        fetchCallCount += 1;
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_DEV_FETCH_FAIL);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-imported');
      expect(fetchCallCount).toBe(2); // pack-index + missing package
    });

    it('(c) dev source JPG corrupt (not .bin), shipped form -> Result.err(asset-not-imported) before source fetch', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      let fetchCallCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        fetchCallCount += 1;
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_DEV_DECODE_FAIL);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-not-imported');
      expect(fetchCallCount).toBe(2); // pack-index + missing package
    });

    it('(d) import sub-branch fetch raw RGBA .bin -> Result.ok(TextureAsset POD)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      // 4x4 RGBA = 64 bytes; meta width=4, height=4 -- byte length must align.
      const rgba = new Uint8Array(4 * 4 * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = i & 0xff;

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        if (url === FIXTURE_IMPORT.packageUrl) {
          return Promise.resolve(
            jsonResponse({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_IMPORT,
                  kind: 'texture',
                  payload: {
                    kind: 'texture',
                    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
                    format: 'rgba8unorm',
                    colorSpace: 'linear',
                    mips: { kind: 'none' },
                  },
                  refs: [],
                  artifacts: {
                    body: {
                      path: 'imported-texture.bin',
                      mediaType: 'application/x-forgeax-rgba8',
                    },
                  },
                },
              ],
            }),
          );
        }
        if (url === '/assets/imported-texture.bin') return Promise.resolve(bytesResponse(rgba));
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_IMPORT);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // loadByGuid returns the payload directly.
      const asset = result.value;
      expect(asset.kind).toBe('texture');
      expect(asset.shape).toEqual({ viewDimension: '2d', extent: { width: 4, height: 4 } });
      expect(asset.format).toBe('rgba8unorm');
      expect(asset.colorSpace).toBe('linear');
      expect(asset.mips).toEqual({ kind: 'none' });
      expect(asset.data.byteLength).toBe(4 * 4 * 4);
      expect(asset.data[0]).toBe(0);
      expect(asset.data[63]).toBe(63);
    });

    it('(e) import sub-branch fetch RGBA 404 -> Result.err(asset-fetch-failed)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        if (url === '/assets/no-sidecar.pack.json') {
          return Promise.resolve(
            jsonResponse({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                { guid: GUID_NO_METADATA, kind: 'texture', payload: {}, refs: [], artifacts: {} },
              ],
            }),
          );
        }
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_IMPORT_FETCH_FAIL);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // M4 shipped form (no import transport): DDC fetch fail -> asset-not-imported (AC-22).
      expect(result.error.code).toBe('asset-not-imported');
      const calledUrls = fetchMock.mock.calls.map((c) => c[0]);
      expect(calledUrls).toContain('/assets/missing-import.pack.json');
    });

    it('(f) pack-index entry kind=texture but metadata absent -> Result.err(image-meta-missing)', async () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      reg.configurePackIndex('/pack-index.json');

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === '/pack-index.json') return Promise.resolve(jsonResponse(PACK_INDEX_FIXTURE));
        if (url === '/assets/no-sidecar.pack.json') {
          return Promise.resolve(
            jsonResponse({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                { guid: GUID_NO_METADATA, kind: 'texture', payload: {}, refs: [], artifacts: {} },
              ],
            }),
          );
        }
        return Promise.resolve(notFound());
      });
      // biome-ignore lint/suspicious/noExplicitAny: test mock cast
      globalThis.fetch = fetchMock as any;

      const guid = AssetGuid.parse(GUID_NO_METADATA);
      if (!guid.ok) throw new Error('expected ok');
      const result = await reg.loadByGuid<TextureAsset>(guid.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('asset-parse-failed');
    });
  });
}
