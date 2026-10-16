import { PickError, pick } from '@forgeax/engine/picking';
import { defineFeature } from '../../lab/feature';
import { makePickScene, VIEWPORT, worldFingerprint } from './_shared/pick-scene';

const CENTER = VIEWPORT / 2;

export default defineFeature({
  title: 'Screen-to-entity picking',
  catalog: 'Screen-to-entity picking',
  kind: 'headless',
  summary:
    'pick(world, camera, x, y, w, h) casts the camera ray and returns the nearest renderable AABB hit, for perspective and orthographic cameras.',
  expect:
    'Center pixel hits the near box (not the occluded far one), an empty pixel misses, the right-hand box is hit off-center, a non-camera entity throws PickError, and the World is unchanged.',
  run(checks) {
    const scene = makePickScene();
    const before = worldFingerprint(scene.world);
    const hit = pick(scene.world, scene.camera, CENTER, CENTER, VIEWPORT, VIEWPORT);
    checks.ok(
      'center hits the nearest box',
      hit?.entity === scene.near,
      `distance=${hit?.distance.toFixed(3)}`,
    );
    checks.ok(
      'distance from near-plane ray origin to front face is 3.4',
      hit !== undefined && Math.abs(hit.distance - 3.4) < 1e-3,
      String(hit?.distance),
    );
    checks.ok(
      'empty corner misses',
      pick(scene.world, scene.camera, 5, 5, VIEWPORT, VIEWPORT) === undefined,
    );
    const right = pick(scene.world, scene.camera, CENTER + 190, CENTER, VIEWPORT, VIEWPORT);
    checks.ok(
      'off-center pixel hits the side box',
      right?.entity === scene.side,
      String(right?.entity),
    );
    const ortho = makePickScene('orthographic');
    const orthoHit = pick(ortho.world, ortho.camera, CENTER, CENTER, VIEWPORT, VIEWPORT);
    checks.ok('orthographic camera hits the near box', orthoHit?.entity === ortho.near);
    let thrown: unknown;
    try {
      pick(scene.world, scene.near, CENTER, CENTER, VIEWPORT, VIEWPORT);
    } catch (error) {
      thrown = error;
    }
    checks.ok(
      'non-camera entity throws PickError camera-component-missing',
      thrown instanceof PickError && thrown.code === 'camera-component-missing',
      thrown instanceof Error ? thrown.message.slice(0, 80) : String(thrown),
    );
    checks.ok('World unchanged by queries', worldFingerprint(scene.world) === before);
  },
});
