import { describe, expect, it } from 'vitest';
// Import ONLY from the package barrel, never from 'endpoint/errors' deep path.
// This is the regression lock for D-2b: external consumers must be able to
// exhaustively narrow EndpointError via the public entry.
import {
  EndpointError,
  ENDPOINT_EXPECTED,
  ENDPOINT_ERROR_HINTS,
} from '@forgeax/engine-net';
import type { PeerId } from '@forgeax/engine-net';

// ---------------------------------------------------------------------------
// External-consumer narrowing witness (plan-strategy D-2b)
//
// This test proves that import type { EndpointError } from the public barrel
// supports exhaustive narrowing on all 5 error codes (including the new
// connection-failed) without a default branch.
// ---------------------------------------------------------------------------

describe('EndpointError public contract (barrel-only import)', () => {
  it('supports exhaustive switch on all 5 error codes without default', () => {
    function handleError(err: EndpointError): string {
      switch (err.code) {
        case 'peer-not-found':
          return `peer not found: ${err.detail.peerId}`;
        case 'connection-closed':
          return `connection closed: ${err.detail.peerId}`;
        case 'send-failed':
          return `send failed to ${err.detail.peerId}: ${err.detail.cause}`;
        case 'already-closed':
          return `already closed: ${err.detail.cause}`;
        case 'connection-failed':
          return `connection failed: ${err.detail.address} (${err.detail.cause})`;
      }
    }

    const err = new EndpointError({
      code: 'connection-failed',
      expected: ENDPOINT_EXPECTED['connection-failed'],
      hint: ENDPOINT_ERROR_HINTS['connection-failed'],
      detail: { address: 'ws://127.0.0.1:43100', cause: 'ECONNREFUSED' },
    });
    expect(handleError(err)).toContain('connection failed');
    expect(handleError(err)).toContain('ws://127.0.0.1:43100');
    expect(handleError(err)).toContain('ECONNREFUSED');
  });

  it('all 5 error codes have non-empty expected and hint via barrel', () => {
    // Access the tables through the barrel import only.
    const codes: string[] = [
      'peer-not-found',
      'connection-closed',
      'send-failed',
      'already-closed',
      'connection-failed',
    ];
    for (const code of codes) {
      const expected = ENDPOINT_EXPECTED[code as keyof typeof ENDPOINT_EXPECTED];
      const hint = ENDPOINT_ERROR_HINTS[code as keyof typeof ENDPOINT_ERROR_HINTS];
      expect(expected).toBeTypeOf('string');
      expect(expected.length).toBeGreaterThan(0);
      expect(hint).toBeTypeOf('string');
      expect(hint.length).toBeGreaterThan(0);
    }
  });

  it('constructs connection-failed with URL/listen address and cause', () => {
    const err = new EndpointError({
      code: 'connection-failed',
      expected: ENDPOINT_EXPECTED['connection-failed'],
      hint: ENDPOINT_ERROR_HINTS['connection-failed'],
      detail: { address: 'ws://localhost:43100', cause: 'server not running' },
    });
    expect(err.code).toBe('connection-failed');
    expect(err.detail.address).toBe('ws://localhost:43100');
    expect(err.detail.cause).toBe('server not running');
  });

  it('type-check: EndpointError is a discriminated union navigable by .code', () => {
    // This test is a runtime witness that the barrel-imported EndpointError
    // type supports discriminated union narrowing via .code.
    const err = new EndpointError({
      code: 'peer-not-found',
      expected: ENDPOINT_EXPECTED['peer-not-found'],
      hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
      detail: { peerId: 1 as PeerId },
    });
    // Narrowing by .code gives access to per-code detail fields.
    if (err.code === 'peer-not-found') {
      // detail.peerId should be accessible without cast.
      const { peerId } = err.detail;
      expect(peerId).toBe(1);
    }
  });
});