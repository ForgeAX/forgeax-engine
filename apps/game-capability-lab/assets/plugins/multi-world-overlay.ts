import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type App } from '@forgeax/engine-app';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import type { AssetHandle } from '@forgeax/engine-types';
import type { Context } from '@forgeax/engine-plugin';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();


export interface MultiWorldOverlaySnapshot {
  readonly enabled: boolean;
  readonly worldCount: number;
  readonly entityCount: number;
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}

export interface MultiWorldOverlay {
  readonly world: World;
  readonly snapshot: () => MultiWorldOverlaySnapshot;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

function spawnBeacon(
  world: World,
  assets: AssetRegistry,
  mesh: AssetHandle<'mesh'>,
  position: readonly [number, number, number],
  color: readonly [number, number, number, number],
): EntityHandle {
  const material = assets.create(Materials.standard({
      baseColor: color,
      metallic: 0,
      roughness: 0.35,
      emissive: [color[0], color[1], color[2]],
      emissiveIntensity: 0.15,
    })).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: { pos: position, scale: [0.45, 0.45, 0.45] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  assets.release(material).unwrap();
  return entity;
}

/**
 * Add a small secondary World whose geometry borrows the primary world's
 * camera and light. The App owns the one frame loop; draw-source routing keeps
 * this composition explicit and updates the secondary World before drawing.
 */
export function installMultiWorldOverlay(
  context: Context,
  app: App,
): MultiWorldOverlay {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const mesh = assets.create(BUILTIN_CUBE).unwrap();
  const beacons = [
    spawnBeacon(world, assets, mesh, [-6, 0.45, -1], [0.1, 0.85, 1, 1]),
    spawnBeacon(world, assets, mesh, [-6, 1.35, -1], [1, 0.25, 0.65, 1]),
  ];

  assets.release(mesh).unwrap();
  let enabled = true;
  let disposed = false;
  const snapshot = (): MultiWorldOverlaySnapshot => ({
    enabled,
    worldCount: enabled ? 2 : 1,
    entityCount: 2,
    cameraOwner: 0,
    resourceOwner: 0,
  });
  const applyRouting = (): void => {
    app.setDrawSource(
      enabled
        ? () => ({ worlds: [app.world, world], cameraOwner: 0, resourceOwner: 0 })
        : undefined,
    );
  };
  const setEnabled = (nextEnabled: boolean): void => {
    if (disposed || enabled === nextEnabled) return;
    enabled = nextEnabled;
    applyRouting();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    app.setDrawSource(undefined);
    for (const entity of beacons) world.despawn(entity).unwrap();
    assets.dispose();
  };

  applyRouting();
  context.effect(() => dispose, 'game-default/multi-world-overlay');
  return { world, snapshot, setEnabled, dispose };
}
