import { expect, it } from 'vitest';
import { EndpointError, isEndpointError } from '@forgeax/engine-net';
import type { PeerId } from '@forgeax/engine-net';

const peerId = 7 as PeerId;
const cases = [
  {
    args: { code: 'peer-not-found', detail: { peerId } },
    expected: 'the target peer must exist in the current connection set',
    hint: 'verify the PeerId is from a connect event; check that the peer has not disconnected',
    suffix: '(peerId=7)',
  },
  {
    args: { code: 'connection-closed', detail: { peerId } },
    expected: 'the peer connection must be alive for the operation',
    hint: 'the peer disconnected; poll for a disconnect event and handle the lifecycle',
    suffix: '(peerId=7)',
  },
  {
    args: { code: 'send-failed', detail: { peerId, cause: 'buffer full' } },
    expected: 'message bytes must be delivered to the target peer or the connection must fail',
    hint: 'the connection is broken; the peer may have disconnected or the buffer is full',
    suffix: '(peerId=7, cause=buffer full)',
  },
  {
    args: { code: 'already-closed', detail: { cause: 'retired' } },
    expected: 'the endpoint must be open for any operation',
    hint: 'the endpoint is closed; create a new endpoint for further communication',
    suffix: '(cause=retired)',
  },
  {
    args: { code: 'connection-failed', detail: { address: 'ws://localhost:8787', cause: 'refused' } },
    expected: 'the endpoint factory must successfully establish a connection or bind to the listen address',
    hint: 'the initial connection or bind failed; verify the address is reachable and the port is not in use, then retry',
    suffix: '(address=ws://localhost:8787, cause=refused)',
  },
] as const;

it.each(cases)('constructs complete diagnostics from $args.code and its detail', ({ args, expected, hint, suffix }) => {
  const error = new EndpointError(args);
  expect(isEndpointError(error)).toBe(true);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: args.code, name: 'EndpointError', expected, hint, detail: args.detail });
  expect(error.message).toBe(`[EndpointError ${args.code}] expected: ${expected}; hint: ${hint} ${suffix}`);
  expect(error.detail).toBe(args.detail);
});
