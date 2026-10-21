import { RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  HealthListenerRegistry,
  LostListenerRegistry,
  RhiErrorListenerRegistry,
} from '../lifecycle';

function verifyDispatch<T>(
  registry: {
    add(listener: (value: T) => void): () => void;
    fire(value: T): void;
    clear(): void;
  },
  value: T,
): void {
  const calls: string[] = [];
  const removeFirst = registry.add(() => {
    calls.push('first');
    removeFirst();
    registry.add(() => calls.push('late'));
  });
  registry.add(() => calls.push('second'));
  registry.fire(value);
  expect(calls).toEqual(['first', 'late', 'second']);
  calls.length = 0;
  registry.fire(value);
  expect(calls).toEqual(['second', 'late']);
  registry.clear();
  calls.length = 0;
  registry.add((replayed) => {
    expect(replayed).toBe(value);
    calls.push('replay');
  });
  expect(calls).toEqual(['replay']);
}

describe('lifecycle listener dispatch', () => {
  it('keeps the device-loss recipient roster stable across reentrant registration', () => {
    verifyDispatch(new LostListenerRegistry(), { reason: 'unknown', message: 'lost' });
  });
  it('keeps the error recipient roster stable across reentrant removal', () => {
    verifyDispatch(
      new RhiErrorListenerRegistry(),
      new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'valid GPU work',
        hint: 'repair the pipeline',
      }),
    );
  });
  it('keeps health replay and dispatch on the same observed snapshot', () => {
    verifyDispatch(new HealthListenerRegistry(), { reason: 'alive', recoverable: false });
  });
});
