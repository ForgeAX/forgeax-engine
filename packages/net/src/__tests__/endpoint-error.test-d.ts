import { expectTypeOf, it } from 'vitest';
import type { PeerId } from '../endpoint/endpoint';
import { EndpointError, type EndpointError as ErrorUnion } from '../endpoint/errors';

it('correlates constructor details and the returned error code', () => {
  const peerId = 1 as PeerId;
  const error = new EndpointError({
    code: 'send-failed',
    expected: 'delivery',
    hint: 'retry',
    detail: { peerId, cause: 'closed' },
  });
  expectTypeOf(error).toEqualTypeOf<Extract<ErrorUnion, { code: 'send-failed' }>>();
  new EndpointError({
    code: 'send-failed',
    expected: 'delivery',
    hint: 'retry',
    // @ts-expect-error a connection address cannot replace a send failure's peer identity
    detail: { address: 'ws://localhost', cause: 'closed' },
  });
});
