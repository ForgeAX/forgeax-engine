import { type World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { Camera } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { quat } from '@forgeax/engine-math';

/**
 * Build a minimal scene with a camera. The Bevy `empty` example is literally
 * `App::new().run()` — but forgeax's createApp needs a canvas with at least
 * a camera to render anything (clear color). This is the thinnest valid scene.
 */
export function buildEmptyWorld(world: World): void {
  const eye: [number, number, number] = [-2, 2.5, 5];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );
}
