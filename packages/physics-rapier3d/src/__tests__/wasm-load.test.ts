import { beforeEach, expect, it, vi } from 'vitest';

const { init, module } = vi.hoisted(() => {
  const init = vi.fn();
  return { init, module: { init } };
});
vi.mock('../../pkg/rapier.mjs', () => ({ default: module }));
beforeEach(() => {
  vi.resetModules();
  init.mockReset();
});

it('shares pending and settled initialization across concurrent consumers', async () => {
  let finish!: () => void;
  init.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { loadRapier3D } = await import('../wasm-browser');
  const first = loadRapier3D();
  const second = loadRapier3D();
  expect(second).toBe(first);
  await vi.waitFor(() => expect(init).toHaveBeenCalledTimes(1));
  finish();
  expect(await first).toBe(module);
  expect(loadRapier3D()).toBe(first);
  expect(init).toHaveBeenCalledTimes(1);
});

it('returns one structured failure to waiting consumers and retries initialization', async () => {
  init.mockRejectedValueOnce(new Error('WASM unavailable')).mockResolvedValueOnce(undefined);
  const { loadRapier3D } = await import('../wasm-browser');
  const failures = await Promise.all([loadRapier3D(), loadRapier3D()]);
  const { PhysicsError } = await import('@forgeax/engine-types');
  expect(failures[0]).toBeInstanceOf(PhysicsError);
  expect(failures[0]).toBe(failures[1]);
  expect(failures[0].code).toBe('wasm-load-failed');
  expect(failures[0].detail.reason).toBe('WASM unavailable');
  expect(init).toHaveBeenCalledTimes(1);
  expect(await loadRapier3D()).toBe(module);
  expect(init).toHaveBeenCalledTimes(2);
});
