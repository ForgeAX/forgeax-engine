import { mat4, quat, vec3 } from '@forgeax/engine/math';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Out-parameter math',
  catalog: 'Out-param math',
  kind: 'headless',
  summary:
    'vec3 / quat / mat4 functions write into a caller-owned out array and return it, so hot loops allocate nothing.',
  expect:
    'All checks pass: out is returned by identity, a 90-degree Y rotation maps +X to -Z, and a TRS matrix round-trips its translation.',
  run(checks) {
    const out = vec3.create();
    const returned = vec3.add(out, [1, 2, 3], [4, 5, 6]);
    checks.ok('add returns the same out array', returned === out);
    checks.equal('add result', Array.from(out), [5, 7, 9]);

    const q = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2);
    const rotated = quat.transformVec3(vec3.create(), q, [1, 0, 0]);
    checks.near('rotate +X about Y: x', rotated[0] as number, 0);
    checks.near('rotate +X about Y: z', rotated[2] as number, -1);

    const m = mat4.compose(mat4.create(), [3, 4, 5], q, [2, 2, 2]);
    checks.equal('TRS translation column', [m[12], m[13], m[14]], [3, 4, 5]);
    checks.ok('Float32Array storage', m instanceof Float32Array);
  },
});
