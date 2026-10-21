import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createPrimitiveMesh,
  createSphereGeometry,
  createTorusGeometry,
  PROCEDURAL_FLOATS_PER_VERTEX,
} from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';

it('uses the Geometry-owned vertex layout for ordinary primitive and procedural assets', () => {
  const assets = new AssetRegistry();
  const inputs = [
    createPrimitiveMesh('cube'),
    createPrimitiveMesh('triangle'),
    createBoxGeometry(1, 1, 1),
    createConeGeometry(1, 2),
    createCylinderGeometry(1, 1, 2),
    createPlaneGeometry(1, 1),
    createSphereGeometry(1),
    createTorusGeometry(1, 0.4),
  ];
  expect(PROCEDURAL_FLOATS_PER_VERTEX).toBe(12);
  for (const input of inputs) {
    const handle = assets.create(input.unwrap()).unwrap();
    const mesh = assets.read(handle).unwrap();
    expect(mesh.vertices.length % PROCEDURAL_FLOATS_PER_VERTEX).toBe(0);
    expect(mesh.attributes.position).toBeDefined();
  }
  expect(inputs[1]?.unwrap().vertices.length).toBe(3 * PROCEDURAL_FLOATS_PER_VERTEX);
});
