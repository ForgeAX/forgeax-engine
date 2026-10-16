// Error variants intersect the backing class. Check detail assignability in both
// directions so equivalent intersection representations retain exact contracts.
import type { PeerId } from '../src/index';
declare const peerId: PeerId;
// Type-level exhaustiveness test for EndpointError (requirements AC-13).
// Verifies that EndpointErrorCode is a closed 5-member union and that
// EndpointErrorDetailFor<C> narrows the detail per code.

import { EndpointError } from '../src/endpoint/errors';
import type {
  EndpointError as EndpointErrorType,
  EndpointErrorCode,
  EndpointErrorDetail,
  EndpointErrorDetailFor,
  EndpointDetailPeerNotFound,
  EndpointDetailConnectionClosed,
  EndpointDetailSendFailed,
  EndpointDetailAlreadyClosed,
  EndpointDetailConnectionFailed,
} from '../src/endpoint/errors';
import { expectTypeOf, test } from 'vitest';

test('EndpointErrorCode is a 5-member closed union', () => {
  type ExpectedCodes = 'peer-not-found' | 'connection-closed' | 'send-failed' | 'already-closed' | 'connection-failed';
  expectTypeOf<EndpointErrorCode>().toEqualTypeOf<ExpectedCodes>();
  expectTypeOf<ExpectedCodes>().toEqualTypeOf<EndpointErrorCode>();
  expectTypeOf<EndpointErrorType['code']>().toEqualTypeOf<EndpointErrorCode>();
  expectTypeOf<EndpointErrorCode>().toEqualTypeOf<EndpointErrorType['code']>();
});

test('EndpointErrorDetailFor narrows detail per code', () => {
  expectTypeOf<EndpointErrorDetailFor<'peer-not-found'>>().toEqualTypeOf<EndpointDetailPeerNotFound>();
  expectTypeOf<EndpointErrorDetailFor<'connection-closed'>>().toEqualTypeOf<EndpointDetailConnectionClosed>();
  expectTypeOf<EndpointErrorDetailFor<'send-failed'>>().toEqualTypeOf<EndpointDetailSendFailed>();
  expectTypeOf<EndpointErrorDetailFor<'already-closed'>>().toEqualTypeOf<EndpointDetailAlreadyClosed>();
  expectTypeOf<EndpointErrorDetailFor<'connection-failed'>>().toEqualTypeOf<EndpointDetailConnectionFailed>();
});

test('EndpointErrorDetail derives from the complete code resolver', () => {
  expectTypeOf<EndpointErrorDetail>().toEqualTypeOf<EndpointErrorDetailFor<EndpointErrorCode>>();
});

test('EndpointError constructor preserves code-specific inference', () => {
  const peerNotFound = new EndpointError({
    code: 'peer-not-found',
    expected: 'a peer',
    hint: 'use a connected peer',
    detail: { peerId },
  });
  const connectionClosed = new EndpointError({
    code: 'connection-closed',
    expected: 'an open connection',
    hint: 'poll disconnects',
    detail: { peerId },
  });
  const sendFailed = new EndpointError({
    code: 'send-failed',
    expected: 'delivered bytes',
    hint: 'retry after reconnecting',
    detail: { peerId, cause: 'buffer full' },
  });
  const alreadyClosed = new EndpointError({
    code: 'already-closed',
    expected: 'an open endpoint',
    hint: 'create a new endpoint',
    detail: { cause: 'closed' },
  });
  const connectionFailed = new EndpointError({
    code: 'connection-failed',
    expected: 'a reachable address',
    hint: 'verify the address',
    detail: { address: '127.0.0.1:8787', cause: 'refused' },
  });

  expectTypeOf(peerNotFound.code).toEqualTypeOf<'peer-not-found'>();
  expectTypeOf(peerNotFound.detail).toMatchTypeOf<EndpointDetailPeerNotFound>();
  expectTypeOf<EndpointDetailPeerNotFound>().toMatchTypeOf<typeof peerNotFound.detail>();
  expectTypeOf(connectionClosed.code).toEqualTypeOf<'connection-closed'>();
  expectTypeOf(connectionClosed.detail).toMatchTypeOf<EndpointDetailConnectionClosed>();
  expectTypeOf<EndpointDetailConnectionClosed>().toMatchTypeOf<typeof connectionClosed.detail>();
  expectTypeOf(sendFailed.code).toEqualTypeOf<'send-failed'>();
  expectTypeOf(sendFailed.detail).toMatchTypeOf<EndpointDetailSendFailed>();
  expectTypeOf<EndpointDetailSendFailed>().toMatchTypeOf<typeof sendFailed.detail>();
  expectTypeOf(alreadyClosed.code).toEqualTypeOf<'already-closed'>();
  expectTypeOf(alreadyClosed.detail).toMatchTypeOf<EndpointDetailAlreadyClosed>();
  expectTypeOf<EndpointDetailAlreadyClosed>().toMatchTypeOf<typeof alreadyClosed.detail>();
  expectTypeOf(connectionFailed.code).toEqualTypeOf<'connection-failed'>();
  expectTypeOf(connectionFailed.detail).toMatchTypeOf<EndpointDetailConnectionFailed>();
  expectTypeOf<EndpointDetailConnectionFailed>().toMatchTypeOf<typeof connectionFailed.detail>();
});

test('EndpointError rejects mismatched code and detail pairs', () => {
  new EndpointError({
    code: 'already-closed',
    expected: 'an open endpoint',
    hint: 'create a new endpoint',
    // @ts-expect-error code/detail pairs remain correlated.
    detail: { peerId },
  });
});

test('EndpointError narrows every detail payload exhaustively', () => {
  const describe = (error: EndpointErrorType): string => {
    switch (error.code) {
      case 'peer-not-found':
        expectTypeOf(error.detail).toMatchTypeOf<EndpointDetailPeerNotFound>();
        expectTypeOf<EndpointDetailPeerNotFound>().toMatchTypeOf<typeof error.detail>();
        return String(error.detail.peerId);
      case 'connection-closed':
        expectTypeOf(error.detail).toMatchTypeOf<EndpointDetailConnectionClosed>();
        expectTypeOf<EndpointDetailConnectionClosed>().toMatchTypeOf<typeof error.detail>();
        return String(error.detail.peerId);
      case 'send-failed':
        expectTypeOf(error.detail).toMatchTypeOf<EndpointDetailSendFailed>();
        expectTypeOf<EndpointDetailSendFailed>().toMatchTypeOf<typeof error.detail>();
        return `${error.detail.peerId}:${error.detail.cause}`;
      case 'already-closed':
        expectTypeOf(error.detail).toMatchTypeOf<EndpointDetailAlreadyClosed>();
        expectTypeOf<EndpointDetailAlreadyClosed>().toMatchTypeOf<typeof error.detail>();
        return error.detail.cause;
      case 'connection-failed':
        expectTypeOf(error.detail).toMatchTypeOf<EndpointDetailConnectionFailed>();
        expectTypeOf<EndpointDetailConnectionFailed>().toMatchTypeOf<typeof error.detail>();
        return `${error.detail.address}:${error.detail.cause}`;
    }
    const exhaustive: never = error;
    return exhaustive;
  };

  expectTypeOf(describe).returns.toEqualTypeOf<string>();
});
