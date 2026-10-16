import { mat4 } from '@forgeax/engine/math';
import { defineFeature } from '../../lab/feature';

const NEAR = 0.1;
const FAR = 1e8;

function depthAt(matrix: ArrayLike<number>, distance: number): number {
  return Math.fround((-(matrix[10] ?? 0) * distance + (matrix[14] ?? 0)) / distance);
}

export default defineFeature({
  title: 'Reverse-Z depth',
  catalog: 'Reverse-Z depth',
  kind: 'headless',
  summary:
    'Every Camera projection is Reverse-Z: near maps to depth 1, far and the depth clear to 0, and scene passes test with greater. Float32 precision then concentrates at distance.',
  expect:
    'All checks pass: near/far map to 1/0, perspective and orthographic reconstruction formulas recover distance, and surfaces at 100 km and 100 km + 1 m stay distinct only under Reverse-Z.',
  run(checks) {
    const reverse = mat4.perspectiveReverseZ(mat4.create(), 1, 1, NEAR, FAR);
    const forward = mat4.perspective(mat4.create(), 1, 1, NEAR, FAR);
    checks
      .near('perspective near maps to 1', depthAt(reverse, NEAR), 1, 1e-6)
      .near('perspective far maps to 0', depthAt(reverse, FAR), 0, 1e-6);
    const d = depthAt(reverse, 25);
    checks.near('perspective reconstruction', NEAR / (d + ((1 - d) * NEAR) / FAR), 25, 1e-3);
    const ortho = mat4.orthographicReverseZ(mat4.create(), -1, 1, 1, -1, 1, 11);
    const orthoDepth = (distance: number) => -(ortho[10] ?? 0) * distance + (ortho[14] ?? 0);
    checks
      .near('orthographic near maps to 1', orthoDepth(1), 1, 1e-6)
      .near('orthographic far maps to 0', orthoDepth(11), 0, 1e-6)
      .near('orthographic reconstruction', 11 - orthoDepth(4) * (11 - 1), 4, 1e-5);
    checks
      .ok(
        'forward-Z collapses 100 km vs 100 km + 1 m',
        depthAt(forward, 100000) === depthAt(forward, 100001),
        `${depthAt(forward, 100000)} vs ${depthAt(forward, 100001)}`,
      )
      .ok(
        'reverse-Z keeps them ordered (greater = nearer)',
        depthAt(reverse, 100000) > depthAt(reverse, 100001),
        `${depthAt(reverse, 100000)} vs ${depthAt(reverse, 100001)}`,
      );
    const infinite = mat4.perspectiveReverseZ(mat4.create(), 1, 1, NEAR, Number.POSITIVE_INFINITY);
    checks.equal('infinite far keeps m[10] = 0', infinite[10], 0);
  },
});
