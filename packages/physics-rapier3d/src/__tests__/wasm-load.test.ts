import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const validate = WebAssembly.validate.bind(WebAssembly);

const { init, module, simdInit, simdModule } = vi.hoisted(() => {
  const init = vi.fn();
  const simdInit = vi.fn();
  return { init, module: { init }, simdInit, simdModule: { init: simdInit } };
});
vi.mock('../../pkg/rapier.mjs', () => ({ default: module }));
vi.mock('../../pkg/rapier-simd.mjs', () => ({ default: simdModule }));
beforeEach(() => {
  vi.resetModules();
  init.mockReset();
  simdInit.mockReset();
  vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('selects the SIMD payload only after the current WebAssembly runtime accepts SIMD', async () => {
  vi.mocked(WebAssembly.validate).mockReturnValue(true);
  const { loadRapier3D } = await import('../wasm-browser');
  expect(await loadRapier3D()).toBe(simdModule);
  expect(simdInit).toHaveBeenCalledTimes(1);
  expect(init).not.toHaveBeenCalled();
  const probe = vi.mocked(WebAssembly.validate).mock.calls[0]?.[0];
  if (probe === undefined) throw new Error('The SIMD capability probe was not evaluated');
  expect(probe).toBeInstanceOf(Uint8Array);
  expect(validate(probe)).toBe(true);
});

it('retains the scalar path when SIMD validation is unavailable or refused', async () => {
  vi.mocked(WebAssembly.validate).mockImplementation(() => {
    throw new Error('feature validation is unavailable');
  });
  const { loadRapier3D } = await import('../wasm-browser');
  expect(await loadRapier3D()).toBe(module);
  expect(init).toHaveBeenCalledTimes(1);
  expect(simdInit).not.toHaveBeenCalled();
});

it('reports an admitted SIMD initialization failure and retries without hiding it as fallback', async () => {
  vi.mocked(WebAssembly.validate).mockReturnValue(true);
  simdInit
    .mockRejectedValueOnce(new Error('SIMD payload unavailable'))
    .mockResolvedValue(undefined);
  const { loadRapier3D } = await import('../wasm-browser');
  const failure = await loadRapier3D();
  expect(failure.code).toBe('wasm-load-failed');
  expect(failure.detail.reason).toBe('SIMD payload unavailable');
  expect(init).not.toHaveBeenCalled();
  expect(await loadRapier3D()).toBe(simdModule);
  expect(simdInit).toHaveBeenCalledTimes(2);
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
