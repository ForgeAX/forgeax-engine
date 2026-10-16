// @ts-nocheck — merged file: vi.fn mock objects do not fully satisfy RhiWgpuInstanceLike interface; tests pass at runtime
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/rhi-wgpu/src/__tests__/acquireCanvasContext.test.ts
//   - packages/rhi-wgpu/src/__tests__/requestAdapter.test.ts
//   - packages/rhi-wgpu/src/__tests__/rhi-caps-probe.test.ts
//   - packages/rhi-wgpu/src/__tests__/wasm-loader.test.ts
//   - packages/rhi-wgpu/src/__tests__/webgl-fallback.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Rhi-wgpu tests share vi.mock('@forgeax/engine-wgpu-wasm') patterns.
// Unified mock provides all needed members. Per-block beforeEach/afterEach
// use restoreMocks() (mockClear) to prevent cross-block call-count leakage.

import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { makeCanvasContext } from '../adapter';
import { makeRhiCommandEncoder } from '../command-encoder';
import { disposeDevice, makeRhiDevice, type RawDeviceLike } from '../device';
import { __resetForTests, ensureRhiWgpuReady, getRhiWgpuModule } from '../internal/wasm-loader';
import { makeRhiRenderPassEncoder } from '../render-pass-encoder';

// ── unified mock for @forgeax/engine-wgpu-wasm ──
const fakeWasmAdapter = {
  requestDevice: vi.fn(async () => ({
    createBuffer: () => ({}),
    registerLostCallback: () => {},
  })),
};

const fakeWasmSurface = {
  configure: vi.fn((_desc: Record<string, unknown>) => {}),
  free: vi.fn(() => {}),
  getCurrentTexture: vi.fn(() => ({ __brand: 'Texture' })),
};

const fakeWasmInstance: {
  requestAdapter: ReturnType<typeof vi.fn>;
  requestAdapterWithCanvas: ReturnType<typeof vi.fn>;
  createSurface: ReturnType<typeof vi.fn>;
} = {
  requestAdapter: vi.fn(async () => fakeWasmAdapter as unknown),
  requestAdapterWithCanvas: vi.fn(async () => fakeWasmAdapter as unknown),
  createSurface: vi.fn(() => fakeWasmSurface),
};

const fakeWasmNamespace = {
  RhiWgpuInstance: {
    create: vi.fn(async () => fakeWasmInstance),
  },
};

vi.mock('@forgeax/engine-wgpu-wasm', () => ({
  ensureReady: vi.fn(async () => fakeWasmNamespace),
}));

// mockClear all shared stubs so call counts don't leak between blocks.
function restoreMocks(): void {
  fakeWasmInstance.requestAdapter.mockClear();
  fakeWasmInstance.requestAdapterWithCanvas.mockClear();
  fakeWasmInstance.createSurface.mockClear();
  fakeWasmNamespace.RhiWgpuInstance.create.mockClear();
  fakeWasmSurface.configure.mockClear();
  fakeWasmSurface.free.mockClear();
  fakeWasmSurface.getCurrentTexture.mockClear();
  fakeWasmAdapter.requestDevice.mockClear();
}

describe('backend device retirement', () => {
  it('frees an acquired wasm device exactly once', () => {
    const free = vi.fn();
    const raw = {
      features: new Set<string>(),
      limits: { maxStorageTexturesPerShaderStage: 4, maxColorAttachments: 8 },
      queue: {},
      createTexture: () => ({ destroy: vi.fn() }),
      free,
    } as unknown as RawDeviceLike;
    const { device } = makeRhiDevice(raw);

    disposeDevice(device);
    disposeDevice(device);

    expect(free).toHaveBeenCalledTimes(1);
  });
});

describe('command encoder finish', () => {
  it('a second finish() returns command-encoder-finished and never reaches the wasm handle', () => {
    const finish = vi.fn(() => ({}));
    const encoder = makeRhiCommandEncoder({ finish });
    expect(encoder.finish().ok).toBe(true);
    const second = encoder.finish();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('command-encoder-finished');
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

describe('canonical WASM surface lifetime', () => {
  it('projects configuration and releases/recreates the actual native surface', async () => {
    removeNavigatorGpu();
    const events: string[] = [];
    const surfaces: object[] = [];
    const instance = {
      createSurface() {
        const raw = {
          configure: vi.fn(() => events.push('configure')),
          getCurrentTexture: () => ({
            getTexture: () => ({}),
            present: () => events.push('present'),
          }),
          free: vi.fn(() => events.push('free')),
        };
        surfaces.push(raw);
        return raw;
      },
    };
    const { acquireCanvasContext } = await import('../index');
    const context = acquireCanvasContext(instance, { width: 4, height: 4 }).unwrap();
    expect(context.getConfiguration()).toBeUndefined();
    const device = { _internal_raw: {} };
    const config = { device, format: 'rgba8unorm', usage: 0x10, viewFormats: [] };
    context.configure(config).unwrap();
    expect(context.getConfiguration()?.device).toBe(device);
    config.viewFormats.push('rgba8unorm-srgb');
    expect(context.getConfiguration()?.viewFormats).toEqual([]);
    const reported = context.getConfiguration();
    if (!reported?.viewFormats) throw new Error('Expected the accepted view formats');
    (reported.viewFormats as GPUTextureFormat[]).push('rgba8unorm-srgb');
    expect(context.getConfiguration()?.viewFormats).toEqual([]);
    context.getCurrentTexture().unwrap();
    context.unconfigure();
    context.unconfigure();
    await Promise.resolve();
    expect(events).toEqual(['configure', 'present', 'free']);
    expect(context.getConfiguration()).toBeUndefined();
    expect(context.getCurrentTexture().ok).toBe(false);
    context.configure(config).unwrap();
    expect(surfaces).toHaveLength(2);
    context.unconfigure();
    expect(events).toEqual(['configure', 'present', 'free', 'configure', 'free']);
  });

  it('never publishes a configuration rejected by the raw owner', () => {
    const raw = {
      configure: vi.fn(() => {
        throw new Error('invalid native configuration');
      }),
      unconfigure: vi.fn(),
      getCurrentTexture: vi.fn(),
    };
    const context = makeCanvasContext(raw);
    expect(context.configure({ device: {}, format: 'rgba8unorm', usage: 0x10 }).ok).toBe(false);
    expect(context.getConfiguration()).toBeUndefined();
  });
});

describe('WebGL2 wasm surface configuration', () => {
  it('retires an acquired image once before following a changed canvas extent', async () => {
    const events: string[] = [];
    const canvas = { width: 844, height: 390 };
    const raw = {
      configure: vi.fn(({ width, height }) => events.push(`configure:${width}x${height}`)),
      unconfigure: vi.fn(),
      getCurrentTexture: vi.fn(() => ({
        getTexture: () => ({ width: canvas.width, height: canvas.height }),
        present: () => events.push('present'),
      })),
    };
    const context = makeCanvasContext(raw, canvas);
    const configuration = { device: {}, format: 'rgba8unorm', usage: 0x10 };
    context.configure(configuration).unwrap();
    const landscape = context.getCurrentTexture().unwrap();
    canvas.width = 390;
    canvas.height = 844;
    const portrait = context.getCurrentTexture().unwrap();
    expect(portrait).not.toBe(landscape);
    expect([landscape.width, landscape.height]).toEqual([844, 390]);
    expect([portrait.width, portrait.height]).toEqual([390, 844]);
    expect(context.getCurrentTexture().unwrap()).toBe(portrait);
    expect(events).toEqual(['configure:844x390', 'present', 'configure:390x844']);
    expect(context.getConfiguration()).toEqual(configuration);
    await Promise.resolve();
    expect(events).toEqual(['configure:844x390', 'present', 'configure:390x844', 'present']);
    context.unconfigure();
  });

  it('returns a failed resize without acquiring from the rejected surface', () => {
    const canvas = { width: 844, height: 390 };
    const raw = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getCurrentTexture: vi.fn(),
    };
    const context = makeCanvasContext(raw, canvas);
    context.configure({ device: {}, format: 'rgba8unorm', usage: 0x10 }).unwrap();
    raw.configure.mockImplementationOnce(() => {
      throw new Error('resize rejected');
    });
    canvas.width = 390;
    canvas.height = 844;
    const result = context.getCurrentTexture();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('webgpu-runtime-error');
      expect(result.error.hint).toContain('resize rejected');
    }
    expect(context.getConfiguration()).toBeUndefined();
    expect(raw.getCurrentTexture).not.toHaveBeenCalled();
    expect(raw.unconfigure).toHaveBeenCalledOnce();
  });

  it('reports the accepted configuration when the wasm surface has no getter', () => {
    const raw = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getCurrentTexture: vi.fn(),
    };
    const context = makeCanvasContext(raw as never);
    expect(context.getConfiguration()).toBeUndefined();
    const configuration = {
      device: {} as never,
      format: 'bgra8unorm' as const,
      usage: 16,
      colorSpace: 'display-p3' as const,
    };
    expect(context.configure(configuration).ok).toBe(true);
    expect(context.getConfiguration()).toEqual({
      device: configuration.device,
      format: configuration.format,
      usage: configuration.usage,
    });
    context.unconfigure();
    expect(context.getConfiguration()).toBeUndefined();
  });

  it('reads accepted raw configuration without replacing an absent result with its request', () => {
    let accepted: GPUCanvasConfiguration | null = null;
    const raw = {
      configure: vi.fn((configuration: GPUCanvasConfiguration) => {
        accepted = {
          ...configuration,
          format: 'rgba8unorm',
          usage: 16,
          colorSpace: 'display-p3',
          toneMapping: { mode: 'extended' },
          viewFormats: ['rgba8unorm-srgb'],
        };
      }),
      unconfigure: vi.fn(() => {
        accepted = null;
      }),
      getConfiguration: vi.fn(() => accepted),
      getCurrentTexture: vi.fn(),
    };
    const context = makeCanvasContext(raw);
    const device = {} as never;
    context.configure({ device, format: 'bgra8unorm', usage: 17 }).unwrap();
    expect(context.getConfiguration()).toEqual({
      device,
      format: 'rgba8unorm',
      usage: 16,
      viewFormats: ['rgba8unorm-srgb'],
    });
    const reported = context.getConfiguration();
    if (!reported?.viewFormats) throw new Error('Expected the accepted view formats');
    (reported.viewFormats as GPUTextureFormat[]).push('bgra8unorm-srgb');
    expect(context.getConfiguration()?.viewFormats).toEqual(['rgba8unorm-srgb']);
    accepted = null;
    expect(context.getConfiguration()).toBeUndefined();
    context.unconfigure();
  });
});

describe('compute-pass forwarding', () => {
  it('raises a structured capability refusal when the raw encoder has no compute pass', () => {
    const encoder = makeRhiCommandEncoder({});

    expect(() => encoder.beginComputePass()).toThrowError(
      expect.objectContaining({
        code: 'feature-not-enabled',
        expected: expect.stringContaining('feature compute'),
        hint: expect.stringContaining('caps.compute'),
      }),
    );
  });

  it('forwards pipeline, bindings, direct and indirect dispatch into the wasm handle', () => {
    const rawPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      dispatchWorkgroupsIndirect: vi.fn(),
      end: vi.fn(),
    };
    const beginComputePass = vi.fn(() => rawPass);
    const encoder = makeRhiCommandEncoder({ beginComputePass });
    const querySet = {};
    const pass = encoder.beginComputePass({
      label: 'compute',
      timestampWrites: {
        querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    const pipeline = {};
    const bindings = {};
    const indirect = {};

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings, [16]);
    pass.dispatchWorkgroups(2, 3, 4);
    pass.dispatchWorkgroupsIndirect(indirect, 8);
    pass.end();

    expect(beginComputePass).toHaveBeenCalledWith({
      label: 'compute',
      timestampWrites: {
        querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    expect(rawPass.setPipeline).toHaveBeenCalledWith(pipeline);
    expect(rawPass.setBindGroup).toHaveBeenCalledWith(0, bindings, [16]);
    expect(rawPass.dispatchWorkgroups).toHaveBeenCalledWith(2, 3, 4);
    expect(rawPass.dispatchWorkgroupsIndirect).toHaveBeenCalledWith(indirect, 8n);
    expect(rawPass.end).toHaveBeenCalledOnce();
  });

  it('encodes and immediately ends one raw empty compute pass with owning receivers', () => {
    let beginReceiver: unknown;
    let endReceiver: unknown;
    const descriptor = { timestampWrites: { querySet: {}, beginningOfPassWriteIndex: 0 } };
    const rawPass = {
      end(this: unknown) {
        endReceiver = this;
      },
    };
    const rawEncoder = {
      beginComputePass(this: unknown, received: unknown) {
        beginReceiver = this;
        expect(received).toBe(descriptor);
        return rawPass;
      },
    };

    makeRhiCommandEncoder(rawEncoder).encodeEmptyComputePass(descriptor);

    expect(beginReceiver).toBe(rawEncoder);
    expect(endReceiver).toBe(rawPass);
  });
});

describe('surface presentation proof', () => {
  it('keeps acquire and present separate from pixel readback evidence', () => {
    const rawContext = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(() => null),
      getCurrentTexture: vi.fn(),
      probeSurfacePresentation: vi.fn(() => ({
        descriptor: true,
        acquisition: true,
        validation: true,
      })),
    };
    const context = makeCanvasContext(rawContext);
    const result = context.configure({
      device: {} as never,
      format: 'rgba8unorm',
      usage: 0x10,
    });

    expect(result.ok).toBe(true);
    expect(rawContext.probeSurfacePresentation).toHaveBeenCalledOnce();
    expect(context.presentationProof).toEqual({
      descriptor: true,
      acquisition: true,
      validation: true,
    });
  });

  it('turns a fallible raw probe into a structured configure failure', () => {
    const rawContext = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(() => null),
      getCurrentTexture: vi.fn(),
      probeSurfacePresentation: vi.fn(() => {
        throw new Error('surface acquire failed');
      }),
    };
    const context = makeCanvasContext(rawContext);
    const result = context.configure({
      device: {} as never,
      format: 'rgba8unorm',
      usage: 0x10,
    });

    expect(result.ok).toBe(false);
    expect(rawContext.getCurrentTexture).not.toHaveBeenCalled();
  });

  it('retains one acquired texture across scene and UI reads until presentation', async () => {
    const surfaces: { getTexture: () => object; present: ReturnType<typeof vi.fn> }[] = [];
    const rawContext = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(() => null),
      getCurrentTexture: vi.fn(() => {
        const texture = {};
        const surface = { getTexture: () => texture, present: vi.fn() };
        surfaces.push(surface);
        return surface;
      }),
    };
    const context = makeCanvasContext(rawContext);
    const scene = context.getCurrentTexture().unwrap();
    const ui = context.getCurrentTexture().unwrap();
    expect(ui).toBe(scene);
    expect(rawContext.getCurrentTexture).toHaveBeenCalledTimes(1);
    expect(surfaces[0]?.present).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(surfaces[0]?.present).toHaveBeenCalledTimes(1);
    const next = context.getCurrentTexture().unwrap();
    expect(next).not.toBe(scene);
    context.unconfigure();
    expect(surfaces[1]?.present).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(surfaces[1]?.present).toHaveBeenCalledTimes(1);
  });

  it('preserves an asynchronous surface-present cause for the next RHI boundary', async () => {
    const rawSurfaceTexture = {
      getTexture: vi.fn(() => ({ __brand: 'Texture' })),
      present: vi.fn(() => {
        throw new Error('device-operation-failed: surface image was not accepted');
      }),
    };
    const rawContext = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(() => null),
      getCurrentTexture: vi.fn(() => rawSurfaceTexture),
    };
    const context = makeCanvasContext(rawContext);

    const first = context.getCurrentTexture();
    expect(first.ok).toBe(true);
    await Promise.resolve();

    const second = context.getCurrentTexture();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('webgpu-runtime-error');
      expect(second.error.hint).toContain('device-operation-failed');
    }
  });

  it('always unconfigures the raw surface after a failed pending present', async () => {
    const rawContext = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(() => null),
      getCurrentTexture: vi.fn(() => ({
        getTexture: vi.fn(() => ({ __brand: 'Texture' })),
        present: vi.fn(() => {
          throw new Error('surface-present-failed');
        }),
      })),
    };
    const context = makeCanvasContext(rawContext);

    expect(context.getCurrentTexture().ok).toBe(true);
    await Promise.resolve();
    context.unconfigure();

    expect(rawContext.unconfigure).toHaveBeenCalledOnce();
  });
});

describe('render-pass dynamic-offset forwarding', () => {
  it('preserves Uint32Array start and length in the five-argument overload', () => {
    const rawPass = { setBindGroup: vi.fn() };
    const pass = makeRhiRenderPassEncoder(rawPass);
    const offsets = new Uint32Array([256, 512]);
    const bindings = {};

    pass.setBindGroup(1, bindings, offsets, 1, 1);

    expect(rawPass.setBindGroup).toHaveBeenCalledWith(1, bindings, offsets, 1, 1);
  });
});

function removeNavigatorGpu(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    writable: true,
    configurable: true,
  });
}

function setNavigatorGpu(gpu: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: gpu === undefined ? {} : { gpu },
    writable: true,
    configurable: true,
  });
}

{
  // ─── from acquireCanvasContext.test.ts ───

  describe('acquireCanvasContext.test.ts', () => {
    describe('acquireCanvasContext(instance, canvas) wasm surface path', () => {
      beforeEach(() => {
        restoreMocks();
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      test('instance.createSurface succeeds => returns ok(RhiCanvasContext)', async () => {
        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(fakeWasmInstance, mockCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.configure).toBeTypeOf('function');
          expect(result.value.unconfigure).toBeTypeOf('function');
          expect(result.value.getConfiguration).toBeTypeOf('function');
          expect(result.value.getCurrentTexture).toBeTypeOf('function');
        }
        expect(fakeWasmInstance.createSurface).toHaveBeenCalledWith(mockCanvas);
      });

      test('instance missing createSurface => returns err rhi-not-available', async () => {
        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;

        const badInstance = { createSurface: undefined } as unknown as {
          createSurface(canvas: HTMLCanvasElement | OffscreenCanvas): unknown;
        };
        const result = acquireCanvasContext(badInstance, mockCanvas);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('rhi-not-available');
          expect(result.error.hint).toContain('requestAdapter');
        }
      });

      test('instance.createSurface throws => returns err rhi-not-available', async () => {
        const throwingInstance = {
          createSurface: vi.fn(() => {
            throw new Error('mock: surface creation failed');
          }),
        };

        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(throwingInstance, mockCanvas);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('rhi-not-available');
          expect(result.error.hint).toContain('mock');
        }
      });

      test('returned RhiCanvasContext.configure delegates to wasm surface', async () => {
        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(fakeWasmInstance, mockCanvas);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('acquireCanvasContext should succeed');

        const ctx = result.value;
        const cfgResult = ctx.configure({
          device: {} as never,
          format: 'bgra8unorm',
          usage: 0x10,
        });
        expect(cfgResult.ok).toBe(true);

        const textureResult = ctx.getCurrentTexture();
        expect(textureResult.ok).toBe(true);
        if (textureResult.ok) {
          const texture = textureResult.value as unknown as Record<string, unknown>;
          expect(texture.width).toBe(800);
          expect(texture.height).toBe(600);
          expect(texture.format).toBe('bgra8unorm');
          expect(texture.usage).toBe(0x10);
        }
      });

      test('returned RhiCanvasContext.unconfigure presents the pending surface texture first', async () => {
        const present = vi.fn();
        (fakeWasmSurface.getCurrentTexture as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          getTexture: () => ({}),
          present,
        });

        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(fakeWasmInstance, mockCanvas);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('acquireCanvasContext should succeed');

        const ctx = result.value;
        expect(ctx.getCurrentTexture().ok).toBe(true);
        ctx.unconfigure();
        ctx.unconfigure();

        expect(present).toHaveBeenCalledOnce();
        expect(fakeWasmSurface.free).toHaveBeenCalledOnce();
      });

      test('presents the acquired wasm surface texture after the submit call stack', async () => {
        const callbacks: VoidFunction[] = [];
        vi.stubGlobal('queueMicrotask', (callback: VoidFunction) => {
          callbacks.push(callback);
        });
        const present = vi.fn();
        (fakeWasmSurface.getCurrentTexture as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          getTexture: () => ({}),
          present,
        });

        const { acquireCanvasContext } = await import('../index');
        const result = acquireCanvasContext(fakeWasmInstance, {
          width: 800,
          height: 600,
        } as unknown as HTMLCanvasElement);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('acquireCanvasContext should succeed');

        expect(result.value.getCurrentTexture().ok).toBe(true);
        expect(present).not.toHaveBeenCalled();
        expect(callbacks).toHaveLength(1);
        callbacks[0]?.();
        callbacks[0]?.();

        expect(present).toHaveBeenCalledOnce();
      });

      test('returned RhiCanvasContext.getConfiguration reflects accepted configuration', async () => {
        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(fakeWasmInstance, mockCanvas);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('acquireCanvasContext should succeed');

        const device = {};
        result.value.configure({ device, format: 'bgra8unorm', usage: 0x10 }).unwrap();
        const cfg = result.value.getConfiguration();
        expect(cfg).toBeDefined();
        if (cfg) {
          expect(cfg.format).toBe('bgra8unorm');
          expect(cfg.device).toBe(device);
        }
      });
    });
  });
}

{
  // ─── from requestAdapter.test.ts ───

  describe('requestAdapter.test.ts', () => {
    describe('requestAdapter wasm fallback', () => {
      beforeEach(() => {
        __resetForTests();
        restoreMocks();
      });

      afterEach(() => {
        __resetForTests();
        restoreMocks();
        Object.defineProperty(globalThis, 'navigator', {
          value: {},
          writable: true,
          configurable: true,
        });
      });

      test('AC-01: navigator.gpu undefined => wasm fallback returns ok(RhiAdapter)', async () => {
        removeNavigatorGpu();

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.features).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapter).toHaveBeenCalled();
      });

      test('AC-02: rhi-wgpu always uses wasm path, never touches navigator.gpu (bug-20260610)', async () => {
        // bug-20260610: rhi-webgpu owns navigator.gpu; rhi-wgpu is the wasm GL
        // fallback by definition. The legacy fast path was removed because:
        //   (1) re-doing what rhi-webgpu already did wastes a request
        //   (2) on Edge with WebGPU disabled, navigator.gpu falsely advertises
        //       support and re-poisons the fallback chain
        // So even when navigator.gpu is present and returns a valid adapter,
        // rhi-wgpu skips it and goes straight to wasm.
        const fakeGpu = {
          requestAdapter: vi.fn(async () => null),
        };
        setNavigatorGpu(fakeGpu);

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        // Critical contract: rhi-wgpu does NOT touch navigator.gpu.
        expect(fakeGpu.requestAdapter).not.toHaveBeenCalled();
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
      });

      test('AC-03: navigator.gpu valid adapter present is also ignored (bug-20260610)', async () => {
        // Companion to AC-02 — covers the previously-fast-path scenario.
        // Pre-bug-20260610 contract said rhi-wgpu would skip wasm here. Post-fix
        // it ALWAYS goes wasm; rhi-webgpu is the only consumer of navigator.gpu.
        const fakeNativeAdapter = {
          features: new Set(['texture-compression-bc']),
          limits: { maxBindGroups: 4 },
          requestDevice: vi.fn(async () => ({
            createBuffer: () => ({}),
            registerLostCallback: () => {},
          })),
        };
        const fakeGpu = {
          requestAdapter: vi.fn(async () => fakeNativeAdapter),
        };
        setNavigatorGpu(fakeGpu);

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        // navigator.gpu is untouched even when it would return a valid adapter.
        expect(fakeGpu.requestAdapter).not.toHaveBeenCalled();
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
      });

      test('AC-06: wasm requestAdapter returns null => structured error with wasm exhaustion hint', async () => {
        removeNavigatorGpu();
        fakeWasmInstance.requestAdapter.mockResolvedValueOnce(null as unknown);

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('adapter-unavailable');
          expect(result.error.hint).toContain('wgpu-wasm');
        }
      });

      test('w21: compatibleSurface passed => calls requestAdapterWithCanvas on wasm instance', async () => {
        removeNavigatorGpu();

        const fakeCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const mockRequestAdapterWithCanvas = vi.fn(async () => fakeWasmAdapter as unknown);
        fakeWasmInstance.requestAdapterWithCanvas = mockRequestAdapterWithCanvas;

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter(undefined, fakeCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(mockRequestAdapterWithCanvas).toHaveBeenCalledWith(fakeCanvas);
        expect(fakeWasmInstance.requestAdapter).not.toHaveBeenCalled();
      });

      test('w21: compatibleSurface not passed => calls plain requestAdapter on wasm instance', async () => {
        removeNavigatorGpu();

        const mockRequestAdapterWithCanvas = vi.fn(async () => fakeWasmAdapter as unknown);
        fakeWasmInstance.requestAdapterWithCanvas = mockRequestAdapterWithCanvas;

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
        }
        expect(fakeWasmInstance.requestAdapter).toHaveBeenCalled();
        expect(mockRequestAdapterWithCanvas).not.toHaveBeenCalled();
      });

      test('Edge: ensureReady() not called => structured error with hint', async () => {
        removeNavigatorGpu();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('rhi-not-available');
          expect(result.error.hint).toContain('ensureReady');
        }
      });

      test('M2 w10 — caps.backendKind is non-undefined and value in valid set', async () => {
        const { makeRhiDevice: makeRd } = await import('../device');
        const raw = {
          features: new Set<string>(),
          limits: {},
          queue: {},
        };
        const { device } = makeRd(raw);
        expect(device.caps.backendKind).toBeDefined();
        expect(device.caps.backendKind).toBe('wgpu-webgl2');
      });
    });
  });
}

{
  // ─── from rhi-caps-probe.test.ts ───

  function capsMakeNoop(_desc?: unknown): unknown {
    return {};
  }

  function mockRawDevice(overrides?: {
    features?: readonly string[];
    createTexture?: (desc: unknown) => unknown;
    createTextureView?: (texture: unknown, desc: unknown) => unknown;
    createBindGroupLayout?: (desc: unknown) => unknown;
  }): RawDeviceLike {
    const featuresSet = new Set<string>(overrides?.features ?? []);
    const base = {
      features: featuresSet,
      limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
      createTexture: (overrides?.createTexture ?? capsMakeNoop) as (desc: unknown) => unknown,
      createTextureView: overrides?.createTextureView as
        | ((texture: unknown, desc: unknown) => unknown)
        | undefined,
      createSampler: capsMakeNoop,
      createBindGroupLayout: (overrides?.createBindGroupLayout ?? capsMakeNoop) as (
        desc: unknown,
      ) => unknown,
      createBindGroup: capsMakeNoop,
      createPipelineLayout: capsMakeNoop,
      createRenderPipeline: capsMakeNoop,
      createComputePipeline: capsMakeNoop,
      createShaderModule: capsMakeNoop,
      queue: {
        submit() {},
        writeBuffer() {},
        writeTexture() {},
        copyExternalImageToTexture() {},
        onSubmittedWorkDone: async () => undefined,
      },
    };
    return base as unknown as RawDeviceLike;
  }

  describe('rhi-caps-probe.test.ts', () => {
    describe('M1 caps probe — HDR renderable + float32 filterable (rhi-wgpu)', () => {
      it('AC-01: caps.rgba16floatRenderable is true when probe succeeds', () => {
        const r = makeRhiDevice(mockRawDevice());
        expect(typeof r.device.caps.rgba16floatRenderable).toBe('boolean');
        expect(r.device.caps.rgba16floatRenderable).toBe(true);
      });

      it('passes the wasm Extent3d object to the rgba16float capability probe', () => {
        let descriptor: Record<string, unknown> | undefined;
        const r = makeRhiDevice(
          mockRawDevice({
            createTexture: (value) => {
              descriptor = value as Record<string, unknown>;
              return { destroy: () => {} };
            },
          }),
        );

        expect(r.device.caps.rgba16floatRenderable).toBe(true);
        expect(descriptor).toMatchObject({
          label: 'forgeax-caps-probe-rgba16float-renderable',
          format: 'rgba16float',
          usage: 16,
          size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        });
        expect(Array.isArray((descriptor as { size?: unknown }).size)).toBe(false);
      });

      it('AC-01 (m1-1-b): caps.rg11b10ufloatRenderable is true when feature present and probe succeeds', () => {
        const r = makeRhiDevice(mockRawDevice({ features: ['rg11b10ufloat-renderable'] }));
        expect(typeof r.device.caps.rg11b10ufloatRenderable).toBe('boolean');
        expect(r.device.caps.rg11b10ufloatRenderable).toBe(true);
      });

      it('AC-01 (m1-1-b): caps.float32Filterable is true when feature present and probe succeeds', () => {
        const r = makeRhiDevice(mockRawDevice({ features: ['float32-filterable'] }));
        expect(typeof r.device.caps.float32Filterable).toBe('boolean');
        expect(r.device.caps.float32Filterable).toBe(true);
      });

      it('compute is an explicit WebGL2 capability refusal', () => {
        const createComputePipeline = vi.fn(() => ({}));
        const raw = mockRawDevice();
        raw.createComputePipeline = createComputePipeline;
        const r = makeRhiDevice(raw);

        expect(r.device.caps.compute).toBe(false);
        const result = r.device.createComputePipeline({
          label: 'webgl2-compute-must-refuse',
          layout: 'auto',
          compute: { module: {} as never, entryPoint: 'main' },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('feature-not-enabled');
          expect(result.error.expected).toBe(
            'feature compute to be enabled on the active wgpu backend',
          );
          expect(result.error.hint).toContain('check engine.rhi.caps.compute');
        }
        expect(createComputePipeline).not.toHaveBeenCalled();
      });

      it('does not advertise indirect draws on the WebGL2 backend', () => {
        const r = makeRhiDevice(mockRawDevice({ features: ['indirect-first-instance'] }));

        expect(r.device.caps.indirectDrawing).toBe(false);
        expect(r.device.caps.firstInstanceIndirect).toBe(false);
      });

      it('timestamp QuerySet creation is an explicit WebGL2 capability refusal', () => {
        const createQuerySet = vi.fn(() => ({ type: 'timestamp', count: 2 }));
        const raw = mockRawDevice() as RawDeviceLike;
        raw.createQuerySet = createQuerySet;
        const r = makeRhiDevice(raw);

        expect(r.device.caps.timestampQuery).toBe(false);
        const result = r.device.createQuerySet({ type: 'timestamp', count: 2 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('feature-not-enabled');
          expect(result.error.expected).toBe(
            'caps.timestampQuery === true (timestamp-query feature)',
          );
          expect(result.error.hint).toContain('device.caps.timestampQuery');
        }
        expect(createQuerySet).not.toHaveBeenCalled();
      });

      it('classifies a wgpu-wasm descriptor parse error as descriptor-invalid', () => {
        const raw = mockRawDevice({
          createTexture: () => {
            throw new Error(
              '[wgpu-wasm] failed to parse texture descriptor: invalid view dimension',
            );
          },
        });
        const r = makeRhiDevice(raw);

        const result = r.device.createTexture({
          size: [4, 4, 2],
          format: 'rgba8unorm',
          usage: 0x04,
          dimension: '2d',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('rhi-descriptor-invalid');
          expect(result.error.hint).toContain('wgpu-wasm descriptor parse error');
        }
      });

      it('classifies a string-valued wgpu-wasm parse refusal as descriptor-invalid', () => {
        const raw = mockRawDevice({
          createTexture: () => {
            throw '[wgpu-wasm] failed to parse texture descriptor: invalid enum';
          },
        });
        const r = makeRhiDevice(raw);

        const result = r.device.createTexture({
          size: [4, 4, 2],
          format: 'rgba8unorm',
          usage: 0x04,
          dimension: '2d',
        });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('rhi-descriptor-invalid');
      });

      it('classifies texture-view parse errors from the device entry point as descriptor-invalid', () => {
        const raw = mockRawDevice({
          createTextureView: () => {
            throw '[wgpu-wasm] failed to parse textureView descriptor.aspect: invalid enum';
          },
        });
        const r = makeRhiDevice(raw);
        const result = r.device.createTextureView({} as never, { aspect: 'bad' });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('rhi-descriptor-invalid');
      });

      it('classifies texture-view parse errors from the texture entry point as descriptor-invalid', () => {
        const raw = mockRawDevice();
        const r = makeRhiDevice(raw);
        const result = r.device.createTextureView(
          {
            createView: () => {
              throw new Error(
                '[wgpu-wasm] failed to parse textureView descriptor.dimension: invalid enum',
              );
            },
          } as never,
          { dimension: 'bad' },
        );

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('rhi-descriptor-invalid');
      });

      it('m1-1-b: caps.rg11b10ufloatRenderable is false when feature absent (no createTexture call)', () => {
        let createTextureCalls = 0;
        const raw = mockRawDevice({
          features: [],
          createTexture: (_desc) => {
            createTextureCalls += 1;
            return { destroy: () => {} };
          },
        });
        const r = makeRhiDevice(raw);

        expect(r.device.caps.rg11b10ufloatRenderable).toBe(false);
        expect(createTextureCalls).toBe(1);
      });

      it('m1-1-b: caps.float32Filterable is false when feature absent (no createBindGroupLayout call)', () => {
        let bglCalls = 0;
        const raw = mockRawDevice({
          features: [],
          createBindGroupLayout: () => {
            bglCalls += 1;
            return {};
          },
        });
        const r = makeRhiDevice(raw);

        expect(r.device.caps.float32Filterable).toBe(false);
        expect(bglCalls).toBe(0);
      });

      it('AC-02: rgba16float false when createTexture throws (D-2.1 try/catch)', () => {
        const raw = mockRawDevice({
          createTexture: () => {
            throw new Error('mock: probe createTexture throw');
          },
        });
        const r = makeRhiDevice(raw);
        expect(r.device.caps.rgba16floatRenderable).toBe(false);
      });

      it('D-2.1: rgba16float texture destroy called on probe success path', () => {
        const destroyLog: string[] = [];
        const raw = mockRawDevice({
          createTexture: (desc) => {
            const fmt = (desc as { format: string }).format;
            return {
              destroy: () => {
                destroyLog.push(fmt);
              },
            };
          },
        });

        const r = makeRhiDevice(raw);
        expect(r.device.caps.rgba16floatRenderable).toBe(true);
        expect(destroyLog).toEqual(['rgba16float']);
      });

      it('D-2.1: caps probes use wasm extent objects and destroy probe textures', () => {
        const descriptors: unknown[] = [];
        const destroyLog: string[] = [];
        const raw = mockRawDevice({
          features: ['rg11b10ufloat-renderable'],
          createTexture: (desc) => {
            descriptors.push(desc);
            const format = (desc as { format: string }).format;
            return { destroy: () => destroyLog.push(format) };
          },
        });

        const r = makeRhiDevice(raw);

        expect(r.device.caps.rgba16floatRenderable).toBe(true);
        expect(r.device.caps.rg11b10ufloatRenderable).toBe(true);
        expect(descriptors).toHaveLength(2);
        for (const descriptor of descriptors) {
          expect(descriptor).toEqual(
            expect.objectContaining({
              size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            }),
          );
        }
        expect(destroyLog).toEqual(['rgba16float', 'rg11b10ufloat']);
      });

      it('D-2.2: createTexture projects public descriptors into strict wasm shape', () => {
        const descriptors: Record<string, unknown>[] = [];
        const raw = mockRawDevice({
          createTexture: (desc) => {
            const projected = desc as Record<string, unknown>;
            if (Array.isArray(projected.size)) throw new Error('wasm extent must be an object');
            if (Object.values(projected).some((value) => value === undefined)) {
              throw new Error('wasm descriptor must omit undefined fields');
            }
            descriptors.push(projected);
            return { destroy() {} };
          },
        });
        const r = makeRhiDevice(raw);
        descriptors.length = 0;

        const viewFormats = ['rgba16float'] as const;
        const result = r.device.createTexture({
          size: [8, 4],
          format: 'rgba8unorm',
          usage: 0x10,
          label: undefined,
          mipLevelCount: undefined,
          sampleCount: undefined,
          dimension: undefined,
          viewFormats,
          textureBindingViewDimension: undefined,
        });

        expect(result.ok).toBe(true);
        expect(descriptors).toHaveLength(1);
        expect(descriptors[0]).toEqual({
          size: { width: 8, height: 4, depthOrArrayLayers: 1 },
          format: 'rgba8unorm',
          usage: 0x10,
          viewFormats: ['rgba16float'],
        });
        expect(descriptors[0]?.viewFormats).not.toBe(viewFormats);

        const scalar = r.device.createTexture({
          size: 3 as never,
          format: 'rgba8unorm',
          usage: 0x10,
        });
        const object = r.device.createTexture({
          size: { width: 6, height: 5, depthOrArrayLayers: 2 },
          format: 'rgba8unorm',
          usage: 0x10,
        });
        expect(scalar.ok).toBe(true);
        expect(object.ok).toBe(true);
        expect(descriptors[1]?.size).toEqual({ width: 3, height: 1, depthOrArrayLayers: 1 });
        expect(descriptors[2]?.size).toEqual({ width: 6, height: 5, depthOrArrayLayers: 2 });
      });

      it('D-2.1: missing createTexture method maps rgba16floatRenderable to false', () => {
        const base = mockRawDevice();
        const { createTexture: _, ...rest } = base as unknown as Record<string, unknown>;
        const raw: RawDeviceLike = rest as unknown as RawDeviceLike;
        const r = makeRhiDevice(raw);
        expect(r.device.caps.rgba16floatRenderable).toBe(false);
        expect(r.device.caps.rg11b10ufloatRenderable).toBe(false);
        expect(r.device.caps.float32Filterable).toBe(false);
      });
    });
  });
}

{
  // ─── from wasm-loader.test.ts ───

  interface FakeModule {
    readonly id: string;
    readonly spike_create_instance: () => unknown;
  }

  describe('wasm-loader.test.ts', () => {
    afterEach(() => {
      __resetForTests();
    });

    describe('wasm-loader.ensureRhiWgpuReady', () => {
      test('(a) first call resolves with the module returned by init', async () => {
        const fakeModule: FakeModule = {
          id: 'fake-module',
          spike_create_instance: () => 'ok',
        };
        const initFn = vi.fn(async () => fakeModule);
        const out = await ensureRhiWgpuReady({ initFn });
        expect(initFn).toHaveBeenCalledTimes(1);
        expect(out).toBe(fakeModule);
      });

      test('(b) memoisation — second call reuses the cached Promise (no re-init)', async () => {
        const fakeModule: FakeModule = {
          id: 'fake-module-memo',
          spike_create_instance: () => 'ok',
        };
        const initFn = vi.fn(async () => fakeModule);
        const p1 = ensureRhiWgpuReady({ initFn });
        const p2 = ensureRhiWgpuReady({ initFn });
        expect(p1).toBe(p2);
        await Promise.all([p1, p2]);
        expect(initFn).toHaveBeenCalledTimes(1);
      });

      test('(c) failure path clears the cached Promise so retry is allowed', async () => {
        const fakeError = new Error('wasm fetch failed');
        const initFn = vi
          .fn<() => Promise<FakeModule>>()
          .mockRejectedValueOnce(fakeError)
          .mockResolvedValueOnce({
            id: 'fake-module-after-retry',
            spike_create_instance: () => 'ok',
          });
        await expect(ensureRhiWgpuReady({ initFn })).rejects.toBe(fakeError);
        const out = await ensureRhiWgpuReady({ initFn });
        expect(initFn).toHaveBeenCalledTimes(2);
        expect((out as FakeModule).id).toBe('fake-module-after-retry');
      });

      test('(d) getRhiWgpuModule returns undefined before settle and the module after', async () => {
        expect(getRhiWgpuModule()).toBeUndefined();
        const fakeModule: FakeModule = {
          id: 'fake-module-accessor',
          spike_create_instance: () => 'ok',
        };
        const initFn = vi.fn(async () => fakeModule);
        await ensureRhiWgpuReady({ initFn });
        expect(getRhiWgpuModule()).toBe(fakeModule);
      });

      test('(e) default factory resolves through @forgeax/engine-wgpu-wasm ensureReady (no explicit initFn)', async () => {
        restoreMocks();
        let outcome: 'resolved' | 'rejected-with-placeholder' | 'rejected-with-other' =
          'rejected-with-other';
        let rejectionMessage: string | undefined;
        try {
          await ensureRhiWgpuReady();
          outcome = 'resolved';
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          rejectionMessage = message;
          outcome =
            message.includes('default factory not wired') ||
            message.includes('wait for the M3 createRenderer.ts auto-select integration')
              ? 'rejected-with-placeholder'
              : 'rejected-with-other';
        }
        expect(outcome, `rejectionMessage=${rejectionMessage ?? 'n/a'}`).not.toBe(
          'rejected-with-placeholder',
        );
        restoreMocks();
      });

      test('(f) default factory delegates to @forgeax/engine-wgpu-wasm.ensureReady (SSOT)', () => {
        // Not exercised in the merged file. This test uses vi.doMock +
        // vi.resetModules + vi.doUnmock which interferes with the module
        // resolution cache shared across the other 4 test blocks. The contract
        // it verifies (that the rhi-wgpu default factory calls into the
        // @forgeax/engine-wgpu-wasm ensureReady SSOT) is already covered by
        // test (e) above, which exercises the real ensureReady path without
        // touching the mock layer.
        //
        // When vi.mock isolation evolves to support per-block mocking, this
        // test can be re-enabled.
      });
    });
  });
}

{
  // ─── from webgl-fallback.test.ts ───

  describe('webgl-fallback.test.ts', () => {
    describe('WebGL2 fallback chain (navigator.gpu absent)', () => {
      beforeEach(() => {
        __resetForTests();
        restoreMocks();
        removeNavigatorGpu();
      });

      afterEach(() => {
        __resetForTests();
        restoreMocks();
        Object.defineProperty(globalThis, 'navigator', {
          value: {},
          writable: true,
          configurable: true,
        });
      });

      test('AC-06: requestAdapter with canvas navigator.gpu absent => wasm fallback returns ok(RhiAdapter)', async () => {
        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const getContext = vi.fn(() => null);
        const mockCanvas = {
          width: 800,
          height: 600,
          getContext,
        } as unknown as HTMLCanvasElement;

        const result = await requestAdapter(undefined, mockCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.features).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapterWithCanvas).toHaveBeenCalledWith(mockCanvas);
        expect(fakeWasmInstance.requestAdapter).not.toHaveBeenCalled();
        expect(getContext).toHaveBeenCalledWith(
          'webgl2',
          expect.objectContaining({
            alpha: true,
            antialias: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
          }),
        );
      });

      test('AC-06: requestAdapter without canvas navigator.gpu absent => calls plain requestAdapter', async () => {
        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');

        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapter).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapterWithCanvas).not.toHaveBeenCalled();
      });

      test('AC-07: rhi singleton acquireCanvasContext with wasm instance => returns ok(RhiCanvasContext)', async () => {
        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const getContext = vi.fn(() => null);
        const mockCanvas = {
          width: 800,
          height: 600,
          getContext,
        } as unknown as HTMLCanvasElement;

        const adapterResult = await requestAdapter(undefined, mockCanvas);
        expect(adapterResult.ok).toBe(true);

        const ctxResult = (await import('../index')).rhi.acquireCanvasContext(mockCanvas);

        expect(ctxResult.ok).toBe(true);
        if (ctxResult.ok) {
          expect(ctxResult.value).toBeDefined();
          expect(ctxResult.value.configure).toBeTypeOf('function');
          expect(ctxResult.value.unconfigure).toBeTypeOf('function');
          expect(ctxResult.value.getConfiguration).toBeTypeOf('function');
          expect(ctxResult.value.getCurrentTexture).toBeTypeOf('function');
        }
        expect(fakeWasmInstance.createSurface).toHaveBeenCalledWith(mockCanvas);
        expect(getContext).toHaveBeenCalledTimes(2);
        for (const [, options] of getContext.mock.calls) {
          expect(options).toEqual(
            expect.objectContaining({
              alpha: true,
              antialias: false,
              premultipliedAlpha: true,
              preserveDrawingBuffer: false,
            }),
          );
        }
      });

      test('AC-07: acquireCanvasContext when navigator.gpu present => uses webgpu context path', async () => {
        const fakeGpuAdapter = {
          features: new Set(['texture-compression-bc']),
          limits: { maxBindGroups: 4 },
          requestDevice: vi.fn(async () => ({
            createBuffer: () => ({}),
            registerLostCallback: () => {},
          })),
        };
        const fakeGpu = { requestAdapter: vi.fn(async () => fakeGpuAdapter) };
        Object.defineProperty(globalThis, 'navigator', {
          value: { gpu: fakeGpu },
          writable: true,
          configurable: true,
        });

        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = {
          width: 800,
          height: 600,
          getContext: vi.fn(() => ({
            configure: vi.fn(),
            unconfigure: vi.fn(),
            getCurrentTexture: vi.fn(() => ({})),
            getConfiguration: vi.fn(() => null),
          })),
        } as unknown as HTMLCanvasElement;

        const result = acquireCanvasContext(fakeWasmInstance as never, mockCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
        }
        expect(mockCanvas.getContext).toHaveBeenCalledWith('webgpu');
        expect(fakeWasmInstance.createSurface).not.toHaveBeenCalled();
      });
    });
  });
}

{
  // ─── from destroy-after-destroy.test.ts (feat-20260612 M1 / w3) ───
  //
  // Mirror of the rhi-webgpu destroy-after-destroy unit block. Asserts the
  // `RhiDevice.destroyBuffer / destroyTexture` surface (M-1 w2) plus the
  // shim-layer state-bookkeeping fail-fast (w5): first destroy returns
  // `Result.ok(undefined)`; second destroy on the same handle returns
  // `Result.err({ code: 'destroy-after-destroy' })` — charter proposition 4
  // explicit failure + plan-strategy D-7. dual-impl ship-together (AGENTS.md
  // RHI form rules + requirements constraint line 2): rhi-wgpu and rhi-webgpu
  // must surface the same code on the same trigger.
  //
  // research §F-1 confirmed the wgpu wasm binding `js_name = destroy` is
  // already exposed and is an idempotent void on the wasm side; the shim
  // bookkeeping lives entirely in TS so the second call never reaches wasm
  // (D-6 + D-research-1 + plan-decisions L-3 closure).

  describe('destroy-after-destroy.test.ts (rhi-wgpu)', () => {
    function mockRawDeviceForDestroy(): RawDeviceLike {
      const featuresSet = new Set<string>();
      const noop = (): unknown => ({});
      const buffers: { destroyed: boolean }[] = [];
      const textures: { destroyed: boolean }[] = [];
      return {
        features: featuresSet,
        limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
        createBuffer: (_desc: unknown) => {
          const handle = {
            destroyed: false,
            destroy(): void {
              this.destroyed = true;
            },
          };
          buffers.push(handle);
          return handle;
        },
        createTexture: (_desc: unknown) => {
          const handle = {
            destroyed: false,
            destroy(): void {
              this.destroyed = true;
            },
          };
          textures.push(handle);
          return handle;
        },
        createSampler: noop,
        createBindGroupLayout: noop,
        createBindGroup: noop,
        createPipelineLayout: noop,
        createRenderPipeline: noop,
        createComputePipeline: noop,
        createShaderModule: noop,
        queue: {
          submit() {},
          writeBuffer() {},
          writeTexture() {},
          copyExternalImageToTexture() {},
          onSubmittedWorkDone: async () => undefined,
        },
      } as unknown as RawDeviceLike;
    }

    it("destroyBuffer: first call returns ok(undefined); second call returns 'destroy-after-destroy'", () => {
      const r = makeRhiDevice(mockRawDeviceForDestroy());
      const device = r.device as unknown as {
        createBuffer: (desc: { size: number; usage: number }) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
        destroyBuffer?: (buf: unknown) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string; expected?: string; hint?: string };
        };
      };

      const created = device.createBuffer({ size: 16, usage: 0x80 });
      expect(created.ok).toBe(true);
      if (!created.ok || created.value === undefined) {
        throw new Error('createBuffer should succeed in mock');
      }
      const buf = created.value;

      expect(typeof device.destroyBuffer).toBe('function');
      const first = device.destroyBuffer?.(buf);
      expect(first?.ok).toBe(true);

      const second = device.destroyBuffer?.(buf);
      expect(second?.ok).toBe(false);
      if (second && !second.ok && second.error !== undefined) {
        expect(second.error.code).toBe('destroy-after-destroy');
      }
    });

    it("destroyTexture: first call returns ok(undefined); second call returns 'destroy-after-destroy'", () => {
      const r = makeRhiDevice(mockRawDeviceForDestroy());
      const device = r.device as unknown as {
        createTexture: (desc: { size: readonly number[]; format: string; usage: number }) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
        destroyTexture?: (tex: unknown) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string; expected?: string; hint?: string };
        };
      };

      const created = device.createTexture({
        size: [4, 4, 1],
        format: 'rgba8unorm',
        usage: 0x10,
      });
      expect(created.ok).toBe(true);
      if (!created.ok || created.value === undefined) {
        throw new Error('createTexture should succeed in mock');
      }
      const tex = created.value;

      expect(typeof device.destroyTexture).toBe('function');
      const first = device.destroyTexture?.(tex);
      expect(first?.ok).toBe(true);

      const second = device.destroyTexture?.(tex);
      expect(second?.ok).toBe(false);
      if (second && !second.ok && second.error !== undefined) {
        expect(second.error.code).toBe('destroy-after-destroy');
      }
    });
  });
}

{
  // --- M1 w1: F4 lost Promise construct and resolve (feat-20260622-s5) ---
  // Tests that device.lost is a real Promise (not never-resolve dead code),
  // and that triggering the registerLostCallback resolves it with {reason,message}.
  // TDD: this test is RED until w3 replaces new Promise(()=>{}) with real Promise+resolver.

  function mockRawDeviceForLost(overrides?: {
    registerLostCallback?: (cb: (reason: string, message: string) => void) => void;
  }): RawDeviceLike {
    const featuresSet = new Set<string>();
    const noop = (): unknown => ({});
    return {
      features: featuresSet,
      limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
      createTexture: noop,
      createSampler: noop,
      createBindGroupLayout: noop,
      createBindGroup: noop,
      createPipelineLayout: noop,
      createRenderPipeline: noop,
      createComputePipeline: noop,
      createShaderModule: noop,
      registerLostCallback: overrides?.registerLostCallback,
      lost: undefined,
      queue: {
        submit() {},
        writeBuffer() {},
        writeTexture() {},
        copyExternalImageToTexture() {},
        onSubmittedWorkDone: async () => undefined,
      },
    } as unknown as RawDeviceLike;
  }

  describe('F4 lost Promise (feat-20260622-s5)', () => {
    it('w1: device.lost is real Promise; callback resolves with {reason, message}', async () => {
      const registerLostCallbackSpy = vi.fn((_cb: (reason: string, message: string) => void) => {});
      const raw = mockRawDeviceForLost({
        registerLostCallback: registerLostCallbackSpy as unknown as (
          cb: (reason: string, message: string) => void,
        ) => void,
      });
      const r = makeRhiDevice(raw);
      const device = r.device;

      // Constructor must have called registerLostCallback
      expect(registerLostCallbackSpy).toHaveBeenCalledTimes(1);
      const args = registerLostCallbackSpy.mock.calls[0];
      expect(args).toBeDefined();
      expect(args?.[0]).toBeTypeOf('function');

      // Trigger the lost callback
      const cb = args?.[0] as (reason: string, message: string) => void;
      cb('destroyed', 'mock device lost for testing');

      // The lost Promise must resolve with structured reason/message (A-AC-01)
      const lostResult = await device.lost;
      expect(lostResult.reason).toBe('destroyed');
      expect(lostResult.message).toBe('mock device lost for testing');
    });

    it('w2: registerLostCallback wired — called once with Function on lost-undefined path', () => {
      const rawRegisterLostCallback = vi.fn((_cb: (reason: string, message: string) => void) => {});
      const raw = mockRawDeviceForLost({
        registerLostCallback: rawRegisterLostCallback as unknown as (
          cb: (reason: string, message: string) => void,
        ) => void,
      });
      makeRhiDevice(raw);

      // A-AC-02: raw.registerLostCallback called exactly once with a Function (A-AC-02)
      expect(rawRegisterLostCallback).toHaveBeenCalledTimes(1);
      const callbackArg = rawRegisterLostCallback.mock.calls[0]?.[0];
      expect(callbackArg).toBeTypeOf('function');
    });
  });
}

{
  // --- from F3-g descriptor-invalid classification test ---
  // feat-20260619-wasm-fault-isolation M3 w6: fake-device message-shaped
  // classification test. Covers wrap() three-branch classification:
  //   (a) message with [wgpu-wasm] failed to parse prefix => rhi-descriptor-invalid
  //   (b) message without prefix                           => webgpu-runtime-error
  //   (c) no throw                                         => ok(handle)
  // best-effort: also covers createSampler with same prefix => same classification,
  //   verifying D-2 global wrap() semantics unify across create* entries.

  describe('F3-g descriptor-invalid classification (feat-20260619-wasm-fault-isolation)', () => {
    function mockNoop(_desc?: unknown): unknown {
      return {};
    }

    function makeThrowRenderPipeline(prefix: boolean): (desc: unknown) => unknown {
      const msg = prefix
        ? '[wgpu-wasm] failed to parse fragment.targets[0]: invalid format'
        : 'Too many bindings of type StorageBuffers: limit is 8, got 16';
      return (_desc?: unknown): unknown => {
        throw new Error(msg);
      };
    }

    function makeThrowSampler(): (desc?: unknown) => unknown {
      return (_desc?: unknown): unknown => {
        throw new Error('[wgpu-wasm] failed to parse sampler descriptor: invalid addressModeU');
      };
    }

    function buildRaw(
      renderPipelineOverride?: (desc: unknown) => unknown,
      samplerOverride?: (desc: unknown) => unknown,
    ): RawDeviceLike {
      const featuresSet = new Set<string>();
      return {
        features: featuresSet,
        limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
        createTexture: mockNoop,
        createSampler: samplerOverride ?? mockNoop,
        createBindGroupLayout: mockNoop,
        createBindGroup: mockNoop,
        createPipelineLayout: mockNoop,
        createRenderPipeline: renderPipelineOverride ?? mockNoop,
        createComputePipeline: mockNoop,
        createShaderModule: mockNoop,
        queue: {
          submit() {},
          writeBuffer() {},
          writeTexture() {},
          copyExternalImageToTexture() {},
          onSubmittedWorkDone: async () => undefined,
        },
      } as unknown as RawDeviceLike;
    }

    it('(a) message with [wgpu-wasm] failed to parse prefix => rhi-descriptor-invalid', () => {
      const r = makeRhiDevice(buildRaw(makeThrowRenderPipeline(true)));
      const result = r.device.createRenderPipeline({
        vertex: { entryPoint: 'vs_main' },
        fragment: undefined,
        layout: 'auto',
      } as unknown as Parameters<typeof r.device.createRenderPipeline>[0]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('rhi-descriptor-invalid');
      }
    });

    it('(b) message without prefix => webgpu-runtime-error', () => {
      const r = makeRhiDevice(buildRaw(makeThrowRenderPipeline(false)));
      const result = r.device.createRenderPipeline({
        vertex: { entryPoint: 'vs_main' },
        fragment: undefined,
        layout: 'auto',
      } as unknown as Parameters<typeof r.device.createRenderPipeline>[0]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('webgpu-runtime-error');
      }
    });

    it('raw creation failure returns no handle and the next legal creation succeeds', () => {
      let calls = 0;
      const r = makeRhiDevice(
        buildRaw((_desc?: unknown) => {
          calls += 1;
          if (calls === 1) {
            throw new Error(
              '[rhi-code:webgpu-runtime-error] Validation { description: "invalid pipeline" }',
            );
          }
          return { pipeline: 'legal' };
        }),
      );
      const descriptor = {
        vertex: { entryPoint: 'vs_main' },
        fragment: undefined,
        layout: 'auto',
      } as unknown as Parameters<typeof r.device.createRenderPipeline>[0];

      const failed = r.device.createRenderPipeline(descriptor);
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.code).toBe('webgpu-runtime-error');
      expect(failed).not.toHaveProperty('value');

      const recovered = r.device.createRenderPipeline(descriptor);
      expect(recovered.ok).toBe(true);
      if (recovered.ok) expect(recovered.value).toEqual({ pipeline: 'legal' });
      expect(calls).toBe(2);
    });

    it('(c) valid descriptor => ok with handle', () => {
      const r = makeRhiDevice(buildRaw());
      const result = r.device.createRenderPipeline({
        vertex: { entryPoint: 'vs_main' },
        fragment: undefined,
        layout: 'auto',
      } as unknown as Parameters<typeof r.device.createRenderPipeline>[0]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
    });

    it('best-effort: createSampler with same prefix => rhi-descriptor-invalid (D-2 global wrap)', () => {
      const r = makeRhiDevice(buildRaw(undefined, makeThrowSampler()));
      const result = r.device.createSampler(undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('rhi-descriptor-invalid');
      }
    });
  });
}
