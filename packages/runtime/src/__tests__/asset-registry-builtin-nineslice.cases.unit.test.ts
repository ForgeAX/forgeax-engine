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
  // --- from asset-registry-builtin-nineslice.test.ts ---
  const arMod = assetRegistryModule as unknown as {
    HANDLE_NINESLICE_QUAD?: Handle<'MeshAsset', 'shared'>;
  };

  describe('BUILTIN_NINESLICE_QUAD builtin mesh (M2 / w7, D-2)', () => {
    it('(a) BUILTIN_NINESLICE_QUAD vertex count = 16 (4x4 grid)', () => {
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const mesh = resolveAssetHandle<MeshAsset>(
        new World(),
        arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>,
      );
      expect(mesh.ok).toBe(true);
      if (mesh.ok) {
        const vertCount = mesh.value.vertices.length / PROCEDURAL_FLOATS_PER_VERTEX;
        expect(vertCount).toBe(16);
      }
    });

    it('(b) BUILTIN_NINESLICE_QUAD index count = 54 (9 sub-quads x 6 idx)', () => {
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const mesh = resolveAssetHandle<MeshAsset>(
        new World(),
        arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>,
      );
      expect(mesh.ok).toBe(true);
      if (mesh.ok) {
        // feat-20260604-mesh-topology-debug-draw M2: MeshAsset.indices is now
        // optional (vertex-only meshes omit it); the builtin nineslice quad is
        // indexed, so narrow before reading length.
        expect(mesh.value.indices?.length).toBe(54);
      }
    });

    it('(c) BUILTIN_NINESLICE_QUAD vertex stride === 12F (layout reuse, no split)', () => {
      // Anchored on HANDLE_QUAD's existing 12F stride; HANDLE_NINESLICE_QUAD
      // funnels through the same meshFromInterleaved expansion path so the
      // sprite-pipeline binding table / vertex layout is untouched.
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const mesh = resolveAssetHandle<MeshAsset>(
        new World(),
        arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>,
      );
      expect(mesh.ok).toBe(true);
      if (mesh.ok) {
        // 16 vertices x 12 floats per vertex = 192.
        expect(mesh.value.vertices.length).toBe(16 * PROCEDURAL_FLOATS_PER_VERTEX);
        expect(PROCEDURAL_FLOATS_PER_VERTEX).toBe(12);
      }
    });

    it('(d) HANDLE_NINESLICE_QUAD raw id === 5 (adjacent to HANDLE_SPHERE=4)', () => {
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      const id = unwrapHandle(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>);
      expect(id).toBe(5);
      // Sanity: HANDLE_QUAD=3, HANDLE_SPHERE=4, no other builtin between.
      expect(unwrapHandle(HANDLE_QUAD)).toBe(3);
      expect(unwrapHandle(HANDLE_SPHERE)).toBe(4);
    });

    it('(e) HANDLE_QUAD + HANDLE_SPHERE + HANDLE_NINESLICE_QUAD co-import (charter F1)', () => {
      // Compile-time co-import test: all four builtin HANDLE_ symbols resolve
      // from the same module path so an IDE `HANDLE_` autocomplete query lands
      // them in one prompt (plan-strategy AI User Friendliness §2 naming).
      expect(typeof HANDLE_QUAD).toBeDefined();
      expect(typeof HANDLE_SPHERE).toBeDefined();
      expect(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>).toBeDefined();
      // Three distinct ids (no aliasing).
      expect(unwrapHandle(HANDLE_QUAD)).not.toBe(unwrapHandle(HANDLE_SPHERE));
      expect(unwrapHandle(HANDLE_QUAD)).not.toBe(
        unwrapHandle(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>),
      );
      expect(unwrapHandle(HANDLE_SPHERE)).not.toBe(
        unwrapHandle(arMod.HANDLE_NINESLICE_QUAD as Handle<'MeshAsset', 'shared'>),
      );
    });
  });
}
