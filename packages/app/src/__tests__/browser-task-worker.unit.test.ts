import { afterEach, expect, it, vi } from 'vitest';
import { browserTaskWorker } from '../execution/browser-task-worker';

afterEach(() => vi.unstubAllGlobals());

it('starts a Task Worker when a sandboxed iframe denies Service Worker access', () => {
  vi.stubGlobal('navigator', {
    get serviceWorker() {
      throw new DOMException('Service Worker is disabled in the sandbox', 'SecurityError');
    },
  });
  const addEventListener = vi.fn();
  const create = vi.fn(
    class {
      readonly addEventListener = addEventListener;
    },
  );
  vi.stubGlobal('Worker', create);

  expect(browserTaskWorker().addEventListener).toBe(addEventListener);
  expect(create).toHaveBeenCalledExactlyOnceWith(expect.any(URL), {
    type: 'module',
    name: 'forgeax-task',
  });
  expect(addEventListener).not.toHaveBeenCalled();
});
