import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  type EndpointErrorCode,
  type EndpointError as EndpointErrorType,
  type EndpointDetailAlreadyClosed,
  type EndpointDetailConnectionClosed,
  type EndpointDetailConnectionFailed,
  type EndpointDetailPeerNotFound,
  type EndpointDetailSendFailed,
} from '../src/endpoint/errors';
import type { PeerId } from '../src/endpoint/endpoint';

const CODES_IN_POLICY_ORDER = [
  'peer-not-found',
  'connection-closed',
  'send-failed',
  'already-closed',
  'connection-failed',
] as const satisfies readonly EndpointErrorCode[];

const EXPECTED_IN_POLICY_ORDER = [
  'the target peer must exist in the current connection set',
  'the peer connection must be alive for the operation',
  'message bytes must be delivered to the target peer or the connection must fail',
  'the endpoint must be open for any operation',
  'the endpoint factory must successfully establish a connection or bind to the listen address',
] as const;

const HINTS_IN_POLICY_ORDER = [
  'verify the PeerId is from a connect event; check that the peer has not disconnected',
  'the peer disconnected; poll for a disconnect event and handle the lifecycle',
  'the memory connection is broken; the peer may have disconnected or the buffer is full',
  'the endpoint is closed; create a new endpoint pair for further communication',
  'the initial connection or bind failed; verify the address is reachable and the port is not in use, then retry',
] as const;

describe('EndpointError policy owner', () => {
  it('projects the exact five-code policy surface with stable own-key order', () => {
    expect(CODES_IN_POLICY_ORDER).toHaveLength(5);
    expect(new Set(CODES_IN_POLICY_ORDER).size).toBe(5);

    for (const policy of [ENDPOINT_EXPECTED, ENDPOINT_ERROR_HINTS]) {
      expect(Object.keys(policy)).toEqual(CODES_IN_POLICY_ORDER);
      expect(Object.getOwnPropertyNames(policy)).toEqual(CODES_IN_POLICY_ORDER);
      expect(Object.getOwnPropertySymbols(policy)).toEqual([]);
      for (const code of CODES_IN_POLICY_ORDER) {
        expect(Object.prototype.propertyIsEnumerable.call(policy, code)).toBe(true);
      }
    }

    expect(Object.values(ENDPOINT_EXPECTED)).toEqual(EXPECTED_IN_POLICY_ORDER);
    expect(Object.values(ENDPOINT_ERROR_HINTS)).toEqual(HINTS_IN_POLICY_ORDER);
  });

  it('keeps every expected and hint string byte-identical', () => {
    for (const [index, code] of CODES_IN_POLICY_ORDER.entries()) {
      expect(ENDPOINT_EXPECTED[code]).toBe(EXPECTED_IN_POLICY_ORDER[index]);
      expect(ENDPOINT_ERROR_HINTS[code]).toBe(HINTS_IN_POLICY_ORDER[index]);
    }
  });

  it('preserves public record types and every correlated EndpointError variant', () => {
    type EndpointPolicyCode = keyof typeof ENDPOINT_EXPECTED;

    expectTypeOf<EndpointErrorCode>().toEqualTypeOf<EndpointPolicyCode>();
    expectTypeOf<EndpointPolicyCode>().toEqualTypeOf<EndpointErrorCode>();
    expectTypeOf<'not-an-endpoint-error'>().not.toExtend<EndpointErrorCode>();
    expectTypeOf(ENDPOINT_EXPECTED).toEqualTypeOf<Readonly<Record<EndpointErrorCode, string>>>();
    expectTypeOf(ENDPOINT_ERROR_HINTS).toEqualTypeOf<
      Readonly<Record<EndpointErrorCode, string>>
    >();

    const peerNotFound = new EndpointError({
      code: 'peer-not-found',
      expected: ENDPOINT_EXPECTED['peer-not-found'],
      hint: ENDPOINT_ERROR_HINTS['peer-not-found'],
      detail: { peerId: 1 as PeerId },
    });
    expectTypeOf(peerNotFound).toEqualTypeOf<
      Extract<EndpointErrorType, { readonly code: 'peer-not-found' }>
    >();
    expectTypeOf(peerNotFound.detail).toEqualTypeOf<EndpointDetailPeerNotFound>();
    expect(peerNotFound.detail.peerId).toBe(1);

    const connectionClosed = new EndpointError({
      code: 'connection-closed',
      expected: ENDPOINT_EXPECTED['connection-closed'],
      hint: ENDPOINT_ERROR_HINTS['connection-closed'],
      detail: { peerId: 2 as PeerId },
    });
    expectTypeOf(connectionClosed).toEqualTypeOf<
      Extract<EndpointErrorType, { readonly code: 'connection-closed' }>
    >();
    expectTypeOf(connectionClosed.detail).toEqualTypeOf<EndpointDetailConnectionClosed>();
    expect(connectionClosed.detail.peerId).toBe(2);

    const sendFailed = new EndpointError({
      code: 'send-failed',
      expected: ENDPOINT_EXPECTED['send-failed'],
      hint: ENDPOINT_ERROR_HINTS['send-failed'],
      detail: { peerId: 3 as PeerId, cause: 'buffer full' },
    });
    expectTypeOf(sendFailed).toEqualTypeOf<Extract<EndpointErrorType, { readonly code: 'send-failed' }>>();
    expectTypeOf(sendFailed.detail).toEqualTypeOf<EndpointDetailSendFailed>();
    expect(sendFailed.detail).toEqual({ peerId: 3, cause: 'buffer full' });

    const alreadyClosed = new EndpointError({
      code: 'already-closed',
      expected: ENDPOINT_EXPECTED['already-closed'],
      hint: ENDPOINT_ERROR_HINTS['already-closed'],
      detail: { cause: 'endpoint was closed' },
    });
    expectTypeOf(alreadyClosed).toEqualTypeOf<
      Extract<EndpointErrorType, { readonly code: 'already-closed' }>
    >();
    expectTypeOf(alreadyClosed.detail).toEqualTypeOf<EndpointDetailAlreadyClosed>();
    expect(alreadyClosed.detail.cause).toBe('endpoint was closed');

    const connectionFailed = new EndpointError({
      code: 'connection-failed',
      expected: ENDPOINT_EXPECTED['connection-failed'],
      hint: ENDPOINT_ERROR_HINTS['connection-failed'],
      detail: { address: 'ws://127.0.0.1:43100', cause: 'ECONNREFUSED' },
    });
    expectTypeOf(connectionFailed).toEqualTypeOf<
      Extract<EndpointErrorType, { readonly code: 'connection-failed' }>
    >();
    expectTypeOf(connectionFailed.detail).toEqualTypeOf<EndpointDetailConnectionFailed>();
    expect(connectionFailed.detail).toEqual({
      address: 'ws://127.0.0.1:43100',
      cause: 'ECONNREFUSED',
    });
  });
});
