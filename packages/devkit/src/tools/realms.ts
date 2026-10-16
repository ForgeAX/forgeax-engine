import type { ToolRealm } from '@forgeax/engine-tool-runtime';
import {
  createRealmCapabilityMatrix as createRuntimeRealmCapabilityMatrix,
  type RealmCapability,
  type RealmCapabilityInput,
  type RealmCapabilityMatrix,
} from '@forgeax/engine-tool-runtime';

export type { RealmCapability, RealmCapabilityInput, RealmCapabilityMatrix };
export { createRuntimeRealmCapabilityMatrix as createRealmCapabilityMatrix };

export function resolveRealmCapability(
  matrix: RealmCapabilityMatrix,
  realm: ToolRealm,
): RealmCapability {
  return matrix.realms[realm];
}

const RESOURCE_KINDS = ['process', 'port', 'page', 'canvas', 'fiber'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceProbe {
  readonly observe: (kind: ResourceKind, id: string) => void;
  readonly release: (kind: ResourceKind, id: string) => void;
  readonly owner: (id: string) => ResourceOwner;
  readonly snapshot: () => Readonly<Record<ResourceKind, readonly string[]>>;
}

export interface ResourceOwner {
  readonly id: string;
  readonly observe: (kind: ResourceKind, resourceId: string) => void;
  readonly release: (kind: ResourceKind, resourceId: string) => void;
  readonly stop: () => void;
}

export function createResourceProbe(): ResourceProbe {
  const live = new Map<ResourceKind, Set<string>>(RESOURCE_KINDS.map((kind) => [kind, new Set()]));
  const owned = new Map<string, Set<string>>();
  const key = (kind: ResourceKind, id: string): string => `${kind}:${id}`;
  const releaseOwned = (ownerId: string, kind: ResourceKind, id: string): void => {
    live.get(kind)?.delete(id);
    owned.get(ownerId)?.delete(key(kind, id));
  };
  return {
    observe(kind, id) {
      live.get(kind)?.add(id);
    },
    release(kind, id) {
      live.get(kind)?.delete(id);
    },
    owner(id) {
      if (owned.has(id)) throw new Error(`resource-owner-duplicate:${id}`);
      owned.set(id, new Set());
      let stopped = false;
      return {
        id,
        observe(kind, resourceId) {
          if (stopped) throw new Error(`resource-owner-stopped:${id}`);
          live.get(kind)?.add(resourceId);
          owned.get(id)?.add(key(kind, resourceId));
        },
        release(kind, resourceId) {
          releaseOwned(id, kind, resourceId);
        },
        stop() {
          if (stopped) return;
          stopped = true;
          for (const resource of owned.get(id) ?? []) {
            const separator = resource.indexOf(':');
            const kind = resource.slice(0, separator) as ResourceKind;
            const resourceId = resource.slice(separator + 1);
            live.get(kind)?.delete(resourceId);
          }
          owned.delete(id);
        },
      };
    },
    snapshot() {
      return Object.fromEntries(
        [...live.entries()].map(([kind, ids]) => [kind, [...ids].sort()]),
      ) as unknown as Readonly<Record<ResourceKind, readonly string[]>>;
    },
  };
}

export {
  createResourceBootstrapPlan,
  createResourceBootstrapTrace,
  type ResourceBootstrapPlan,
  type ResourceBootstrapTrace,
  type ResourceBootstrapTraceInput,
} from '../host/resource-bootstrap.js';
