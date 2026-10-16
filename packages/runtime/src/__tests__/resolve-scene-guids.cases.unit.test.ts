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
  // --- from resolve-scene-guids.test.ts ---
  // A non-builtin user mesh GUID. Must not collide with the builtin mesh GUIDs
  // pre-registered by the AssetRegistry constructor (HANDLE_CUBE is
  // cbe42beb-..., etc., feat-20260603 Tier 0) — those now resolve, so reusing
  // one here would make registerWithGuid throw a collision.
  const MESH_GUID_STR = 'b1c2d3e4-f5a6-4b7c-8d9e-0a1b2c3d4e5f';
  const MATERIAL_GUID_STR = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
  const SKELETON_GUID_STR = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const UNREGISTERED_GUID_STR = 'deadbeef-dead-beef-dead-beefdeadbeef';

  function parseGuid(s: string): AssetGuid {
    const parsed = AssetGuid.parse(s);
    if (!parsed.ok) throw new Error(`invalid test GUID: ${s}`);
    return parsed.value;
  }

  /** Build a minimal keyed SceneAsset suitable for _resolveSceneGuids testing. */
  function buildTestAsset(
    nodes: Array<{ localId: number; components: Record<string, Record<string, unknown>> }>,
  ): SceneAsset {
    return {
      kind: 'scene',
      entities: Object.fromEntries(
        nodes.map((n) => [`entity-${n.localId}`, { components: n.components }]),
      ),
    };
  }

  describe('w4 - _resolveSceneGuids success path', () => {
    it('(a) resolves GUID string handle fields to Handle numbers via schema-driven handle<> detection', () => {
      // Register components so World knows their schemas (plan-strategy D-4:
      // _resolveSceneGuids uses world._getComponentByName to read fieldType).
      defineComponent('Transform', { pos: 'array<f32, 3>' });
      const reg = new AssetRegistry(makeMockShaderRegistry());

      // Pre-register mesh asset so resolveGuid finds it.
      const meshGuid = parseGuid(MESH_GUID_STR);
      reg.catalog(meshGuid, {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: { position: new Float32Array(0) },
        materialSlots: [{ slotName: 'Default' }],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
      });

      // Also register material and MeshRenderer in world so we verify
      // multi-handle-type detection (MeshFilter + MeshRenderer both have handle fields).
      const materialGuid = parseGuid(MATERIAL_GUID_STR);
      reg.catalog(materialGuid, {
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'test::dummy' } }],
        values: {},
      });

      // Build a SceneAsset with GUID strings in both MeshFilter.assetHandle and
      // MeshRenderer.material (simulating parseScenePayload refs replacement from M1).
      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            Transform: { pos: [1, 0, 0] },
            MeshFilter: { assetHandle: MESH_GUID_STR },
            MeshRenderer: { materials: [MATERIAL_GUID_STR] },
          },
        },
      ]);

      const world = new World();
      const MeshFilter = defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
      const MeshRenderer = defineComponent('MeshRenderer', {
        materials: 'array<shared<MaterialAsset>>',
      });
      world.components.register(MeshFilter);
      world.components.register(MeshRenderer);

      // Private function access for unit-test isolation (same pattern as parseAssetPayload in
      // asset-registry-scene.test.ts).
      // biome-ignore lint/suspicious/noExplicitAny: private helper access for round-trip test
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      expect(resolvedAsset.kind).toBe('scene');
      expect(Object.keys(resolvedAsset.entities).length).toBe(1);

      const resolvedComp = resolvedAsset.entities['entity-0']?.components as Record<
        string,
        Record<string, unknown>
      >;
      // assetHandle should now be a Handle number (not a string)
      expect(resolvedComp.MeshFilter?.assetHandle).toBeTypeOf('number');
      // materials[0] should also be a Handle number (not a string)
      const matsValue = resolvedComp.MeshRenderer?.materials as readonly unknown[] | undefined;
      expect(Array.isArray(matsValue)).toBe(true);
      expect(matsValue?.[0]).toBeTypeOf('number');
    });

    it('(b) Skin.skeleton field resolves correctly', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const skelGuid = parseGuid(SKELETON_GUID_STR);
      reg.catalog(skelGuid, {
        kind: 'skeleton',
        inverseBindMatrices: new Float32Array(3 * 16),
        jointCount: 3,
      });

      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            Skin: { skeleton: SKELETON_GUID_STR, joints: [1, 2] },
          },
        },
      ]);

      const world = new World();
      const Skin = defineComponent('Skin', {
        skeleton: 'shared<SkeletonAsset>',
        joints: 'array<entity>',
      });
      world.components.register(Skin);

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      const resolvedComp = resolvedAsset.entities['entity-0']?.components as Record<
        string,
        Record<string, unknown>
      >;
      // skeleton should now be a Handle number
      expect(resolvedComp.Skin?.skeleton).toBeTypeOf('number');
      // joints (array<entity>) should NOT be touched — it's not a handle field
      expect(resolvedComp.Skin?.joints).toEqual([1, 2]);
    });

    it('(c) same GUID referenced by multiple nodes resolves to the same Handle number', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const meshGuid = parseGuid(MESH_GUID_STR);
      reg.catalog(meshGuid, {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: { position: new Float32Array(0) },
        materialSlots: [{ slotName: 'Default' }],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
      });

      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            MeshFilter: { assetHandle: MESH_GUID_STR },
          },
        },
        {
          localId: 1,
          components: {
            MeshFilter: { assetHandle: MESH_GUID_STR },
          },
        },
      ]);

      const world = new World();
      const MeshFilter = defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
      world.components.register(MeshFilter);

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      const comp0 = (
        resolvedAsset.entities['entity-0']?.components as Record<string, Record<string, unknown>>
      ).MeshFilter;
      const comp1 = (
        resolvedAsset.entities['entity-1']?.components as Record<string, Record<string, unknown>>
      ).MeshFilter;
      expect(comp0?.assetHandle).toBe(comp1?.assetHandle);
      expect(comp0?.assetHandle).toBeTypeOf('number');
    });

    it('(d) nodes without handle fields pass through unchanged', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const asset = buildTestAsset([{ localId: 0, components: { Transform: { pos: [1, 2, 3] } } }]);

      const world = new World();
      defineComponent('Transform', { pos: 'array<f32, 3>' });

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const resolvedAsset = result.value;
      const comp = (
        resolvedAsset.entities['entity-0']?.components as Record<string, Record<string, unknown>>
      ).Transform;
      expect(comp).toEqual({ pos: [1, 2, 3] });
    });
  });

  describe('w5 - _resolveSceneGuids error path', () => {
    it('(e) unregistered GUID returns asset-not-found with hint containing GUID, localId, and field', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      const asset = buildTestAsset([
        {
          localId: 0,
          components: {
            MeshFilter: { assetHandle: UNREGISTERED_GUID_STR },
          },
        },
      ]);

      const world = new World();
      const MeshFilter = defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
      world.components.register(MeshFilter);

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const e = result.error as { code: string; hint: string };
      expect(e.code).toBe('asset-not-found');
      // Hint must contain the GUID, localId, and field for AI-user debuggability (AC-04)
      expect(e.hint).toContain(UNREGISTERED_GUID_STR);
      expect(e.hint).toContain('entity-0'); // keyed entity address
      expect(e.hint).toContain('assetHandle');
    });

    it('(f) stop-on-first-error: only the first unregistered GUID among multiple nodes is reported', () => {
      const reg = new AssetRegistry(makeMockShaderRegistry());

      // Register the first GUID but not the second — first node (localId=1) should
      // fail before reaching localId=2
      const meshGuid = parseGuid(MESH_GUID_STR);
      reg.catalog(meshGuid, {
        kind: 'mesh',
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
        attributes: { position: new Float32Array(0) },
        materialSlots: [{ slotName: 'Default' }],
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 0,
            vertexCount: 0,
            materialSlot: 0,
            topology: 'triangle-list',
          },
        ],
      });

      const SECOND_UNREGISTERED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      const asset = buildTestAsset([
        {
          localId: 1,
          components: {
            MeshFilter: { assetHandle: UNREGISTERED_GUID_STR },
          },
        },
        {
          localId: 2,
          components: {
            MeshFilter: { assetHandle: SECOND_UNREGISTERED },
          },
        },
      ]);

      const world = new World();
      const MeshFilter = defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
      world.components.register(MeshFilter);

      // biome-ignore lint/suspicious/noExplicitAny: private helper access
      const internal = reg as any as {
        _resolveSceneGuids(
          scene: SceneAsset,
          world: World,
        ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
      };
      const result = internal._resolveSceneGuids(asset, world);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const e = result.error as { code: string; hint: string };
      expect(e.code).toBe('asset-not-found');
      // Hint should reference the first failing node (localId=1), not the second
      expect(e.hint).toContain(UNREGISTERED_GUID_STR);
      expect(e.hint).toContain('entity-1'); // keyed entity address of the first failing node
      // Must NOT contain the second GUID (stopped before reaching it)
      expect(e.hint).not.toContain(SECOND_UNREGISTERED.slice(0, 8)); // prefix match sufficient
    });

    describe('w10 - M3 reverse-decode from envelope.refs + buildSceneChildContext from edge lookup', () => {
      const MATERIAL2_GUID_STR = 'e1e2e3e4-a5a6-4b7c-8d9e-0a1b2c3d4e5f';
      const MATERIAL3_GUID_STR = 'd1d2d3d4-b5b6-4c7d-8e9f-0a1b2c3d4e5f';
      const TEXTURE_GUID_STR = 'cccccccc-aaaa-bbbb-cccc-dddddddddddd';

      function makeTestMesh(): MeshAsset {
        return {
          kind: 'mesh',
          vertices: new Float32Array(0),
          indices: new Uint16Array(0),
          attributes: { position: new Float32Array(0) },
          materialSlots: [{ slotName: 'Default' }],
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 0,
              materialSlot: 0,
              topology: 'triangle-list' as const,
            },
          ],
        };
      }

      function makeTestMaterial(): MaterialAsset {
        return {
          kind: 'material',
          passes: [{ name: 'forward', program: { module: 'test::dummy' } }],
          values: {},
        };
      }

      function registerAsset<T extends Asset>(reg: AssetRegistry, guidStr: string, asset: T): void {
        const guid = parseGuid(guidStr);
        reg.catalog(guid, asset);
      }

      it('(a) per-field equivalence: scalar handle + array handle resolve correctly via envelope.refs', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MESH_GUID_STR, makeTestMesh());
        registerAsset(reg, MATERIAL_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL2_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL3_GUID_STR, makeTestMaterial());

        // Build a scene and catalogue it with refs that carry edge metadata
        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: {
              Transform: { pos: [1, 0, 0] },
              MeshFilter: { assetHandle: MESH_GUID_STR },
              MeshRenderer: {
                materials: [MATERIAL_GUID_STR, MATERIAL2_GUID_STR, MATERIAL3_GUID_STR],
              },
            },
          },
        ]);

        // Catalogue the scene WITH refs edge metadata (envelope.refs path)
        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityKey: 'entity-0',
          },
          {
            guid: MATERIAL_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 0,
            },
            sceneEntityKey: 'entity-0',
          },
          {
            guid: MATERIAL2_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 1,
            },
            sceneEntityKey: 'entity-0',
          },
          {
            guid: MATERIAL3_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 2,
            },
            sceneEntityKey: 'entity-0',
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const world = new World();
        world.components
          .register(defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' }))
          .unwrap();
        world.components
          .register(defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' }))
          .unwrap();

        // biome-ignore lint/suspicious/noExplicitAny: private helper access
        const internal = reg as any as {
          _resolveSceneGuids(
            scene: SceneAsset,
            world: World,
            sceneGuidKey?: string,
          ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
        };
        const result = internal._resolveSceneGuids(sceneAsset, world, sceneGuidStr.toLowerCase());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const resolvedAsset = result.value;
        expect(resolvedAsset.kind).toBe('scene');
        expect(Object.keys(resolvedAsset.entities).length).toBe(1);

        const resolvedComp = resolvedAsset.entities['entity-0']?.components as Record<
          string,
          Record<string, unknown>
        >;
        // Scalar handle
        expect(resolvedComp.MeshFilter?.assetHandle).toBeTypeOf('number');
        // Array handles — all 3 slots
        const mats = resolvedComp.MeshRenderer?.materials as readonly unknown[] | undefined;
        expect(Array.isArray(mats)).toBe(true);
        expect(mats?.length).toBe(3);
        expect(mats?.[0]).toBeTypeOf('number');
        expect(mats?.[1]).toBeTypeOf('number');
        expect(mats?.[2]).toBeTypeOf('number');
        // Each slot has a distinct material GUID → distinct handle
        expect(mats?.[0]).not.toBe(mats?.[1]);
        expect(mats?.[1]).not.toBe(mats?.[2]);
      });

      it('(b) arrayIndex lossless: array<handle<MaterialAsset>> of 3 → each slot gets correct GUID', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MATERIAL_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL2_GUID_STR, makeTestMaterial());
        registerAsset(reg, MATERIAL3_GUID_STR, makeTestMaterial());

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: {
              MeshRenderer: {
                materials: [MATERIAL_GUID_STR, MATERIAL2_GUID_STR, MATERIAL3_GUID_STR],
              },
            },
          },
        ]);

        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MATERIAL_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 0,
            },
            sceneEntityKey: 'entity-0',
          },
          {
            guid: MATERIAL2_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 1,
            },
            sceneEntityKey: 'entity-0',
          },
          {
            guid: MATERIAL3_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 2,
            },
            sceneEntityKey: 'entity-0',
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const world = new World();
        world.components
          .register(defineComponent('MeshRenderer', { materials: 'array<shared<MaterialAsset>>' }))
          .unwrap();

        // biome-ignore lint/suspicious/noExplicitAny: private helper access
        const internal = reg as any as {
          _resolveSceneGuids(
            scene: SceneAsset,
            world: World,
            sceneGuidKey?: string,
          ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
        };
        const result = internal._resolveSceneGuids(sceneAsset, world, sceneGuidStr.toLowerCase());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const resolvedComp = result.value.entities['entity-0']?.components as Record<
          string,
          Record<string, unknown>
        >;
        const mats = resolvedComp.MeshRenderer?.materials as readonly number[] | undefined;
        expect(mats?.length).toBe(3);
        // Verify each slot is a number (resolved handle) and distinct
        expect(typeof mats?.[0]).toBe('number');
        expect(typeof mats?.[1]).toBe('number');
        expect(typeof mats?.[2]).toBe('number');
        // Different GUIDs → different handles
        expect(mats?.[0]).not.toBe(mats?.[1]);
        expect(mats?.[1]).not.toBe(mats?.[2]);
        expect(mats?.[0]).not.toBe(mats?.[2]);
      });

      it('(c) dedup contract: same GUID from multiple entities → same handle', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MESH_GUID_STR, makeTestMesh());

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: { MeshFilter: { assetHandle: MESH_GUID_STR } },
          },
          {
            localId: 1,
            components: { MeshFilter: { assetHandle: MESH_GUID_STR } },
          },
        ]);

        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityKey: 'entity-0',
          },
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityKey: 'entity-1',
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const world = new World();
        world.components
          .register(defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' }))
          .unwrap();

        // biome-ignore lint/suspicious/noExplicitAny: private helper access
        const internal = reg as any as {
          _resolveSceneGuids(
            scene: SceneAsset,
            world: World,
            sceneGuidKey?: string,
          ): { ok: true; value: SceneAsset } | { ok: false; error: unknown };
        };
        const result = internal._resolveSceneGuids(sceneAsset, world, sceneGuidStr.toLowerCase());

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const comp0 = (
          result.value.entities['entity-0']?.components as Record<string, Record<string, unknown>>
        ).MeshFilter;
        const comp1 = (
          result.value.entities['entity-1']?.components as Record<string, Record<string, unknown>>
        ).MeshFilter;
        // Same GUID → same handle (one allocSharedRef per unique payload)
        expect(comp0?.assetHandle).toBe(comp1?.assetHandle);
        expect(comp0?.assetHandle).toBeTypeOf('number');
      });

      it('(d) breadcrumb from envelope.refs: buildSceneChildContext returns correct sceneEntityKey + componentField', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MESH_GUID_STR, makeTestMesh());

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 5,
            components: { MeshFilter: { assetHandle: MESH_GUID_STR } },
          },
        ]);

        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MESH_GUID_STR,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityKey: 'entity-5',
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        const ctx = buildSceneChildContext(reg, sceneAsset, MESH_GUID_STR.toLowerCase());

        expect(ctx).toBeDefined();
        expect(ctx?.sceneEntityKey).toBe('entity-5');
        expect(ctx?.componentField).toBe('MeshFilter.assetHandle');
      });

      it('(e) texture edge: sourceField=undefined → buildSceneChildContext returns componentField undefined', () => {
        const reg = new AssetRegistry(makeMockShaderRegistry());

        registerAsset(reg, MATERIAL_GUID_STR, makeTestMaterial());

        const textureGuid = parseGuid(TEXTURE_GUID_STR);
        reg.catalog(textureGuid, {
          kind: 'texture',
          // biome-ignore lint/suspicious/noExplicitAny: test fixture uses minimal texture shape
          texture: {} as any,
        });

        const sceneGuidStr = '00001111-2222-3333-4444-555566667777';
        const sceneGuid = parseGuid(sceneGuidStr);
        const sceneAsset = buildTestAsset([
          {
            localId: 0,
            components: {
              MeshRenderer: { materials: [MATERIAL_GUID_STR] },
            },
          },
        ]);

        // Scene refs include a texture edge (flat superset per D-2) with
        // sourceField=undefined — texture has no per-entity origin.
        const refs: import('@forgeax/engine-types').AssetRef[] = [
          {
            guid: MATERIAL_GUID_STR,
            sourceField: {
              componentName: 'MeshRenderer',
              fieldName: 'materials',
              arrayIndex: 0,
            },
            sceneEntityKey: 'entity-0',
          },
          {
            guid: TEXTURE_GUID_STR,
            // sourceField intentionally omitted — texture edge, D-2
            sceneEntityKey: undefined,
          },
        ];
        reg.catalog(sceneGuid, sceneAsset, refs);

        // Look up the material GUID — should find sceneEntityKey + componentField
        const materialCtx = buildSceneChildContext(
          reg,
          sceneAsset,
          MATERIAL_GUID_STR.toLowerCase(),
        );
        expect(materialCtx).toBeDefined();
        expect(materialCtx?.componentField).toBe('MeshRenderer.materials[0]');

        // Look up the texture GUID — sourceField=undefined → componentField undefined
        const textureCtx = buildSceneChildContext(reg, sceneAsset, TEXTURE_GUID_STR.toLowerCase());
        expect(textureCtx).toBeDefined();
        expect(textureCtx?.sceneEntityKey).toBeUndefined();
        expect(textureCtx?.componentField).toBeUndefined();
      });
    });
  });
}
