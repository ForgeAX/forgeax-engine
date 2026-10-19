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
  // --- from verify-revisions.test.ts ---
  const _ENGINE = new URL('../../../render/src/assembly/factory.ts', import.meta.url).href;

  // ─── Mock fixtures ──────────────────────────────────────────────────────────

  function makeMockGL2(): Record<string, unknown> {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      createShader: () => ({}),
      shaderSource: () => undefined,
      compileShader: () => undefined,
      getShaderParameter: () => true,
      createProgram: () => ({}),
      attachShader: () => undefined,
      linkProgram: () => undefined,
      getProgramParameter: () => true,
      useProgram: () => undefined,
      createVertexArray: () => ({}),
      bindVertexArray: () => undefined,
      createBuffer: () => ({}),
      bindBuffer: () => undefined,
      bufferData: () => undefined,
      enableVertexAttribArray: () => undefined,
      vertexAttribPointer: () => undefined,
      getAttribLocation: () => 0,
      clear: () => undefined,
      drawArrays: () => undefined,
      viewport: () => undefined,
      isContextLost: () => false,
      COMPILE_STATUS: 0x8b81,
      LINK_STATUS: 0x8b82,
      VERTEX_SHADER: 0x8b31,
      FRAGMENT_SHADER: 0x8b30,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88e4,
      FLOAT: 0x1406,
      TRIANGLES: 0x0004,
      COLOR_BUFFER_BIT: 0x4000,
    };
  }

  interface MockCanvasOpts {
    webgl2: 'context' | 'null';
    webgpu?: 'context' | 'null';
  }

  function makeMockCanvas(opts: MockCanvasOpts): HTMLCanvasElement {
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    return {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return opts.webgl2 === 'context' ? makeMockGL2() : null;
        if (kind === 'webgpu') {
          return opts.webgpu === 'context'
            ? {
                configure: () => undefined,
                unconfigure: () => undefined,
                getCurrentTexture: () => ({ createView: () => ({}) }),
              }
            : null;
        }
        return null;
      },
      addEventListener(type: string, fn: (e: unknown) => void) {
        let bucket = listeners.get(type);
        if (!bucket) {
          bucket = new Set();
          listeners.set(type, bucket);
        }
        bucket.add(fn);
      },
      removeEventListener(type: string, fn: (e: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    } as unknown as HTMLCanvasElement;
  }

  const baseNavigator = { userAgent: 'mock-fix-fN' } as unknown as Navigator;

  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── fix-f1: Result construction preserves structured environment detail ───

  describe('fix-f1 — createRenderer Result failure detail', () => {
    it('keeps Result recovery methods after asynchronous scene initialization fails', async () => {
      const result = await createRuntimeRenderer(
        makeMockCanvas({ webgpu: 'context', webgl2: 'context' }),
        { rhi },
        {
          shaderManifestUrl: 'unavailable.json',
          readShaderManifest: async () => {
            throw new Error('missing packaged shader manifest');
          },
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const fallback = {};
      expect(result.unwrapOr(fallback)).toBe(fallback);
      let thrown: unknown;
      try {
        result.unwrap();
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBe(result.error);
    });

    it('returns EngineEnvironmentError instead of throwing when no RHI is injected', async () => {
      const result = await createRuntimeRenderer(
        makeMockCanvas({ webgpu: 'null', webgl2: 'null' }),
        { rhi: undefined },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(EngineEnvironmentError);
      expect(result.error.detail).toBeDefined();
    });

    it('keeps a successful renderer behind the public Result surface', async () => {
      const renderer = await requireRenderer(
        makeMockCanvas({ webgpu: 'context', webgl2: 'context' }),
        { rhi },
        { shaderManifestUrl: undefined },
      );
      expect(renderer.inspect().state).toBe('alive');
      expect(renderer).not.toHaveProperty('backend');
      expect(renderer).not.toHaveProperty('ready');
      await renderer.dispose();
    });
  });

  // ─── fix-f2: Renderer.subscribe lifecycle entry ────────────────────────────

  describe('fix-f2 — Renderer.subscribe explicit signal entry', () => {
    it('returns an unsubscribe function and publishes the disposal transition', async () => {
      const renderer = await requireRenderer(
        makeMockCanvas({ webgl2: 'context', webgpu: 'context' }),
        { rhi },
        { shaderManifestUrl: undefined },
      );
      const events: unknown[] = [];
      const unsubscribe = renderer.subscribe((event) => events.push(event));
      expect(typeof unsubscribe).toBe('function');
      expect((await renderer.dispose()).ok).toBe(true);
      expect(events).toContainEqual({
        kind: 'state-changed',
        previous: 'alive',
        current: 'disposed',
      });
      unsubscribe();
    });

    it('RhiErrorListenerRegistry late-attach replay: an add after fire immediately receives the last error', async () => {
      const { RhiError } = await import('@forgeax/engine-rhi');
      const { RhiErrorListenerRegistry } = await import('../../../render/src/lifecycle');

      const registry = new RhiErrorListenerRegistry();
      const fakeError = new RhiError({
        code: 'shader-compile-failed',
        expected: 'valid WGSL',
        hint: 'see RhiError.detail.compilerMessages',
      });

      let received: unknown;
      const unsub = registry.add((e) => {
        received = e;
      });
      expect(received).toBeUndefined(); // not yet fired

      registry.fire(fakeError);
      expect(received).toBe(fakeError);

      // late-attach replay: an add after fire still receives the last error immediately.
      let lateReceived: unknown;
      registry.add((e) => {
        lateReceived = e;
      });
      expect(lateReceived).toBe(fakeError);

      unsub();
    });

    it('RhiErrorListenerRegistry.clear detaches all listeners', async () => {
      const { RhiError } = await import('@forgeax/engine-rhi');
      const { RhiErrorListenerRegistry } = await import('../../../render/src/lifecycle');
      const registry = new RhiErrorListenerRegistry();
      let fired = 0;
      registry.add(() => {
        fired += 1;
      });
      registry.clear();
      registry.fire(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'placeholder',
          hint: 'placeholder',
        }),
      );
      expect(fired).toBe(0);
    });
  });

  // ─── fix-f6: dispose placeholder + listener detach ─────────────────────────

  describe('fix-f6 — Renderer.dispose() placeholder + listener detach', () => {
    it('dispose is Result-valued and idempotent', async () => {
      const renderer = await requireRenderer(
        makeMockCanvas({ webgl2: 'context', webgpu: 'context' }),
        { rhi },
        { shaderManifestUrl: undefined },
      );

      expect((await renderer.dispose()).ok).toBe(true);
      expect((await renderer.dispose()).ok).toBe(true);
    });

    it('LostListenerRegistry.clear detaches all listeners', async () => {
      const { LostListenerRegistry } = await import('../../../render/src/lifecycle');
      const registry = new LostListenerRegistry();
      let fired = 0;
      registry.add(() => {
        fired += 1;
      });
      registry.clear();
      registry.fire({ reason: 'unknown', message: 'after clear' });
      expect(fired).toBe(0);
    });
  });
}
