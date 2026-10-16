import type { EntityHandle } from '@forgeax/engine-ecs';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import type { LoadedScene } from './scene-runtime';

export type SentinelAvailabilityCode =
  | 'authored-sentinel-missing'
  | 'authored-sentinel-duplicate'
  | 'authored-cover-missing'
  | 'authored-cover-duplicate'
  | 'authored-local-id-mismatch'
  | 'physics-unavailable';

export type AuthoredSentinelIdentity = {
  readonly sentinel: EntityHandle;
  readonly sentinelLocalId: 35;
  readonly covers: readonly [
    { readonly entity: EntityHandle; readonly localId: 36 },
    { readonly entity: EntityHandle; readonly localId: 37 },
  ];
};

export type SentinelIdentityResolution =
  | { readonly available: true; readonly identity: AuthoredSentinelIdentity; readonly unavailableReason: null }
  | { readonly available: false; readonly identity: null; readonly unavailableReason: { readonly code: SentinelAvailabilityCode; readonly detail: string } };

export type SentinelAvailabilityProjection =
  | { readonly available: true; readonly unavailableReason: null }
  | { readonly available: false; readonly unavailableReason: { readonly code: SentinelAvailabilityCode; readonly detail: string } };

export type SentinelEncounterReadiness = SentinelAvailabilityProjection & {
  readonly sentinelBodyReady: boolean;
  readonly coverBodiesReady: readonly [boolean, boolean];
};

export function projectSentinelAvailability(
  identity: SentinelIdentityResolution,
  readiness: { readonly sentinel: boolean; readonly covers: readonly [boolean, boolean] },
): SentinelAvailabilityProjection {
  if (!identity.available) return { available: false, unavailableReason: identity.unavailableReason };
  if (!readiness.sentinel || !readiness.covers[0] || !readiness.covers[1]) {
    return {
      available: false,
      unavailableReason: {
        code: 'physics-unavailable',
        detail: `Physics bodies ready: sentinel=${readiness.sentinel}, covers=${readiness.covers[0]}/${readiness.covers[1]}`,
      },
    };
  }
  return { available: true, unavailableReason: null };
}

/** Derive the one live readiness fact consumed by cadence and inspection. */
export function readSentinelEncounterReadiness(
  identity: SentinelIdentityResolution,
  physics: PhysicsWorld | undefined,
): SentinelEncounterReadiness {
  const sentinelBodyReady = identity.available && physics?.hasBody(identity.identity.sentinel) === true;
  const coverBodiesReady: readonly [boolean, boolean] = identity.available
    ? [
        physics?.hasBody(identity.identity.covers[0].entity) === true,
        physics?.hasBody(identity.identity.covers[1].entity) === true,
      ]
    : [false, false];
  return {
    ...projectSentinelAvailability(identity, {
      sentinel: sentinelBodyReady,
      covers: coverBodiesReady,
    }),
    sentinelBodyReady,
    coverBodiesReady,
  };
}

export function resolveAuthoredSentinelIdentity(loaded: LoadedScene): SentinelIdentityResolution {
  const named = (name: string) => loaded.nodes.filter(
    (node) => (node.components.Name as { value?: string } | undefined)?.value === name,
  );
  const sentinel = named('Sentinel');
  if (sentinel.length === 0) return { available: false, identity: null, unavailableReason: { code: 'authored-sentinel-missing', detail: 'SceneAsset has no Name=Sentinel node' } };
  if (sentinel.length !== 1) return { available: false, identity: null, unavailableReason: { code: 'authored-sentinel-duplicate', detail: `SceneAsset has ${sentinel.length} Name=Sentinel nodes` } };
  const left = named('ProjectileCoverLeft');
  const right = named('ProjectileCoverRight');
  if (left.length === 0 || right.length === 0) return { available: false, identity: null, unavailableReason: { code: 'authored-cover-missing', detail: `SceneAsset cover counts are left=${left.length}, right=${right.length}` } };
  if (left.length !== 1 || right.length !== 1) return { available: false, identity: null, unavailableReason: { code: 'authored-cover-duplicate', detail: `SceneAsset cover counts are left=${left.length}, right=${right.length}` } };
  const sentinelNode = sentinel[0]!;
  const leftNode = left[0]!;
  const rightNode = right[0]!;
  if (sentinelNode.localId !== 35 || leftNode.localId !== 36 || rightNode.localId !== 37) {
    return { available: false, identity: null, unavailableReason: { code: 'authored-local-id-mismatch', detail: `Expected Sentinel/cover localIds 35/36/37, received ${sentinelNode.localId}/${leftNode.localId}/${rightNode.localId}` } };
  }
  const sentinelEntity = loaded.mapping.get(35);
  const leftEntity = loaded.mapping.get(36);
  const rightEntity = loaded.mapping.get(37);
  if (sentinelEntity === undefined || leftEntity === undefined || rightEntity === undefined) {
    return { available: false, identity: null, unavailableReason: { code: 'authored-sentinel-missing', detail: 'SceneAsset mapping is missing one authored Sentinel encounter entity' } };
  }
  return {
    available: true,
    identity: {
      sentinel: sentinelEntity,
      sentinelLocalId: 35,
      covers: [{ entity: leftEntity, localId: 36 }, { entity: rightEntity, localId: 37 }],
    },
    unavailableReason: null,
  };
}
