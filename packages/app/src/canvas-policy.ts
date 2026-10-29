import type { EntityHandle } from '@forgeax/engine-ecs';
import { Update, type World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import type { Plugin } from '@forgeax/engine-plugin';
import { CAMERA_PROJECTION_PERSPECTIVE, Camera } from '@forgeax/engine-render';
import type { CanvasDrawingBufferSize } from './types';

/** Apply the host's current physical canvas extent through the World's Update lifecycle. */
export function canvasAspectPlugin(readSize: () => CanvasDrawingBufferSize): Plugin {
  return {
    name: 'canvas-aspect',
    inject: ['world'],
    apply(ctx) {
      const world = ctx.world;
      ctx.effect(() => {
        const system = {
          name: 'app-sync-camera-aspect',
          queries: [],
          fn: () => {
            const { width, height } = readSize();
            syncCameraAspect(world, width, height);
          },
        };
        world.addSystem(Update, system).unwrap();
        return () => world.removeSystem(Update, system.name).unwrap();
      }, 'app/canvas-aspect');
    },
  };
}

/** Keep host-owned perspective camera aspect policy in one execution-tier seam. */
export function syncCameraAspect(world: World, canvasW: number, canvasH: number): void {
  if (canvasW <= 0 || canvasH <= 0) return;
  const aspect = canvasW / canvasH;
  const query = world.query({ with: [Camera] }).unwrap();
  for (const querySpan of query.spans().unwrap()) {
    const queryEntities = querySpan.entities;
    for (let queryIndex = 0; queryIndex < querySpan.length; queryIndex++) {
      const queriedEntity = queryEntities[queryIndex] as EntityHandle;

      const camera = world[worldRead];
      if (camera.getFieldValue(queriedEntity, Camera, 'autoAspect') !== 1) continue;
      if (
        camera.getFieldValue(queriedEntity, Camera, 'projection') !== CAMERA_PROJECTION_PERSPECTIVE
      )
        continue;
      if (camera.getFieldValue(queriedEntity, Camera, 'aspect') === Math.fround(aspect)) continue;
      world.set(queriedEntity, Camera, { aspect });
    }
  }
}
