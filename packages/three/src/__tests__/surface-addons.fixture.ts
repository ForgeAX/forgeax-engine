import * as THREE from '@forgeax/engine/three';
import { NURBSSurface } from '@forgeax/engine/three/addons/curves/NURBSSurface.js';
import { LoftGeometry } from '@forgeax/engine/three/addons/geometries/LoftGeometry.js';
import { ParametricGeometry } from '@forgeax/engine/three/addons/geometries/ParametricGeometry.js';
import {
  ConvexObjectBreaker,
  type CutByPlaneOutput,
} from '@forgeax/engine/three/addons/misc/ConvexObjectBreaker.js';
export function loftGeometry() {
  const sections = [-0.5, 0.5].map((z) => [
    new THREE.Vector3(-0.5, -0.5, z),
    new THREE.Vector3(0.5, -0.5, z),
    new THREE.Vector3(0.5, 0.5, z),
    new THREE.Vector3(-0.5, 0.5, z),
  ]);
  return new LoftGeometry(sections, { capStart: true, capEnd: true });
}
export function nurbsGeometry() {
  const surface = new NURBSSurface(
    1,
    1,
    [0, 0, 1, 1],
    [0, 0, 1, 1],
    [
      [new THREE.Vector4(-0.5, -0.5, 0, 1), new THREE.Vector4(-0.5, 0.5, 0, 1)],
      [new THREE.Vector4(0.5, -0.5, 0, 1), new THREE.Vector4(0.5, 0.5, 0.25, 1)],
    ],
  );
  return new ParametricGeometry((u, v, out) => surface.getPoint(u, v, out), 8, 8);
}
export function brokenBox() {
  const geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.Mesh(geometry, material),
    breaker = new ConvexObjectBreaker();
  breaker.prepareBreakableObject(mesh, 1, new THREE.Vector3(), new THREE.Vector3(), true);
  mesh.updateMatrixWorld();
  const output: CutByPlaneOutput = { object1: null, object2: null };
  try {
    if (breaker.cutByPlane(mesh, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), output) !== 2)
      throw Error('convex split failed');
    if (!(output.object1 instanceof THREE.Mesh) || !(output.object2 instanceof THREE.Mesh))
      throw Error('missing fragments');
    return { left: output.object1, right: output.object2, material };
  } finally {
    geometry.dispose();
  }
}
