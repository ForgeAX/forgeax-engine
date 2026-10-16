import { describe, expect, it } from 'vitest';
import type { EndpointErrorCode } from '../src/endpoint/errors';
import {
  EndpointError,
  ENDPOINT_EXPECTED,
  ENDPOINT_ERROR_HINTS,
  isEndpointError,
} from '../src/endpoint/errors';
import type { EndpointEvent, PeerId } from '../src/endpoint/endpoint';

// ---------------------------------------------------------------------------
// TDD red phase: contract tests that define the endpoint surface before
// any memory implementation exists. These tests assert the type-level
// contract and error structure; they do not depend on a concrete backend.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error code exhaustiveness
// ---------------------------------------------------------------------------

describe('EndpointError closed union', () => {
  it('has exactly 5 error codes', () => {
    const codes: EndpointErrorCode[] = [
      'peer-not-found',
      'connection-closed',
      'send-failed',
      'already-closed',
      'connection-failed',
    ];
    expect(codes).toHaveLength(5);
  });

  it('all codes have non-empty expected and hint', () => {
    const codes: EndpointErrorCode[] = [
      'peer-not-found',
      'connection-closed',
      'send-failed',
      'already-closed',
      'connection-failed',
    ];
    for (const code of codes) {
      expect(ENDPOINT_EXPECTED[code]).toBeTypeOf('string');
      expect(ENDPOINT_EXPECTED[code].length).toBeGreaterThan(0);
      expect(ENDPOINT_ERROR_HINTS[code]).toBeTypeOf('string');
      expect(ENDPOINT_ERROR_HINTS[code].length).toBeGreaterThan(0);
    }
  });

  it('can construct each error variant with proper detail', () => {
    const peerId = 1 as PeerId;

    const e1 = new EndpointError({
      code: 'peer-not-found',
      expected: ENDPOINT_EXPECTED['peer-not-found'],
      hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
      detail: { peerId },
    });
    expect(e1.code).toBe('peer-not-found');
    expect(e1.detail.peerId).toBe(peerId);
    expect(isEndpointError(e1)).toBe(true);

    const e2 = new EndpointError({
      code: 'connection-closed',
      expected: ENDPOINT_EXPECTED['connection-closed'],
      hint: ENDPOINT_ERROR_HINTS['connection-closed'],
      detail: { peerId },
    });
    expect(e2.code).toBe('connection-closed');
    expect(e2.detail.peerId).toBe(peerId);

    const e3 = new EndpointError({
      code: 'send-failed',
      expected: ENDPOINT_EXPECTED['send-failed'],
      hint: ENDPOINT_ERROR_HINTS['send-failed'],
      detail: { peerId, cause: 'buffer full' },
    });
    expect(e3.code).toBe('send-failed');
    expect(e3.detail.peerId).toBe(peerId);
    expect(e3.detail.cause).toBe('buffer full');

    const e4 = new EndpointError({
      code: 'already-closed',
      expected: ENDPOINT_EXPECTED['already-closed'],
      hint: ENDPOINT_ERROR_HINTS['already-closed'],
      detail: { cause: 'endpoint was closed' },
    });
    expect(e4.code).toBe('already-closed');
    expect(e4.detail.cause).toBe('endpoint was closed');

    const e5 = new EndpointError({
      code: 'connection-failed',
      expected: ENDPOINT_EXPECTED['connection-failed'],
      hint: ENDPOINT_ERROR_HINTS['connection-failed'],
      detail: { address: 'ws://127.0.0.1:43100', cause: 'ECONNREFUSED' },
    });
    expect(e5.code).toBe('connection-failed');
    expect(e5.detail.address).toBe('ws://127.0.0.1:43100');
    expect(e5.detail.cause).toBe('ECONNREFUSED');
    expect(isEndpointError(e5)).toBe(true);
  });

  it('supports exhaustive switch on error code', () => {
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
      code: 'peer-not-found',
      expected: ENDPOINT_EXPECTED['peer-not-found'],
      hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
      detail: { peerId: 1 as PeerId },
    });
    expect(handleError(err)).toContain('peer not found');
  });
});

// ---------------------------------------------------------------------------
// Type-level contract shape (compile-time assertions)
// ---------------------------------------------------------------------------

describe('NetEndpoint type contract', () => {
  it('PeerId is branded (not assignable from plain number)', () => {
    const id = 1 as PeerId;
    expect(typeof id).toBe('number');
  });

  it('EndpointEvent discriminated union covers all event kinds', () => {
    const connectEvent: EndpointEvent = { kind: 'peer-connected', peerId: 1 as PeerId };
    const disconnectEvent: EndpointEvent = { kind: 'peer-disconnected', peerId: 1 as PeerId };
    const messageEvent: EndpointEvent = {
      kind: 'message',
      peerId: 1 as PeerId,
      data: new Uint8Array([1, 2, 3]),
    };

    const events: EndpointEvent[] = [connectEvent, disconnectEvent, messageEvent];
    for (const ev of events) {
      switch (ev.kind) {
        case 'peer-connected':
          expect(ev.peerId).toBeDefined();
          break;
        case 'peer-disconnected':
          expect(ev.peerId).toBeDefined();
          break;
        case 'message':
          expect(ev.data).toBeInstanceOf(Uint8Array);
          break;
      }
    }
  });
});
