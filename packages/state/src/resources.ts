import type { StateToken } from './define-state';

/** One World resource owns a token's committed values and pending request. */
export interface StatePayload {
  current: number;
  previous: number;
  next: { value: number; force: boolean } | undefined;
}

export function stateResourceKey(token: StateToken): string {
  return `__state__${token.name}`;
}
