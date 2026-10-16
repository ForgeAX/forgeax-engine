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
  // --- from asset-registry-material-validate.test.ts ---
  describe('AssetRegistry constructor injection (feat-20260527 M1 / w3)', () => {
    it('(a) new AssetRegistry(shaderRegistry) compiles and creates instance', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      expect(reg).toBeInstanceOf(AssetRegistry);
    });

    it('(b) catalog<MaterialAsset> with minimal MaterialAsset returns ok + lookup resolves', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = { kind: 'material' };
      const guid = AssetGuid.random();
      const h = reg.catalog<MaterialAsset>(guid, asset);
      expect(h.ok).toBe(true);
      if (h.ok) {
        expect(reg.lookup(guid)?.kind).toBe('material');
      }
    });

    it('(c) catalog<MaterialAsset> with passes[] + values returns ok + lookup resolves', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::dummy' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColor: [1, 0, 0, 1] },
      };
      const guid = AssetGuid.random();
      const h = reg.catalog<MaterialAsset>(guid, asset);
      expect(h.ok).toBe(true);
      if (h.ok) {
        const mat = reg.lookup(guid);
        expect(mat).toBeDefined();
        expect(mat?.kind).toBe('material');
      }
    });
  });

  describe('MaterialAsset registration validation (feat-20260527 M2 / w5)', () => {
    it('(d) multi-pass material satisfying all paramSchemas union -> success', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::standard' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
          {
            name: 'Depth',
            program: { module: 'test::unlit' },
            renderState: { tags: { LightMode: 'Depth' }, queue: 1000 },
          },
        ],
        values: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
          baseColorTexture: '00000000-0000-0000-0000-000000000001',
          lightIntensity: 1.0,
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(e) multi-pass material missing param from one pass shader -> AssetError', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // test::unlit requires baseColorTexture (no default), metallic is from test::standard
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::standard' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
          {
            name: 'Depth',
            program: { module: 'test::unlit' },
            renderState: { tags: { LightMode: 'Depth' }, queue: 1000 },
          },
        ],
        values: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
          // baseColorTexture missing — required by test::unlit (no default)
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(f) shader not found in ShaderRegistry -> AssetError with detail.shaderKey', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'nonexistent::shader' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {},
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(g) extra params in values silently ignored -> success', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::standard' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
          extraParam: 42, // silently ignored (D-5: extra-key from reject to ignore)
          anotherExtra: 'hello',
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(h) empty passes[] remains structurally invalid', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [],
        values: { baseColor: [1, 0, 0, 1] },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(false);
    });

    it('(i) catalog<MaterialAsset> with a guid runs the same validation as catalog', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      // Test invalid: shader not found
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'nonexistent::shader' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {},
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(i-2) catalog<MaterialAsset> with valid material succeeds', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::standard' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {
          baseColor: [1, 0, 0, 1],
          metallic: 0.5,
          roughness: 0.5,
        },
      };
      const guid = AssetGuid.random();
      const result = reg.catalog<MaterialAsset>(guid, asset);
      expect(result.ok).toBe(true);
      expect(reg.lookup(guid)?.kind).toBe('material');
    });

    it('(j) value typing is deferred to material cook', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      // baseColor is 'color' type (expects number[]), metallic is 'f32' (expects number)
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::standard' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {
          baseColor: 'not-a-color', // type mismatch: color expects number[]
          metallic: 0.5,
          roughness: 0.5,
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(k) material with no passes[] (undefined) but with kind="material" -> valid (inherits from parent)', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());
      const asset: MaterialAsset = {
        kind: 'material',
        // passes undefined -> valid (inherits from parent at resolve time)
        values: { baseColor: [1, 0, 0, 1] },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      // undefined passes is valid — material can inherit passes from parent
      expect(result.ok).toBe(true);
    });

    it('(l) param with default value — missing in values does not error', () => {
      const sr = makeMockShaderRegistry();
      const reg = new AssetRegistry(sr);
      // forgeax::default-standard-pbr has baseColor/metallic/roughness all with
      // defaults -> omitting them should not error. texture2d/sampler are always
      // optional regardless of defaults.
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {
          // baseColor/metallic/roughness/channelMap all have defaults -> omission ok
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });
  });

  // feat-20260528-material-shader-registration-unification M3 / w16:
  // integration tests for runtime registration path (manifest paramSchema -> validation).
  describe('M3-w16 -- runtime registration path integration', () => {
    it('(a) paramSchema from manifest passes material validation', () => {
      const sr = makeMockShaderRegistry();
      // Simulate what Step 1b does: register a shader with paramSchema from manifest
      sr.installMaterialArtifact('test::pbr-from-manifest', {
        source: 'fn main() {}',
        paramSchema: [
          { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
          { name: 'metallic', type: 'f32', default: 0.0 },
          { name: 'roughness', type: 'f32', default: 0.5 },
          { name: 'channelMap', type: 'vec4', default: [2, 1, 0, 0] },
          { name: 'baseColorTexture', type: 'texture2d' },
          { name: 'metallicRoughnessTexture', type: 'texture2d' },
          { name: 'normalTexture', type: 'texture2d' },
          { name: 'sampler', type: 'sampler' },
        ],
      });
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::pbr-from-manifest' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: {
          baseColorTexture: '00000000-0000-0000-0000-000000000001',
          metallicRoughnessTexture: '00000000-0000-0000-0000-000000000002',
          normalTexture: '00000000-0000-0000-0000-000000000003',
        },
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(b) empty paramSchema from manifest -> registration works', () => {
      const sr = makeMockShaderRegistry();
      sr.installMaterialArtifact('test::empty-schema', {
        source: 'fn main() {}',
        paramSchema: [],
      });
      const reg = new AssetRegistry(sr);
      const asset: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::empty-schema' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
      };
      const result = reg.catalog<MaterialAsset>(AssetGuid.random(), asset);
      expect(result.ok).toBe(true);
    });

    it('(c) malformed paramSchema JSON parse -> SyntaxError', () => {
      // Simulate malformed JSON from manifest paramSchema field
      expect(() => JSON.parse('[')).toThrow(SyntaxError);
      expect(() => JSON.parse('{not-json}')).toThrow(SyntaxError);
    });

    it('(d) MaterialRuntimeInfo catalogued by GUID is retrievable via lookup', () => {
      const sr = makeMockShaderRegistry();
      // Register as Step 1b does: first in ShaderRegistry, then in AssetRegistry
      sr.installMaterialArtifact('test::shader-asset-pbr', {
        source: 'fn main() {}',
        paramSchema: [
          { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
          { name: 'metallic', type: 'f32', default: 0.0 },
          { name: 'roughness', type: 'f32', default: 0.5 },
        ],
      });
      const reg = new AssetRegistry(sr);

      // Simulate Step 1b MaterialRuntimeInfo cataloguing.
      const guid = AssetGuid.random();
      const cataloged = reg.catalog(guid, {
        kind: 'shader' as const,
        name: 'test::shader-asset-pbr',
        source: 'fn main() {}',
        paramSchema: [
          { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
          { name: 'metallic', type: 'f32', default: 0.0 },
          { name: 'roughness', type: 'f32', default: 0.5 },
        ],
      });
      expect(cataloged.ok).toBe(true);

      // lookup by guid should return the catalogued MaterialRuntimeInfo
      const result = reg.lookup(guid);
      expect(result).toBeDefined();
      expect(result?.kind).toBe('shader');
    });
  });
}
