import { Update, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { CAMERA_PROJECTION_PERSPECTIVE, Camera } from '@forgeax/engine-render';
import type { CanvasDrawingBufferSize } from './types';

/** Apply the host's current physical canvas extent through the World's Update lifecycle. */
export function canvasAspectPlugin(readSize: () => CanvasDrawingBufferSize): Plugin {
  return {
    name: 'canvas-aspect',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => {
        const system = {
          name: 'app-sync-camera-aspect',
          queries: [],
          fn: () => {
            const { width, height } = readSize();
            syncCameraAspect(ctx.world, width, height);
          },
        };
        ctx.world.addSystem(Update, system).unwrap();
        return () => ctx.world.removeSystem(Update, system.name).unwrap();
      }, 'app/canvas-aspect');
    },
  };
}

/** Keep host-owned perspective camera aspect policy in one execution-tier seam. */
export function syncCameraAspect(world: World, canvasW: number, canvasH: number): void {
  if (canvasW <= 0 || canvasH <= 0) return;
  const aspect = canvasW / canvasH;
  const query = world.query({ with: [Camera] }).unwrap();
  for (const row of query) {
    const camera = world.get(row.entity, Camera);
    if (!camera.ok) continue;
    if (camera.value.autoAspect !== true) continue;
    if (camera.value.projection !== CAMERA_PROJECTION_PERSPECTIVE) continue;
    if (camera.value.aspect === Math.fround(aspect)) continue;
    world.set(row.entity, Camera, { aspect });
  }
}
