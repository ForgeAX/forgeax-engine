import { describe, expect, it, vi } from 'vitest';
import {
  classifyBrowserWebGpuAlignment,
  closeBrowserBounded,
  resolveBrowserWebGpuLaunch,
  resolveDawnReplaySelection,
  waitForReadyAppFrame,
} from '../rhi-debug-verify.mjs';

describe('RHI-debug owned browser cleanup', () => {
  it('closes the captured page before shutting down its browser', async () => {
    const order = [];
    let pageOpen = true;
    const page = { close: async (options) => {
      expect(options).toEqual({ runBeforeUnload: false });
      pageOpen = false;
      order.push('page');
    } };
    await closeBrowserBounded({
      contexts: () => [{ pages: () => [page] }],
      close: async () => {
        if (pageOpen) throw new Error('Captured GPU page still owns its target');
        order.push('browser');
      },
    });
    expect(order).toEqual(['page', 'browser']);
  });

  it('keeps page cleanup inside the same bounded shutdown deadline', async () => {
    const browser = {
      contexts: () => [{ pages: () => [{ close: () => new Promise(() => {}) }] }],
      close: async () => {},
    };
    await expect(closeBrowserBounded(browser, 10)).rejects.toThrow('browser close timed out after 10ms');
  });

  it('still shuts down the browser when a page cleanup rejects', async () => {
    let closed = false;
    const browser = {
      contexts: () => [{ pages: () => [{ close: async () => { throw new Error('page cleanup rejected'); } }] }],
      close: async () => { closed = true; },
    };
    await expect(closeBrowserBounded(browser)).rejects.toThrow('page cleanup rejected');
    expect(closed).toBe(true);
  });
});

describe('RHI-debug browser backend selection', () => {
  it('keeps software CI compilation inside the gate deadline without the native GPU watchdog', () => {
    const software = resolveBrowserWebGpuLaunch({ platform: 'linux', backend: 'auto', ci: true });
    const local = resolveBrowserWebGpuLaunch({ platform: 'linux', backend: 'auto', ci: false });
    const metal = resolveBrowserWebGpuLaunch({ platform: 'darwin', backend: 'auto', ci: true });
    expect(software.args).toContain('--disable-gpu-watchdog');
    expect(local.args).not.toContain('--disable-gpu-watchdog');
    expect(metal.args).not.toContain('--disable-gpu-watchdog');
  });

  it('aligns the macOS default with the explicit Dawn Metal replay', () => {
    const launch = resolveBrowserWebGpuLaunch({ platform: 'darwin', backend: 'auto' });

    expect(launch.selectedBackend).toBe('metal');
    expect(launch.comparisonMode).toBe('browser-metal-vs-dawn-metal');
    expect(launch.args).toContain('--use-angle=metal');
    expect(launch.args).not.toContain('--use-vulkan=swiftshader');
  });

  it('keeps SwiftShader Vulkan available as an explicit negative control', () => {
    const launch = resolveBrowserWebGpuLaunch({
      platform: 'darwin',
      backend: 'swiftshader-vulkan',
    });

    expect(launch.selectedBackend).toBe('swiftshader-vulkan');
    expect(launch.comparisonMode).toBe('browser-swiftshader-vulkan-vs-dawn-metal');
    expect(launch.args).toContain('--use-vulkan=swiftshader');
    expect(launch.args).not.toContain('--use-angle=metal');
  });

  it('preserves the existing SwiftShader path on non-macOS hosts', () => {
    const launch = resolveBrowserWebGpuLaunch({ platform: 'linux', backend: 'auto' });

    expect(launch.selectedBackend).toBe('swiftshader-vulkan');
    expect(launch.comparisonMode).toBe('browser-swiftshader-vulkan-vs-dawn-default');
    expect(launch.args).toContain('--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer');
    expect(launch.args).toContain('--use-angle=swiftshader');
    expect(launch.args).not.toContain('--disable-vulkan-surface');
  });

  it('selects Windows software WebGPU without forcing ANGLE Vulkan presentation', () => {
    const launch = resolveBrowserWebGpuLaunch({ platform: 'win32', backend: 'auto' });
    expect(launch.selectedBackend).toBe('swiftshader-vulkan');
    expect(launch.args).toContain('--use-webgpu-adapter=swiftshader');
    expect(launch.args).not.toContain('--use-angle=swiftshader');
    expect(launch.args).not.toContain('--disable-gpu-compositing');
  });

  it('rejects an unsupported explicit Metal request instead of falling back', () => {
    expect(() => resolveBrowserWebGpuLaunch({ platform: 'linux', backend: 'metal' })).toThrow(
      'refusing an implicit backend fallback',
    );
    expect(() => resolveBrowserWebGpuLaunch({ platform: 'darwin', backend: 'unknown' })).toThrow(
      'expected auto, metal, or swiftshader-vulkan',
    );
  });

  it('keeps missing and mismatched adapter identity out of the confirmed state', () => {
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: null,
        adapterInfoSource: 'unavailable',
      }),
    ).toEqual({
      status: 'unverified',
      expectedBackend: 'metal',
      observedBackend: null,
      source: 'unavailable',
    });
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: { backendType: 'Vulkan' },
        adapterInfoSource: 'GPUAdapter.info',
      }).status,
    ).toBe('mismatch');
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: { backendType: 'Metal' },
        adapterInfoSource: 'GPUAdapter.info',
      }).status,
    ).toBe('confirmed');
    expect(
      classifyBrowserWebGpuAlignment({
        selectedBackend: 'metal',
        adapterInfo: { backendType: 'metal-angle' },
        adapterInfoSource: 'GPUAdapter.info',
      }).status,
    ).toBe('mismatch');
  });

  it('pins macOS Dawn replay to Metal independently of the Browser negative control', () => {
    expect(resolveDawnReplaySelection({ platform: 'darwin', requestedBackend: 'metal' })).toEqual({
      requestedBackend: 'metal',
      selectedBackend: 'metal',
      args: ['backend=metal'],
    });
    expect(resolveDawnReplaySelection({ platform: 'darwin', requestedBackend: 'default' })).toEqual(
      {
        requestedBackend: 'default',
        selectedBackend: 'dawn-default',
        args: [],
      },
    );
    expect(
      resolveDawnReplaySelection({ platform: 'linux', requestedBackend: 'default' })
        .selectedBackend,
    ).toBe('dawn-default');
    expect(() =>
      resolveDawnReplaySelection({ platform: 'linux', requestedBackend: 'metal' }),
    ).toThrow('refusing an implicit backend fallback');
  });
});


describe('RHI-debug App scene admission', () => {
  const frame = (frameId, deviceGeneration = 1, worldIdentity = 'world') =>
    ({ frameId, deviceGeneration, worldIdentity });
  const publish = (canvas, progress) => {
    canvas.forgeaxFrameProgress = progress;
    canvas.dispatchEvent(new Event('forgeax:frame-completed'));
  };

  it('waits for a completed ready picture rather than a pending GPU completion', async () => {
    const canvas = new EventTarget();
    publish(canvas, { submitted: frame(1), completed: { ...frame(1), presentation: 'pending' } });
    let settled = false;
    const pending = waitForReadyAppFrame({ canvas, timeoutMs: 90_000 });
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    publish(canvas, { submitted: frame(2), completed: { ...frame(2), presentation: 'ready' } });
    expect((await pending).frameId).toBe(2);
  });

  it('accepts the current completed baseline without waiting for another frame', async () => {
    const canvas = new EventTarget();
    const completed = { ...frame(7), presentation: 'ready' };
    publish(canvas, { submitted: frame(7), completed });
    expect(await waitForReadyAppFrame({ canvas, timeoutMs: 90_000 })).toBe(completed);
  });

  it('admits a ready in-flight successor without requiring the two-credit loop to idle', async () => {
    const canvas = new EventTarget();
    publish(canvas, {
      submitted: { ...frame(8), receipt: { presentation: 'ready' } },
      completed: { ...frame(7), presentation: 'ready' },
    });
    expect((await waitForReadyAppFrame({ canvas, timeoutMs: 90_000 })).frameId).toBe(7);
  });

  it('rejects a stale ready frame across frame, device and World replacement', async () => {
    const canvas = new EventTarget();
    publish(canvas, { submitted: frame(2, 2, 'new'), completed: { ...frame(1), presentation: 'ready' } });
    let settled = false;
    const pending = waitForReadyAppFrame({ canvas, timeoutMs: 90_000 });
    void pending.then(() => { settled = true; });
    for (const stale of [frame(1, 2, 'new'), frame(2, 1, 'new'), frame(2, 2, 'old')]) {
      publish(canvas, { submitted: frame(2, 2, 'new'), completed: { ...stale, presentation: 'ready' } });
      await Promise.resolve();
      expect(settled).toBe(false);
    }
    publish(canvas, { submitted: frame(2, 2, 'new'), completed: { ...frame(2, 2, 'new'), presentation: 'ready' } });
    expect((await pending).worldIdentity).toBe('new');
  });

  it('bounds a missing Engine picture with the owner startup deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForReadyAppFrame({ canvas: new EventTarget(), timeoutMs: 90_000 });
      const rejected = expect(pending).rejects.toThrow('app-scene-preparation timed out after 90000ms');
      await vi.advanceTimersByTimeAsync(90_000);
      await rejected;
    } finally { vi.useRealTimers(); }
  });
});
