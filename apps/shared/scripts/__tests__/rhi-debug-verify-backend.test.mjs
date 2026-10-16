import { describe, expect, it } from 'vitest';
import {
  classifyBrowserWebGpuAlignment,
  closeBrowserBounded,
  resolveBrowserWebGpuLaunch,
  resolveDawnReplaySelection,
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
