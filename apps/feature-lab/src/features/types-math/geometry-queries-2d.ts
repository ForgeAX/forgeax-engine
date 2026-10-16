import { box2, circle2, ray2, vec2 } from '@forgeax/engine/math';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: '2D geometry queries',
  catalog: '2D geometry queries',
  kind: 'headless',
  summary:
    'box2, circle2 and ray2 give pure 2D overlap, containment, raycast and shape-cast primitives that physics/picking reuse.',
  expect:
    'All checks pass: entry distances, max-distance clipping, and box/circle overlaps match hand-computed values.',
  run(checks) {
    const box = box2.create(-1, -1, 1, 1);
    const circle = circle2.create(3, 0, 1);
    checks.ok('box contains origin', box2.containsPoint(box, [0, 0]));
    checks.ok('box excludes (2,0)', !box2.containsPoint(box, [2, 0]));
    checks.ok('box-box overlap', box2.intersectsBox(box, box2.create(0.5, 0.5, 3, 3)));
    checks.ok('box-circle separated', !box2.intersectsCircle(box, circle));
    checks.ok('box-circle touching', box2.intersectsCircle(box, circle2.create(1.5, 0, 0.6)));
    checks.ok('circle-circle overlap', circle2.intersectsCircle(circle, circle2.create(4.5, 0, 1)));
    const centered = box2.fromCenter(box2.create(), [10, 10], [2, 1]);
    checks.equal('fromCenter extents', Array.from(centered), [8, 9, 12, 11]);

    const r = ray2.create(undefined, [-5, 0], [1, 0]);
    const toBox = ray2.rayAabbIntersects(r, box);
    checks.ok('ray hits box', toBox.hit);
    checks.near('ray-box entry t = 4', toBox.t, 4);
    const toCircle = ray2.rayCircleIntersects(r, circle);
    checks.ok('ray hits circle', toCircle.hit);
    checks.near('ray-circle entry t = 7', toCircle.t, 7);
    const short = ray2.create(undefined, [-5, 0], [1, 0], 3);
    checks.ok('max distance clips the hit', !ray2.rayAabbIntersects(short, box).hit);
    const diagonal = ray2.create(undefined, [0, 0], [3, 4]);
    checks.near(
      'direction is normalized',
      ray2.getDirection(vec2.create(), diagonal)[0] as number,
      0.6,
      1e-6,
    );
  },
});
