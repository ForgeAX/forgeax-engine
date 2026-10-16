import { afterEach, expect, it, vi } from 'vitest';
import { driveNativeCompletion } from '../internal/native-completion';

afterEach(() => vi.useRealTimers());

it('registers synchronously and only completes from the native callback observation', async () => {
  vi.useFakeTimers();
  const request = { poll: vi.fn().mockReturnValueOnce(false).mockReturnValue(true), free: vi.fn() };
  const start = vi.fn(() => request);
  const result = driveNativeCompletion(start, Promise.resolve(undefined));
  expect(start).toHaveBeenCalledOnce();
  expect(request.poll).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  await expect(result).resolves.toBeUndefined();
  expect(request.poll).toHaveBeenCalledTimes(2);
  expect(request.free).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  new Error('native poll failed'),
  new WebAssembly.RuntimeError('unreachable'),
])('rejects poll failures and releases the ticket without polling again: %s', async (failure) => {
  vi.useFakeTimers();
  const request = {
    poll: vi.fn(() => {
      throw failure;
    }),
    free: vi.fn(),
  };
  const result = driveNativeCompletion(() => request, Promise.resolve(undefined));
  const rejected = expect(result).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  await rejected;
  expect(request.poll).toHaveBeenCalledOnce();
  expect(request.free).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('orders synchronous registration failures behind pending work and permits later work', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const previous = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const order: number[] = [];
  const failure = new Error('native registration failed');
  const first = driveNativeCompletion(() => {
    throw failure;
  }, previous);
  const failed = first.catch((error) => {
    expect(error).toBe(failure);
    order.push(1);
  });
  const request = { poll: () => true, free: vi.fn() };
  const second = driveNativeCompletion(() => request, first).then(() => order.push(2));
  await vi.runAllTimersAsync();
  expect(order).toEqual([]);
  finish();
  await Promise.all([failed, second]);
  expect(order).toEqual([1, 2]);
  expect(request.free).toHaveBeenCalledOnce();
});

it('bounds unsignaled polling and releases the ticket on timeout', async () => {
  vi.useFakeTimers();
  const request = { poll: vi.fn(() => false), free: vi.fn() };
  const result = driveNativeCompletion(() => request, Promise.resolve(undefined));
  const rejected = expect(result).rejects.toThrow('bounded native polls');
  await vi.advanceTimersByTimeAsync(10_001);
  await rejected;
  expect(request.poll).toHaveBeenCalledTimes(10_000);
  expect(request.free).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects at the first wake after the elapsed deadline without another native poll', async () => {
  vi.useFakeTimers();
  const request = { poll: vi.fn(() => false), free: vi.fn() };
  const result = driveNativeCompletion(() => request, Promise.resolve(undefined));
  const rejected = expect(result).rejects.toThrow('bounded native polls');
  vi.setSystemTime(Date.now() + 30_000);
  await vi.runAllTimersAsync();
  await rejected;
  expect(request.poll).not.toHaveBeenCalled();
  expect(request.free).toHaveBeenCalledOnce();
});

it('propagates ticket release errors instead of reporting a successful receipt', async () => {
  vi.useFakeTimers();
  const failure = new Error('release failed');
  const request = {
    poll: () => true,
    free: vi.fn(() => {
      throw failure;
    }),
  };
  const result = driveNativeCompletion(() => request, Promise.resolve(undefined));
  const rejected = expect(result).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves the original native failure when a trap also prevents ticket release', async () => {
  vi.useFakeTimers();
  const failure = new WebAssembly.RuntimeError('native poll trapped');
  const releaseFailure = new Error('Rust value remained borrowed');
  const request = {
    poll() {
      throw failure;
    },
    free() {
      throw releaseFailure;
    },
  };
  const result = driveNativeCompletion(() => request, Promise.resolve(undefined));
  const rejected = expect(result).rejects.toMatchObject({
    cause: failure,
    errors: [failure, releaseFailure],
  });
  await vi.runAllTimersAsync();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
