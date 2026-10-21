import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/source';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import type { SubmittedTerrainHeightRequest } from '@forgeax/engine-render';
import { GlobalTransform } from '@forgeax/engine-scene';
import { Terrain, terrainHeight } from '@forgeax/engine-terrain';
import type { Result, TerrainAsset, TerrainError } from '@forgeax/engine-types';
import { terrainGuid } from './identity.ts';

/** Gameplay waits for the same asset version in collision and a completed rendered frame. */
export function terrainReloadPolicy(
  world: World,
  assets: AssetRegistry,
  entity: EntityHandle,
  query: (request: SubmittedTerrainHeightRequest) => Promise<Result<number | undefined, TerrainError>>,
  subjectGuid = terrainGuid,
) {
  const handle = world.get(entity, Terrain).unwrap().asset;
  const rootGuid = AssetGuid.format(subjectGuid);
  if (assets.source(handle).unwrap()?.guid !== rootGuid)
    throw new Error('Terrain must retain the selected source root');
  const gate = { blocked: true, replacements: 0, error: undefined as unknown };
  const observer = assets.observe().unwrap();
  let target = assets.snapshot(handle).unwrap();
  let version = target.version(handle).unwrap();
  let desired = target.read<TerrainAsset>(handle).unwrap();
  let active = true;
  let checking = false;
  let loading: AbortController | undefined;
  const capture = () => {
    const next = assets.snapshot(handle).unwrap();
    const nextVersion = next.version(handle).unwrap();
    if (nextVersion === version) { next.dispose(); return; }
    target.dispose();
    target = next;
    version = nextVersion;
    desired = target.read<TerrainAsset>(handle).unwrap();
    gate.blocked = true;
    gate.replacements++;
  };
  const reload = () => {
    gate.blocked = true;
    gate.error = undefined;
    loading?.abort();
    const request = new AbortController();
    loading = request;
    void assets.reload(handle, { conflict: 'reject', signal: request.signal }).then(result => {
      if (!active || loading !== request) return;
      loading = undefined;
      if (!result.ok) { gate.error = result.error; return; }
      capture();
    }).catch(error => {
      if (active && loading === request) { loading = undefined; gate.error = error; }
    });
  };
  // The source producer publishes the complete Terrain closure. Explicit reload adopts it.
  const unsubscribe = assets.subscribeCatalog(delta => {
    if (delta.added.some(row => row.guid === rootGuid) || delta.changed.some(row => row.guid === rootGuid) || delta.removed.includes(rootGuid)) reload();
  });
  const collisionReady = (expectedVersion: number) => {
    const adopted = world.getResource<PhysicsWorld>('PhysicsWorld').getTerrainAssetVersion?.(entity);
    return adopted?.asset === Number(handle) && adopted.version === expectedVersion;
  };
  const token = world.scheduleToken('Update');
  const name = `terrain-readiness:${Number(entity)}`;
  world.addSystem(token, {
    name,
    queries: [],
    fn() {
      const batch = observer.read().unwrap();
      if (batch.changes.some(change => change.handle === handle)) capture();
      batch.accept();
      if (!gate.blocked || checking || loading !== undefined || gate.error !== undefined || !collisionReady(version)) return;
      const expectedVersion = version;
      const position = world.get(entity, GlobalTransform).unwrap().world;
      checking = true;
      void query({
        worldId: 0,
        entity,
        x: (position[12] ?? 0) + (desired.columns - 1) * desired.spacing * 0.5,
        z: (position[14] ?? 0) + (desired.rows - 1) * desired.spacing * 0.5,
        expectedAsset: Number(handle),
        expectedVersion,
      }).then(result => {
        if (active && loading === undefined && expectedVersion === version && result.ok && Number.isFinite(result.value) && collisionReady(version)) gate.blocked = false;
      }).catch(error => {
        if (active && expectedVersion === version) gate.error = error;
      }).finally(() => { checking = false; });
    },
  }).unwrap();
  world.insertResource('TerrainGameplayGate', gate);
  return {
    gate,
    sample: (x: number, z: number) => ({ asset: Number(handle), version, height: terrainHeight(desired, x, z) }),
    retry: reload,
    dispose() {
      active = false;
      loading?.abort();
      unsubscribe();
      observer.dispose();
      target.dispose();
      world.removeSystem(token, name).unwrap();
    },
  };
}
