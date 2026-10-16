import { mat4 } from '@forgeax/engine/math';
import { defineFeature } from '../../lab/feature';

type Mat = Float32Array;

function ndcDepth(m: Mat, viewZ: number): number {
  const z = (m[8] as number) * 0 + (m[10] as number) * viewZ + (m[14] as number);
  const w = (m[11] as number) * viewZ + (m[15] as number);
  return z / w;
}

export default defineFeature({
  title: 'Projection families',
  catalog: 'WebGPU/WebGL/Reverse-Z projections',
  kind: 'headless',
  summary:
    'perspective / perspectiveNO / perspectiveReverseZ (and orthographic variants) are explicit depth contracts: [0,1], [-1,1], and reversed [1,0].',
  expect: 'All checks pass: near/far planes land on the NDC depth each contract promises.',
  run(checks) {
    const near = 0.5;
    const far = 100;
    const fov = Math.PI / 3;
    const zo = mat4.perspective(mat4.create(), fov, 1, near, far);
    checks.near('WebGPU perspective near -> 0', ndcDepth(zo, -near), 0, 1e-5);
    checks.near('WebGPU perspective far -> 1', ndcDepth(zo, -far), 1, 1e-5);
    const no = mat4.perspectiveNO(mat4.create(), fov, 1, near, far);
    checks.near('WebGL perspective near -> -1', ndcDepth(no, -near), -1, 1e-5);
    checks.near('WebGL perspective far -> 1', ndcDepth(no, -far), 1, 1e-4);
    const rz = mat4.perspectiveReverseZ(mat4.create(), fov, 1, near, far);
    checks.near('Reverse-Z near -> 1', ndcDepth(rz, -near), 1, 1e-5);
    checks.near('Reverse-Z far -> 0', ndcDepth(rz, -far), 0, 1e-5);
    const rzInf = mat4.perspectiveReverseZ(mat4.create(), fov, 1, near, Number.POSITIVE_INFINITY);
    checks.near('Reverse-Z infinite far keeps near at 1', ndcDepth(rzInf, -near), 1, 1e-5);
    checks.ok('Reverse-Z infinite far is finite', Number.isFinite(rzInf[14] as number));
    checks.near('same x focal scale across families', zo[0] as number, no[0] as number, 1e-6);

    const oz = mat4.orthographic(mat4.create(), -1, 1, 1, -1, near, far);
    checks.near('WebGPU ortho near -> 0', ndcDepth(oz, -near), 0, 1e-5);
    checks.near('WebGPU ortho far -> 1', ndcDepth(oz, -far), 1, 1e-5);
    const on = mat4.orthographicNO(mat4.create(), -1, 1, 1, -1, near, far);
    checks.near('WebGL ortho near -> -1', ndcDepth(on, -near), -1, 1e-5);
    const orz = mat4.orthographicReverseZ(mat4.create(), -1, 1, 1, -1, near, far);
    checks.near('Reverse-Z ortho near -> 1', ndcDepth(orz, -near), 1, 1e-5);
    checks.near('Reverse-Z ortho far -> 0', ndcDepth(orz, -far), 0, 1e-5);
  },
});
