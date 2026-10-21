import type { App } from '@forgeax/engine-app';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { querySubmittedTerrainHeight, type FrameReceipt } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { terrainReloadPolicy } from './reload-policy.ts';

/** Real dev fixture: observes the normal catalog, World writer and completed Renderer receipts. */
export function installTerrainHmrProbe(
  app: App,
  subjects: { terrain: EntityHandle; walker: EntityHandle },
  policy: ReturnType<typeof terrainReloadPolicy>,
) {
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  let latest: FrameReceipt | undefined;
  let latestAsset: number | undefined;
  let latestVersion: number | undefined;
  const events: unknown[] = [],
    failures: unknown[] = [];
  const state = () => {
    return {
      ...policy.sample(62, 62),
      gate: { ...policy.gate },
      walker: { ...app.world.getResource<{ speed: number; updates: number }>('TerrainWalker') },
      position: Array.from(app.world.get(subjects.walker, Transform).unwrap().pos),
      physics: app.world
        .getResource<PhysicsWorld>('PhysicsWorld')
        .getTerrainAssetVersion?.(subjects.terrain),
      frameId: latest?.frameId,
    };
  };
  const submitted = async () =>
    latest === undefined
      ? undefined
      : querySubmittedTerrainHeight(latest, {
          worldId: 0,
          entity: subjects.terrain,
          x: 62,
          z: 62,
          expectedAsset: policy.sample(62, 62).asset,
          expectedVersion: policy.sample(62, 62).version,
        });
  const stopRender = app.renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted' && event.receipt.presentation === 'ready') {
      const receipt = event.receipt;
      const {asset, version} = policy.sample(62, 62);
      void receipt.completed.then((result) => {
        if (result.ok && (latest === undefined || receipt.frameId > latest.frameId)) {
          latest = receipt;
          latestAsset = asset;
          latestVersion = version;
        }
      });
    }
  });
  const stopError = app.onError((error) => {
    if (error.code !== 'frame-submit-rejected') return;
    const rejected = state();
    const receipt = latest,
      asset = latestAsset,
      version = latestVersion;
    const previous =
      receipt === undefined
        ? Promise.resolve(undefined)
        : querySubmittedTerrainHeight(receipt, {
            worldId: 0,
            entity: subjects.terrain,
            x: 62,
            z: 62,
            ...(asset === undefined ? {} : { expectedAsset: asset }),
            ...(version === undefined ? {} : { expectedVersion: version }),
          });
    void previous.then((query) => events.push({ kind: 'submit-rejected', state: rejected, query }));
  });
  let rejectOnCatalog = false;
  const stopCatalog = app.assets?.subscribeCatalog((delta) => {
    events.push({ kind: 'catalog', delta, state: state() });
    if (rejectOnCatalog) {
      rejectOnCatalog = false;
      window.__terrainRejectNextSubmit = true;
    }
  });
  let blockedStart: ReturnType<typeof state> | undefined;
  const token = app.world.scheduleToken('Update'),
    name = 'terrain-hmr-writer-audit';
  app.world
    .addSystem(token, {
      name,
      queries: [],
      fn() {
        const current = state();
        if (current.gate.blocked) {
          if (
            blockedStart !== undefined &&
            (current.walker.updates !== blockedStart.walker.updates ||
              current.position.some((value, i) => value !== blockedStart?.position[i]))
          )
            failures.push({
              kind: 'writer-moved-while-blocked',
              before: blockedStart,
              after: current,
            });
          blockedStart = current;
        } else if (blockedStart !== undefined) {
          events.push({ kind: 'resumed', before: blockedStart, after: current });
          blockedStart = undefined;
        }
      },
    })
    .unwrap();
  window.__terrainHmrProbe = {
    state,
    submitted,
    events,
    failures,
    move() {
      app.world.getResource<{ speed: number }>('TerrainWalker').speed = 1;
    },
    retry() {
      policy.retry();
    },
    rejectOnCatalog() {
      rejectOnCatalog = true;
    },
  };
  return () => {
    stopRender();
    stopError();
    stopCatalog?.();
    app.world.removeSystem(token, name).unwrap();
    delete window.__terrainHmrProbe;
  };
}
declare global {
  interface Window {
    __terrainHmrProbe?: {
      state: () => unknown;
      submitted: () => Promise<unknown>;
      events: unknown[];
      failures: unknown[];
      move: () => void;
      retry: () => void;
      rejectOnCatalog: () => void;
    };
  }
}
