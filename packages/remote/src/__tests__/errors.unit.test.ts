// w11: RemoteErrorCode completeness unit test (5-member closed union).
// Verifies that the error-code family has exactly 4 members after
// deleting inspector-write-denied + script-timeout in w7.

import { describe, expect, it } from 'vitest';
import { REMOTE_ERROR_CODE_TO_JSONRPC, RemoteError, type RemoteErrorCode } from '../errors';

const EXPECTED_MEMBERS: readonly RemoteErrorCode[] = [
  'script-syntax-error',
  'script-runtime-error',
  'server-startup-failed',
  'server-not-running',
  'eval-result-not-serializable',
];

describe('RemoteErrorCode closed union — 5-member completeness', () => {
  it('REMOTE_ERROR_CODE_TO_JSONRPC has exactly 5 keys matching the expected set', () => {
    const keys = Object.keys(REMOTE_ERROR_CODE_TO_JSONRPC) as RemoteErrorCode[];
    expect(keys).toHaveLength(5);
    // Sort-stable comparison — order is incidental
    expect([...keys].sort()).toStrictEqual([...EXPECTED_MEMBERS].sort());
  });

  it('no inspector-write-denied residue', () => {
    expect(
      REMOTE_ERROR_CODE_TO_JSONRPC['inspector-write-denied' as RemoteErrorCode],
    ).toBeUndefined();
  });

  it('no script-timeout residue', () => {
    expect(REMOTE_ERROR_CODE_TO_JSONRPC['script-timeout' as RemoteErrorCode]).toBeUndefined();
  });

  for (const code of EXPECTED_MEMBERS) {
    it(`REMOTE_ERROR_CODE_TO_JSONRPC[${JSON.stringify(code)}] is a number`, () => {
      expect(typeof REMOTE_ERROR_CODE_TO_JSONRPC[code]).toBe('number');
    });
  }
});

describe('RemoteError construction + toJSON', () => {
  it('constructs with all 4 fields', () => {
    const err = new RemoteError({
      code: 'script-syntax-error',
      expected: 'valid JS',
      hint: 'fix it',
    });
    expect(err.code).toBe('script-syntax-error');
    expect(err.expected).toBe('valid JS');
    expect(err.hint).toBe('fix it');
    expect(err.message).toContain('[RemoteError script-syntax-error]');
  });

  it('toJSON() returns 4-field plain object', () => {
    const err = new RemoteError({
      code: 'server-not-running',
      expected: 'server reachable',
      hint: 'start demo',
    });
    const json = err.toJSON();
    expect(json).toStrictEqual({
      code: 'server-not-running',
      expected: 'server reachable',
      hint: 'start demo',
      message: err.message,
    });
  });

  it('server-startup-failed carries descriptive hint', () => {
    const err = new RemoteError({
      code: 'server-startup-failed',
      expected: 'server starts',
      hint: 'port occupied',
    });
    expect(err.code).toBe('server-startup-failed');
    expect(err.hint).toBe('port occupied');
  });

  it('script-runtime-error carries error context', () => {
    const err = new RemoteError({
      code: 'script-runtime-error',
      expected: 'script executes',
      hint: 'check symbols',
    });
    expect(err.code).toBe('script-runtime-error');
    expect(err.expected).toBe('script executes');
  });
});
