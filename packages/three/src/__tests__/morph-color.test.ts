import { Float32BufferAttribute, PlaneGeometry } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { projectGeometry } from '../geometry';

it.each([
  false,
  true,
])('projects RGB color morphs (relative=%s) while preserving source data', (relative) => {
  const geometry = new PlaneGeometry(1, 1),
    count = geometry.getAttribute('position').count;
  const base = new Float32BufferAttribute(
    Array.from({ length: count * 3 }, (_, i) => [0.8, 0.2, 0.1][i % 3] ?? 0),
    3,
  );
  const target = new Float32BufferAttribute(
    Array.from({ length: count * 3 }, (_, i) => [0.1, 0.4, 0.8][i % 3] ?? 0),
    3,
  );
  geometry.setAttribute('color', base);
  geometry.morphAttributes.color = [target];
  geometry.morphTargetsRelative = relative;
  const before = base.array.slice();
  const projected = projectGeometry(
    geometry,
    false,
    [{ slot: 0, vertexColors: true }],
    'triangle-list',
    {},
    false,
    [0.8],
  ).unwrap();
  const color = projected?.attributes.color as Float32Array;
  const expected = relative ? [0.88, 0.52, 0.74, 1] : [0.24, 0.36, 0.66, 1];
  for (let lane = 0; lane < 4; lane++) expect(color[lane]).toBeCloseTo(expected[lane] ?? 0, 6);
  expect(base.array).toEqual(before);
  expect(base.version).toBe(0);
  expect(projected?.morphTargets).toBeUndefined();
  geometry.dispose();
});

it('morphs RGBA coverage and rejects invalid weight counts before admission', () => {
  const geometry = new PlaneGeometry(1, 1),
    count = geometry.getAttribute('position').count;
  geometry.setAttribute(
    'color',
    new Float32BufferAttribute(new Float32Array(count * 4).fill(1), 4),
  );
  geometry.morphAttributes.color = [
    new Float32BufferAttribute(new Float32Array(count * 4).fill(0.2), 4),
  ];
  const project = (weights: number[]) =>
    projectGeometry(
      geometry,
      false,
      [{ slot: 0, vertexColors: true }],
      'triangle-list',
      {},
      false,
      weights,
    );
  const color = project([0.5]).unwrap()?.attributes.color as Float32Array;
  expect(color[3]).toBeCloseTo(0.6, 6);
  expect(project([]).ok).toBe(false);
  expect(project([Number.NaN]).ok).toBe(false);
  geometry.dispose();
});
