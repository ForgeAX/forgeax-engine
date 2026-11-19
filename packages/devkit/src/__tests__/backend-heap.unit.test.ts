import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { backendHeapEnv } from '../backend-heap.js';

const GIB = 1024 ** 3;

describe('backendHeapEnv', () => {
  it.each([
    undefined,
    '--max-old-space-size=2048',
  ])('applies the shared live project child heap policy and preserves override %s', (override) => {
    const env = backendHeapEnv({ ...process.env, NODE_OPTIONS: override }, 64 * GIB);
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `console.log(JSON.stringify({options:process.env.NODE_OPTIONS,heap:require('node:v8').getHeapStatistics().heap_size_limit}))`,
      ],
      { env, encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    const observed = JSON.parse(child.stdout) as { options: string; heap: number };
    const mib = override === undefined ? 8192 : 2048;
    expect(observed.options).toBe(`--max-old-space-size=${mib}`);
    expect(observed.heap).toBeGreaterThanOrEqual(mib * 1024 ** 2);
    expect(observed.heap).toBeLessThan((mib + 512) * 1024 ** 2);
  });
  it('raises the backend old-space limit to 8 GiB on a large machine', () => {
    expect(backendHeapEnv({}, 64 * GIB).NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });

  it('reserves memory for the inherited build child and browser while keeping options', () => {
    expect(backendHeapEnv({ NODE_OPTIONS: '--no-warnings' }, 8 * GIB).NODE_OPTIONS).toBe(
      '--no-warnings --max-old-space-size=2048',
    );
  });

  it('budgets the backend and its inherited build child inside the container limit', () => {
    const env = backendHeapEnv({}, 192 * GIB, 16 * GIB);
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(backendHeapEnv(env, 192 * GIB, 16 * GIB)).toBe(env);
    expect(backendHeapEnv({}, 16 * GIB).NODE_OPTIONS).toBe(env.NODE_OPTIONS);
  });

  it('keeps a limit the caller already set through NODE_OPTIONS', () => {
    const env = { NODE_OPTIONS: '--max-old-space-size=2048' };
    expect(backendHeapEnv(env, 64 * GIB)).toBe(env);
  });
});
