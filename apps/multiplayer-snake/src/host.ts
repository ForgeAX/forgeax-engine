import type { HostRootDescriptor } from '@forgeax/engine-host/protocol';

export const SNAKE_HOST_VERSION = '0.0.0';
export function snakeHostRoot(): HostRootDescriptor {
  return {
    program: 'snake:client',
    codeRevision: SNAKE_HOST_VERSION,
    config: { protocolVersion: 2 },
  };
}
