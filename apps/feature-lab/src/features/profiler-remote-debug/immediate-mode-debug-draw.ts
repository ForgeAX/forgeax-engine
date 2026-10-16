import { Update } from '@forgeax/engine/ecs';
import { mat4, vec3 } from '@forgeax/engine/math';
import { defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';

export default defineFeature({
  title: 'Immediate-mode debug draw',
  catalog: 'Immediate-mode Debug Draw',
  kind: 'visual',
  summary:
    'app.debugDraw stages line/sphere/aabb/frustum/arrow/axes wireframes every frame from an Update system; nothing is spawned in the World.',
  expect:
    'ON: red ground grid, green sphere, blue box, yellow arrow, and RGB axes over black. OFF: the system stops staging and the overlay is empty on the very next frame.',
  setup({ app, world }) {
    spawnCamera(world, { eye: [0, 2.2, 5], target: [0, 0.4, 0] });
    const draw = app.debugDraw;
    let enabled = true;
    const origin = mat4.create();
    world
      .addSystem(Update, {
        name: 'feature-lab-debug-draw',
        queries: [],
        fn: () => {
          if (!enabled || draw === undefined) return;
          for (let i = -4; i <= 4; i++) {
            draw.line(vec3.create(-4, 0, i * 0.5), vec3.create(4, 0, i * 0.5), [1, 0, 0, 1]);
            draw.line(vec3.create(i, 0, -2), vec3.create(i, 0, 2), [1, 0, 0, 1]);
          }
          draw.sphere(vec3.create(-1.4, 0.8, 0), 0.7, [0, 1, 0, 1], 24);
          draw.aabb(vec3.create(0.6, 0, -0.5), vec3.create(1.8, 1.2, 0.5), [0, 0.4, 1, 1]);
          draw.arrow(vec3.create(0, 0, 1), vec3.create(0, 2, 1), [1, 1, 0, 1], 0.3);
          draw.axes(origin, 1.5);
        },
      })
      .unwrap();
    return {
      toggle(on) {
        enabled = on;
      },
      checks: () => [{ name: 'app.debugDraw attached (canvas createApp)', ok: draw !== undefined }],
    };
  },
});
