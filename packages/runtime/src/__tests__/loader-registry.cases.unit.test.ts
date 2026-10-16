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
  // --- from loader-registry.test.ts ---
  function stubLoader(kind: string): Loader {
    return { kind, load: () => undefined };
  }

  describe('LoaderRegistry (w2)', () => {
    it('register then get returns the registered loader', () => {
      const reg = new LoaderRegistry();
      const mesh = stubLoader('mesh');
      reg.register(mesh);
      expect(reg.get('mesh')).toBe(mesh);
    });

    it('get on an unregistered kind returns undefined', () => {
      const reg = new LoaderRegistry();
      expect(reg.get('mesh')).toBeUndefined();
    });

    it('rejects re-registering the same kind and preserves the first owner', () => {
      const reg = new LoaderRegistry();
      const first = stubLoader('mesh');
      const second = stubLoader('mesh');
      reg.register(first);
      expect(() => reg.register(second)).toThrow(
        'LoaderRegistry.register: duplicate loader kind "mesh"',
      );
      expect(reg.get('mesh')).toBe(first);
      // registeredKinds carries one entry, not two duplicates.
      expect(reg.registeredKinds().filter((k) => k === 'mesh')).toHaveLength(1);
    });

    it('registeredKinds reflects insertion order', () => {
      const reg = new LoaderRegistry();
      reg.register(stubLoader('mesh'));
      reg.register(stubLoader('scene'));
      expect(reg.registeredKinds()).toEqual(['mesh', 'scene']);
    });

    it('fail-fast: register throws on empty kind', () => {
      const reg = new LoaderRegistry();
      expect(() => reg.register({ kind: '', load: () => undefined })).toThrow(TypeError);
    });

    it('fail-fast: register throws when load is not a function', () => {
      const reg = new LoaderRegistry();
      // Intentionally malformed loader to exercise the wire-time guard.
      expect(() =>
        reg.register({ kind: 'mesh', load: undefined as unknown as Loader['load'] }),
      ).toThrow(TypeError);
    });
  });

  // A LoadContext that serves canned binaries / refs.
  function mockCtx(opts?: {
    binaries?: Record<string, Uint8Array>;
    refs?: Record<string, number>;
  }): LoadContext {
    const ctx: LoadContext = {
      fetchBinary: async (url: string) => {
        const b = opts?.binaries?.[url];
        return b !== undefined
          ? { ok: true as const, value: b }
          : { ok: false as const, error: new Error(`no binary for ${url}`) };
      },
      resolveRef: async (guid: string) => {
        const h = opts?.refs?.[guid];
        return h !== undefined
          ? { ok: true as const, value: h }
          : { ok: false as const, error: new Error(`no ref for ${guid}`) };
      },
      transcodeCaps: { bc: false, etc2: false, astc: false },
      device: undefined,
    };
    return ctx;
  }

  describe('inline pack-payload loaders (w4)', () => {
    it('INLINE_PACK_LOADERS covers the complete inline kinds in order', () => {
      expect(INLINE_PACK_LOADERS.map((l) => l.kind)).toEqual([
        'mesh',
        'scene',
        'sampler',
        'material',
        'skeleton',
        'skin',
        'animation-clip',
        'animation-graph',
        'render-pipeline',
        'tileset',
        'audio',
        'particle-effect',
      ]);
    });

    it('meshLoader builds a MeshAsset POD from array payload', () => {
      const out = meshLoader.load(
        { vertices: [0, 0, 0, 0, 0, 1, 0, 0], indices: [0, 1, 2] },
        undefined,
        mockCtx(),
      );
      // feat-20260608 M5 / w27: meshLoader auto-fills a default single
      // triangle-list submesh covering the full index/vertex range.
      expect(out).toMatchObject({
        kind: 'mesh',
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 3,
            vertexCount: 8,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
      });
      expect((out as { vertices: Float32Array }).vertices).toBeInstanceOf(Float32Array);
    });

    it('sceneLoader produces a SceneAsset for a valid payload', () => {
      const out = sceneLoaderLoad({ entities: { 'entity-0': { components: {} } } }, undefined);
      expect(out).toMatchObject({ kind: 'scene' });
    });

    it('sceneLoader returns structured error { ok: false } on refs out-of-bounds (F21)', () => {
      const ctx = mockCtx();
      const out = sceneLoader.load(
        { entities: { 'entity-7': { components: { MeshFilter: { assetHandle: 5 } } } } },
        ['guid-a'], // length 1; index 5 is out of bounds
        ctx,
      );
      expect(out).toBeDefined();
      // F21: sceneLoader now returns { ok: false, error: ParseErrorDetail }
      // instead of writing to ctx.reportParseError.
      const errResult = out as {
        ok: boolean;
        error?: { entityKey: string; index: number; refsLength: number };
      };
      expect(errResult.ok).toBe(false);
      expect(errResult.error).toMatchObject({ entityKey: 'entity-7', index: 5, refsLength: 1 });
    });

    it('materialLoader carries parentGuid resolved from refs index', () => {
      const out = materialLoader.load({ parent: 0, values: {} }, ['parent-guid'], mockCtx());
      expect(out).toMatchObject({ kind: 'material', parentGuid: 'parent-guid' });
    });

    it('materialLoader resolves an explicit heightTexture ref index to its GUID (M4 / w22, D-19)', () => {
      // Texture references use the explicit `{ texture: refsIndex }` wire
      // shape. This remains safe when the shader is not registered because
      // the loader does not guess whether a bare integer is a scalar.
      const out = materialLoader.load(
        {
          passes: [{ shader: 'test' }],
          values: { heightTexture: { texture: 0 } },
        },
        ['height-guid'],
        mockCtx(),
      );
      expect(out).toMatchObject({ kind: 'material' });
      expect((out as Record<string, unknown>)?.values?.heightTexture).toEqual({
        texture: 'height-guid',
      });
    });

    it('materialLoader returns normally when values has no heightTexture field', () => {
      const out = materialLoader.load(
        {
          passes: [{ shader: 'test' }],
          values: { baseColorTexture: 0 },
        },
        [],
        mockCtx(),
      );
      expect(out).toMatchObject({ kind: 'material' });
      // baseColorTexture refs-index 0 is OOB (refs.length=0), so
      // the field is dropped. The loader still returns a valid material
      // asset -- no throw, no undefined.
    });

    it('skeletonLoader rejects ibm byteLength / jointCount mismatch', () => {
      const out = skeletonLoader.load(
        { inverseBindMatrices: new Float32Array(8), jointCount: 2 },
        undefined,
        mockCtx(),
      );
      expect(out).toBeUndefined(); // 8 floats != 2 * 16
    });

    it('skinLoader + animationClipLoader build their PODs', () => {
      expect(
        skinLoader.load({ skeletonGuid: 'g', jointPaths: ['a'] }, undefined, mockCtx()),
      ).toMatchObject({ kind: 'skin' });
      expect(
        animationClipLoader.load({ duration: 1, channels: [] }, undefined, mockCtx()),
      ).toMatchObject({ kind: 'animation-clip' });
    });

    // bug-20260611: skeletonLoader + animationClipLoader must accept the
    // post-`JSON.stringify` shape of every typed-array field (Float32Array
    // serialises to a `number[]` via `normaliseForPack` so the dev pack body
    // is JSON-roundtrip safe). Without the array arm, every Skin-bearing
    // glTF (Khronos Fox.glb) trips `asset-parse-failed` in the browser even
    // though the dawn-smoke / direct-`register` paths stay green because they
    // skip the JSON round-trip entirely.
    it('skeletonLoader accepts inverseBindMatrices as number[] (JSON-roundtrip shape)', () => {
      const ibmFloat = new Float32Array(16);
      for (let i = 0; i < 16; i++) ibmFloat[i] = i * 0.5;
      const roundTripped = JSON.parse(
        JSON.stringify({
          inverseBindMatrices: Array.from(ibmFloat),
          jointCount: 1,
        }),
      ) as Record<string, unknown>;
      const out = skeletonLoader.load(roundTripped, undefined, mockCtx()) as
        | { kind: 'skeleton'; inverseBindMatrices: Float32Array; jointCount: number }
        | undefined;
      expect(out).toBeDefined();
      expect(out?.inverseBindMatrices).toBeInstanceOf(Float32Array);
      expect(Array.from(out?.inverseBindMatrices ?? new Float32Array())).toEqual(
        Array.from(ibmFloat),
      );
      expect(out?.jointCount).toBe(1);
    });

    it('animationClipLoader accepts sampler.input/output as number[] (JSON-roundtrip shape)', () => {
      const inputFloat = new Float32Array([0, 0.5, 1]);
      const outputFloat = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
      const payload = JSON.parse(
        JSON.stringify({
          duration: 1,
          channels: [
            {
              targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
              property: 'rotation',
              sampler: {
                input: Array.from(inputFloat),
                output: Array.from(outputFloat),
                interpolation: 'LINEAR',
              },
            },
          ],
        }),
      ) as Record<string, unknown>;
      const out = animationClipLoader.load(payload, undefined, mockCtx()) as
        | {
            kind: 'animation-clip';
            channels: ReadonlyArray<{
              sampler: { input: Float32Array; output: Float32Array };
            }>;
          }
        | undefined;
      expect(out).toBeDefined();
      expect((out?.channels[0] as { targetId?: string } | undefined)?.targetId).toBe(
        'a95da0ec669189f98273e8f86d8ad9f2',
      );
      expect(out?.channels[0]?.sampler.input).toBeInstanceOf(Float32Array);
      expect(out?.channels[0]?.sampler.output).toBeInstanceOf(Float32Array);
      expect(Array.from(out?.channels[0]?.sampler.input ?? new Float32Array())).toEqual([
        0, 0.5, 1,
      ]);
    });
  });

  function sceneLoaderLoad(payload: Record<string, unknown>, refs: string[] | undefined) {
    return sceneLoader.load(payload, refs, mockCtx());
  }

  describe('Pack v2 artifact loaders', () => {
    it('PACK_ARTIFACT_LOADERS includes descriptor-backed ordinary kinds', () => {
      expect(PACK_ARTIFACT_LOADERS.map((l) => l.kind)).toEqual([
        'texture',
        'font',
        'equirect',
        'render-pipeline',
        'tileset',
      ]);
    });

    it('textureLoader import sub-branch builds a TextureAsset POD from .bin bytes', async () => {
      const data = new Uint8Array(2 * 2 * 4).fill(200);
      const input = {
        guid: '11111111-1111-4111-8111-111111111111',
        kind: 'texture',
        payload: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          mips: { kind: 'none' },
        },
        refs: [],
        artifacts: {
          body: {
            descriptor: { path: 'tex.bin', mediaType: 'application/x-forgeax-rgba8' },
            bytes: data,
          },
        },
      };
      const out = await textureLoader.loadPack?.(input, mockCtx());
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.value).toMatchObject({
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
        });
      }
    });

    it('textureLoader fails image-meta-missing when metadata is absent', async () => {
      const out = await textureLoader.loadPack?.(
        {
          guid: '11111111-1111-4111-8111-111111111111',
          kind: 'texture',
          payload: { kind: 'texture' },
          refs: [],
          artifacts: {},
        },
        mockCtx(),
      );
      expect(out.ok).toBe(false);
    });

    it('fontLoader resolves atlas/sampler refs and builds a FontAsset POD', async () => {
      const input = {
        guid: '11111111-1111-1111-1111-111111111111',
        kind: 'font',
        payload: {
          atlasGuid: '22222222-2222-2222-2222-222222222222',
          samplerGuid: '33333333-3333-3333-3333-333333333333',
          glyphs: {},
          common: {
            lineHeight: 1,
            base: 1,
            distanceRange: 2,
            pxRange: 2,
            atlasWidth: 64,
            atlasHeight: 64,
          },
        },
        refs: ['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'],
        artifacts: {},
      };
      const out = await fontLoader.loadPack?.(
        input,
        mockCtx({
          refs: {
            '22222222-2222-2222-2222-222222222222': 42,
            '33333333-3333-3333-3333-333333333333': 43,
          },
        }),
      );
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.value).toMatchObject({ kind: 'font' });
      }
    });
  });
}
