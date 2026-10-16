import {
  ENDPOINT_ERROR_HINTS,
  ENDPOINT_EXPECTED,
  EndpointError,
  type PeerId,
} from '@forgeax/engine-net';
import { err, type Result } from '@forgeax/engine-types';

export function connectionFailed(address: string, cause: unknown): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'connection-failed',
      expected: ENDPOINT_EXPECTED['connection-failed'],
      hint: ENDPOINT_ERROR_HINTS['connection-failed'],
      detail: { address, cause: normalizeCause(cause) },
    }),
  );
}

export function alreadyClosed(
  cause = 'The WebSocket endpoint is closed.',
): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'already-closed',
      expected: ENDPOINT_EXPECTED['already-closed'],
      hint: ENDPOINT_ERROR_HINTS['already-closed'],
      detail: { cause },
    }),
  );
}

export function connectionClosed(peerId: PeerId): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'connection-closed',
      expected: ENDPOINT_EXPECTED['connection-closed'],
      hint: ENDPOINT_ERROR_HINTS['connection-closed'],
      detail: { peerId },
    }),
  );
}

export function normalizeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'WebSocket operation failed without a platform error message.';
}
