// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { rhi } from '@forgeax/engine-rhi-null';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer as createRuntimeRenderer } from '../createRenderer';
import { EngineEnvironmentError } from '../errors/environment';
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
