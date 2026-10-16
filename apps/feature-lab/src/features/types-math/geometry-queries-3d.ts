import { box3, frustum, mat4, ray, sphere, vec2 } from '@forgeax/engine/math';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: '3D geometry queries',
  catalog: '3D geometry queries',
  kind: 'headless',
  summary:
    'Pure ray/AABB/triangle/sphere/frustum primitives plus screenToRay and worldToScreen, all allocation-explicit.',
  expect:
    'All checks pass: hits and misses, entry distances, barycentrics, and frustum culling match hand-computed values.',
  run(checks) {
    const unit = box3.create(-1, -1, -1, 1, 1, 1);
    const r = ray.create(undefined, [0, 0, 5], [0, 0, -1]);
    const hit = ray.rayAabbIntersects(r, unit);
    checks.ok('ray hits unit box', hit.hit);
    checks.near('entry distance 4', hit.tmin, 4);
    checks.ok(
      'parallel offset ray misses',
      !ray.rayAabbIntersects(ray.create(undefined, [3, 0, 5], [0, 0, -1]), unit).hit,
    );

    const tri = ray.rayTriangleIntersects(r, [-1, -1, 0], [1, -1, 0], [0, 1, 0]);
    checks.ok('ray hits triangle', tri.hit);
    checks.near('triangle t = 5', tri.t, 5);
    checks.ok(
      'barycentrics inside',
      tri.u >= 0 && tri.v >= 0 && tri.u + tri.v <= 1,
      `u=${tri.u} v=${tri.v}`,
    );

    const grown = box3.create();
    box3.expandByPoint(grown, [2, 3, 4]);
    box3.expandByPoint(grown, [-1, 0, 1]);
    checks.equal('expandByPoint from empty box', Array.from(grown), [-1, 0, 1, 2, 3, 4]);
    checks.ok('containsPoint inside', box3.containsPoint(unit, [0.5, 0.5, 0.5]));
    checks.ok('containsPoint outside', !box3.containsPoint(unit, [1.5, 0, 0]));
    checks.ok('box-box overlap', box3.intersectsBox(unit, box3.create(0.5, 0.5, 0.5, 2, 2, 2)));

    const s = sphere.create(0, 0, 0, 1);
    checks.ok('sphere contains origin', sphere.containsPoint(s, [0, 0, 0]));
    checks.ok('sphere misses far box', !sphere.intersectsBox(s, box3.create(3, 3, 3, 4, 4, 4)));

    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 50);
    const view = mat4.lookAt(mat4.create(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), proj, view);
    const f = frustum.fromViewProjection(frustum.create(), vp);
    checks.ok('frustum sees unit box at origin', frustum.intersectsBox(f, unit));
    checks.ok(
      'frustum culls box behind camera',
      !frustum.intersectsBox(f, box3.create(-1, -1, 9, 1, 1, 11)),
    );
    checks.ok('frustum culls sphere far left', !frustum.intersectsSphere(f, [-100, 0, 0], 1));

    const center = ray.screenToRay(ray.create(), 50, 50, 100, 100, view, proj, 'perspective');
    checks.near('center pixel ray points -Z', center[5] as number, -1, 1e-4);
    const screen = vec2.create();
    const projected = ray.worldToScreen(screen, [0, 0, 0], vp, 100, 100);
    checks.ok('origin projects on screen', projected.onScreen && !projected.behind);
    checks.near('origin projects to canvas center x', screen[0] as number, 50, 1e-3);
    checks.near('origin projects to canvas center y', screen[1] as number, 50, 1e-3);
  },
});
