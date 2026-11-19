import * as THREE from '@forgeax/engine/three';

/** One ordinary map plus an independent, build-only alpha-test expression. */
export function targetSurfaceExample() {
  const map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const material = new THREE.MeshBasicNodeMaterial({ map });
  const threshold = THREE.TSL.uniform(0);
  material.alphaTestNode = threshold.mul(0.5).add(0.1);
  return { material, threshold, map };
}
