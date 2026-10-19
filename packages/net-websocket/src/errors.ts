import { EndpointError, type PeerId } from '@forgeax/engine-net';
import { err, type Result } from '@forgeax/engine-types';

export function connectionFailed(address: string, cause: unknown): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'connection-failed',
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
      detail: { cause },
    }),
  );
}

export function connectionClosed(peerId: PeerId): Result<never, EndpointError> {
  return err(
    new EndpointError({
      code: 'connection-closed',
      detail: { peerId },
    }),
  );
}

export function normalizeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'WebSocket operation failed without a platform error message.';
}
