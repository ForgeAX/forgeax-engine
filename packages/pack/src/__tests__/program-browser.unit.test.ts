import { afterEach, expect, it, vi } from 'vitest';
import { prepareBrowserPackProgramScope } from '../program-browser.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('bounds registration and ignores a lookup that completes after the page gives up', async () => {
  vi.useFakeTimers();
  let finishLookup!: (value: undefined) => void;
  const registration = new Promise<undefined>((resolve) => {
    finishLookup = resolve;
  });
  const serviceWorker = {
    getRegistration: vi.fn(() => registration),
    register: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('caches', {});
  vi.stubGlobal('location', { href: 'https://example.test/games/demo/' });
  const pending = prepareBrowserPackProgramScope('./forgeax-pack-program-worker.js');
  const rejected = expect(pending).rejects.toThrow('preparation timed out');
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  finishLookup(undefined);
  await Promise.resolve();
  expect(serviceWorker.register).not.toHaveBeenCalled();
  expect(serviceWorker.addEventListener).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves an existing application service worker owned by the host', async () => {
  const serviceWorker = {
    getRegistration: vi.fn(async () => ({
      active: { scriptURL: 'https://example.test/game-worker.js' },
    })),
    register: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('caches', {});
  vi.stubGlobal('location', { href: 'https://example.test/' });
  await expect(prepareBrowserPackProgramScope('./forgeax-pack-program-worker.js')).rejects.toThrow(
    'integrate Pack program delivery into its existing service worker',
  );
  expect(serviceWorker.register).not.toHaveBeenCalled();
});
