import { describe, expect, it } from 'vitest';
import { backendHeapEnv } from '../backend-process.js';

const GIB = 1024 ** 3;

describe('backendHeapEnv', () => {
  it('raises the backend old-space limit to 8 GiB on a large machine', () => {
    expect(backendHeapEnv({}, 64 * GIB).NODE_OPTIONS).toBe('--max-old-space-size=8192');
  });

  it('caps the limit at half the machine memory and keeps existing options', () => {
    expect(backendHeapEnv({ NODE_OPTIONS: '--no-warnings' }, 8 * GIB).NODE_OPTIONS).toBe(
      '--no-warnings --max-old-space-size=4096',
    );
  });

  it('keeps a limit the caller already set through NODE_OPTIONS', () => {
    const env = { NODE_OPTIONS: '--max-old-space-size=2048' };
    expect(backendHeapEnv(env, 64 * GIB)).toBe(env);
  });
});
