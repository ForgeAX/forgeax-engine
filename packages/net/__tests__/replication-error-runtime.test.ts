import { describe, expect, it } from 'vitest';
import { NetError } from '@forgeax/engine-net';

describe('replication NetError runtime contract', () => {
  it('preserves the public Error name, message, and instanceof behavior', () => {
    const error = new NetError({
      code: 'apply-invariant-failed',
      expected: 'ECS apply invariants to accept a validated batch',
      hint: 'stop this replication session and inspect the ECS error',
      detail: { reason: 'replication stopped' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(NetError);
    expect(error.name).toBe('NetError');
    expect(error.message).toBe(
      '[NetError apply-invariant-failed] expected: ECS apply invariants to accept a validated batch; hint: stop this replication session and inspect the ECS error',
    );
    expect(error.code).toBe('apply-invariant-failed');
    expect(error.expected).toBe('ECS apply invariants to accept a validated batch');
    expect(error.hint).toBe('stop this replication session and inspect the ECS error');
    expect(error.detail).toEqual({ reason: 'replication stopped' });
  });
});
