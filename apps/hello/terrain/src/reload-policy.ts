import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import type { SubmittedTerrainHeightRequest } from '@forgeax/engine-render';
import { GlobalTransform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import type { Result, TerrainAsset, TerrainError } from '@forgeax/engine-types';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { terrainGuid } from './identity.ts';

/** Scene-owned gameplay policy. Physics and rendering keep their ordinary frame authority. */
export function terrainReloadPolicy(
  world: World,
  assets: AssetRegistry,
  entity: EntityHandle,
  query: (
    request: SubmittedTerrainHeightRequest,
  ) => Promise<Result<number | undefined, TerrainError>>,
  subjectGuid = terrainGuid,
) {
  const gate = { blocked: true, replacements: 0, error: undefined as unknown };
  let active = true,
    pending: TerrainAsset | undefined,
    desired: TerrainAsset | undefined,
    checking = false;
  let loading: AbortController | undefined;
  const rootGuid = AssetGuid.format(subjectGuid);
  const dependencies = new Set<string>([rootGuid]);
  const remember = (root: TerrainAsset) => {
    dependencies.clear();
    dependencies.add(rootGuid);
    const queue = [
      ...root.grids,
      ...root.layers.flatMap((layer) =>
        layer.blend === 'height' ? [layer.material, layer.height] : [layer.material],
      ),
      ...root.sections.flatMap((section) => [
        section.heightTexture,
        section.weightTexture,
        section.material,
      ]),
    ];
    while (queue.length) {
      const guid = queue.pop();
      if (guid === undefined || dependencies.has(guid)) continue;
      dependencies.add(guid);
      for (const ref of assets.assetCatalog.get(guid)?.refs ?? []) queue.push(ref.guid);
    }
  };
  const reload = () => {
    gate.blocked = true;
    gate.error = undefined;
    pending = undefined;
    desired = undefined;
    loading?.abort();
    const request = new AbortController();
    loading = request;
    void assets
      .loadByGuid(subjectGuid)
      .then((result) => {
        if (!active || request.signal.aborted) return;
        if (!result.ok) {
          gate.error = result.error;
          return;
        }
        if (result.value.kind !== 'terrain') {
          gate.error = new Error('Terrain root kind changed');
          return;
        }
        pending = result.value;
      })
      .catch((error) => {
        if (active && !request.signal.aborted) gate.error = error;
      });
  };
  const initial = world.sharedRefs
    .resolve<'TerrainAsset', TerrainAsset>(world.get(entity, Terrain).unwrap().asset)
    .unwrap();
  remember(initial);
  desired = initial;
  const unsubscribe = assets.subscribeCatalog((delta) => {
    if (
      [...delta.added, ...delta.changed].some((row) => dependencies.has(row.guid)) ||
      delta.removed.some((guid) => dependencies.has(guid))
    )
      reload();
  });
  const name = `terrain-readiness:${Number(entity)}`,
    token = world.scheduleToken('Update');
  const collisionReady = (handle: number): boolean => {
    const publication = world
      .getResource<PhysicsWorld>('PhysicsWorld')
      .getDerivedPublication?.(entity);
    return (
      publication !== undefined &&
      publication.fixedStep > 0 &&
      publication.shapeIds.includes(`terrain:${handle}`)
    );
  };
  world
    .addSystem(token, {
      name,
      queries: [],
      fn() {
        if (pending !== undefined) {
          const candidate = pending;
          pending = undefined;
          if (assets.lookup(rootGuid) !== candidate) {
            gate.error = new Error('Terrain candidate is no longer canonical');
            return;
          }
          const current = world.get(entity, Terrain).unwrap();
          const handle = world.sharedRefs.acquire('TerrainAsset', candidate);
          try {
            world.set(entity, Terrain, { ...current, asset: handle }).unwrap();
          } finally {
            world.sharedRefs.release(handle).unwrap();
          }
          desired = candidate;
          remember(candidate);
          gate.replacements++;
        }
        if (!gate.blocked) return;
        if (checking || desired === undefined || gate.error !== undefined) return;
        const component = world.get(entity, Terrain).unwrap(),
          handle = Number(component.asset);
        if (!collisionReady(handle)) return;
        const target = desired,
          pos = world.get(entity, GlobalTransform).unwrap().world;
        checking = true;
        void query({
          worldId: 0,
          entity,
          x: (pos[12] ?? 0) + (target.columns - 1) * target.spacing * 0.5,
          z: (pos[14] ?? 0) + (target.rows - 1) * target.spacing * 0.5,
          expectedAsset: handle,
        })
          .then((result) => {
            if (
              active &&
              desired === target &&
              result.ok &&
              Number.isFinite(result.value) &&
              collisionReady(handle) &&
              Number(world.get(entity, Terrain).unwrap().asset) === handle
            )
              gate.blocked = false;
          })
          .catch((error) => {
            if (active && desired === target) gate.error = error;
          })
          .finally(() => {
            checking = false;
          });
      },
    })
    .unwrap();
  world.insertResource('TerrainGameplayGate', gate);
  return {
    gate,
    retry: reload,
    dispose() {
      active = false;
      loading?.abort();
      unsubscribe();
      world.removeSystem(token, name).unwrap();
    },
  };
}
