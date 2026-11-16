import { defineResource, type Resource } from '@forgeax/engine-ecs';
import type { StateToken } from './define-state';

/** One World resource owns a token's committed values and pending request. */
export interface StatePayload {
  current: number;
  previous: number;
  next: { value: number; force: boolean } | undefined;
}

const stateResources = new WeakMap<StateToken, Resource<StatePayload>>();

export function stateResource(token: StateToken): Resource<StatePayload> {
  let resource = stateResources.get(token);
  if (resource === undefined) {
    resource = defineResource<StatePayload>(token.name);
    stateResources.set(token, resource);
  }
  return resource;
}
