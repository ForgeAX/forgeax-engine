import * as THREE from '@forgeax/engine/three';
import { NURBSCurve } from '@forgeax/engine/three/addons/curves/NURBSCurve.js';
import { NURBSSurface } from '@forgeax/engine/three/addons/curves/NURBSSurface.js';
import { calcBSplinePoint } from '@forgeax/engine/three/addons/curves/NURBSUtils.js';
import { NURBSVolume } from '@forgeax/engine/three/addons/curves/NURBSVolume.js';
import { ColorConverter } from '@forgeax/engine/three/addons/math/ColorConverter.js';
import {
  DisplayP3ColorSpaceImpl,
  LinearDisplayP3ColorSpace,
} from '@forgeax/engine/three/addons/math/ColorSpaces.js';
import { radixSort } from '@forgeax/engine/three/addons/utils/SortUtils.js';
import { expect, it } from 'vitest';
import { brokenBox, loftGeometry, nurbsGeometry } from './surface-addons.fixture';

it('samples rational curve/surface/volume data into caller-owned public vectors', () => {
  const knots = [0, 0, 1, 1],
    controls = [new THREE.Vector4(0, 0, 0, 1), new THREE.Vector4(1, 0, 0, 1)],
    out = new THREE.Vector3();
  const curve = new NURBSCurve(1, knots, controls);
  expect(curve.getPoint(0.25, out)).toBe(out);
  expect(out.x).toBeCloseTo(0.25);
  expect(calcBSplinePoint(1, knots, controls, 0.5)).toBeInstanceOf(THREE.Vector4);
  const restored = new NURBSCurve(1, knots, controls).fromJSON(curve.toJSON());
  expect(restored.getPoint(0.25).x).toBeCloseTo(0.25);
  const surface = new NURBSSurface(1, 1, knots, knots, [
    controls,
    controls.map((v) => new THREE.Vector4(v.x, 1, 0, 1)),
  ]);
  surface.getPoint(0.25, 0.75, out);
  expect(out.toArray()).toEqual([0.75, 0.25, 0]);
  const grid = [0, 1].map((x) =>
    [0, 1].map((y) => [0, 1].map((z) => new THREE.Vector4(x, y, z, 1))),
  );
  new NURBSVolume(1, 1, 1, knots, knots, knots, grid).getPoint(0.25, 0.5, 0.75, out);
  expect(out.toArray()).toEqual([0.25, 0.5, 0.75]);
});
it('builds loft and NURBS meshes and convex fragments with public geometry/material identity', () => {
  const fragments = brokenBox(),
    geometries = [
      loftGeometry(),
      nurbsGeometry(),
      fragments.left.geometry,
      fragments.right.geometry,
    ];
  try {
    for (const g of geometries) {
      expect(g).toBeInstanceOf(THREE.BufferGeometry);
      expect(g.getAttribute('position').count).toBeGreaterThan(0);
      g.computeBoundingBox();
      expect(g.boundingBox?.isEmpty()).toBe(false);
    }
    expect(fragments.left.material).toBe(fragments.material);
    expect(fragments.right.material).toBe(fragments.material);
  } finally {
    for (const g of geometries) g.dispose();
    fragments.material.dispose();
  }
});
it('preserves explicit color-space definitions, output reuse and caller-owned radix scratch', () => {
  const color = new THREE.Color(),
    hsv = { h: 0, s: 0, v: 0 };
  expect(ColorConverter.setHSV(color, 1 / 3, 1, 1)).toBe(color);
  expect(ColorConverter.getHSV(color, hsv)).toBe(hsv);
  expect(hsv.h).toBeCloseTo(1 / 3);
  expect(DisplayP3ColorSpaceImpl.toXYZ).toBeInstanceOf(THREE.Matrix3);
  expect(LinearDisplayP3ColorSpace).toBe('display-p3-linear');
  const values = [{ key: 3 }, { key: 0 }, { key: 2 }, { key: 1 }],
    aux = new Array<{ key: number }>(4);
  radixSort(values, { aux, get: (v) => v.key });
  expect(values.map((v) => v.key)).toEqual([0, 1, 2, 3]);
  const integers = new Uint32Array([0xffffffff, 3, 0, 2]),
    scratch = new Uint32Array(4);
  radixSort(integers, { aux: scratch });
  expect([...integers]).toEqual([0, 2, 3, 0xffffffff]);
});
