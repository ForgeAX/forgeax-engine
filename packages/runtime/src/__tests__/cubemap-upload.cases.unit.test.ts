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
  // --- from cubemap-upload.test.ts ---
  // feat-20260601-device/gpu-residency-extraction M1: uploadCubemapFromEquirect
  // moved to GpuResidencyCache. The store holds no registry reference (D-2/D-3);
  // the cube POD register-relay is injected at configureGpuDevice (D-3) and the
  // source POD is passed to the call. feat-20260614 M8: column handles are
  // minted by the World, so the relay is `(world, pod) => ok(world.allocSharedRef(...))`.

  interface SubmitProbe {
    submitCalls: number;
  }

  // biome-ignore lint/suspicious/noExplicitAny: opaque mock surface
  function makeMockDevice(probe: SubmitProbe): any {
    const okShim = <T>(v: T) => ({ ok: true as const, value: v });
    const mockOpaque = { __mock: 'opaque' };
    const makePass = () => ({
      setPipeline: () => {},
      setBindGroup: () => {},
      setVertexBuffer: () => {},
      draw: () => {},
      end: () => {},
    });
    return {
      createShaderModule: () => okShim(mockOpaque),
      createBindGroupLayout: () => okShim(mockOpaque),
      createPipelineLayout: () => okShim(mockOpaque),
      createRenderPipeline: () => okShim(mockOpaque),
      createBindGroup: () => okShim(mockOpaque),
      createBuffer: () => okShim(mockOpaque),
      createTexture: () => okShim(mockOpaque),
      createTextureView: () => okShim(mockOpaque),
      createSampler: () => okShim(mockOpaque),
      createCommandEncoder: () =>
        okShim({
          beginRenderPass: () => makePass(),
          finish: () => okShim(mockOpaque),
        }),
      queue: {
        writeBuffer: () => okShim(undefined),
        writeTexture: () => okShim(undefined),
        submit: () => {
          probe.submitCalls += 1;
          return okShim(undefined);
        },
        onSubmittedWorkDone: async () => {},
      },
    };
  }

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

  function makeEquirect(): EquirectAsset {
    return {
      kind: 'equirect',
      width: 4,
      height: 2,
      format: 'rgba16float' as TextureFormat,
      data: new Uint8Array(4 * 2 * 8),
      colorSpace: 'linear',
    };
  }

  describe('t10 -- equirect-to-cubemap projection contract (internal)', () => {
    it('(a) returns Handle<EquirectAsset> cube handle for a valid EquirectAsset source', async () => {
      const probe: SubmitProbe = { submitCalls: 0 };
      const device = makeMockDevice(probe);
      const world = new World();
      const store = new GpuResidencyCache();
      const equirect = makeEquirect();
      // feat-20260614 M8: column handles are minted by the World, not the
      // registry. The cube register-relay also mints via world.allocSharedRef.
      const sourceHandle = world.allocSharedRef('EquirectAsset', equirect);
      store.configureGpuDevice(
        device,
        async (_d, desc) =>
          // biome-ignore lint/suspicious/noExplicitAny: shader factory shim
          rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as any,
        (w, pod: EquirectAsset) => rhiOk(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );
      store.configureIblDevice(
        device,
        async (_d, desc) => rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as never,
      );
      store.bindDeviceScope(DeviceScope.create(0, 'asset-unit-t10'));
      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const result = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, equirect);
      expect(result.ok).toBe(true);
    });

    it('(c) rejects non-HDR-float input with invalid-source-format', async () => {
      const probe: SubmitProbe = { submitCalls: 0 };
      const device = makeMockDevice(probe);
      const world = new World();
      const store = new GpuResidencyCache();
      const ldr: EquirectAsset = {
        kind: 'equirect',
        width: 64,
        height: 64,
        format: 'rgba8unorm' as TextureFormat,
        data: new Uint8Array(64 * 64 * 4),
        colorSpace: 'srgb',
      };
      const sourceHandle = world.allocSharedRef('EquirectAsset', ldr);
      store.configureGpuDevice(
        device,
        undefined,
        (w, pod: EquirectAsset) => rhiOk(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );
      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const result = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, ldr);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid-source-format');
      }
    });

    it('(d) source POD fetch surfaces asset-not-found for unresolvable handle', () => {
      // Pull-model migration: the cube upload takes a source POD; a missing
      // source surfaces when the caller resolves the handle to a payload first.
      const world = new World();
      const bogus = toShared<'TextureAsset'>(99999);
      const podRes = resolveAssetHandle<TextureAsset>(world, bogus);
      expect(podRes.ok).toBe(false);
      if (!podRes.ok) {
        expect(podRes.error.code).toBe('asset-not-found');
      }
    });
  });

  describe('t54 (M3.5) -- AC-03 idempotent at GPU-dispatch layer', () => {
    it('(b1) second uploadCubemapFromEquirect with same source does NOT re-dispatch', async () => {
      const probe: SubmitProbe = { submitCalls: 0 };
      const device = makeMockDevice(probe);
      const world = new World();
      const store = new GpuResidencyCache();
      const equirect = makeEquirect();
      const sourceHandle = world.allocSharedRef('EquirectAsset', equirect);
      store.configureGpuDevice(
        device,
        async (_d, desc) =>
          // biome-ignore lint/suspicious/noExplicitAny: shader factory shim
          rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as any,
        (w, pod: EquirectAsset) => rhiOk(w.allocSharedRef('EquirectAsset', pod)),
        mockCaps,
      );
      store.configureIblDevice(
        device,
        async (_d, desc) => rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as never,
      );
      store.bindDeviceScope(DeviceScope.create(1, 'asset-unit-t54'));

      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const r1 = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, equirect);
      const firstSubmits = probe.submitCalls;
      expect(firstSubmits).toBeGreaterThanOrEqual(1);

      // biome-ignore lint/suspicious/noExplicitAny: package-internal projection reached via store cast
      const r2 = await (store as any)._uploadCubemapFromEquirect(world, sourceHandle, equirect);
      // Second call returns the cached handle without dispatching again.
      expect(probe.submitCalls).toBe(firstSubmits);

      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        // (b3) returned Handle has identical numeric id.
        expect(JSON.stringify(r1.value)).toBe(JSON.stringify(r2.value));
      }
    });
  });
}
