import fs from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { SdfTransformCertificate } from '../../raytracing/sdf-transform-certificate';
import {
  absolute,
  compare,
  coordinate,
  difference,
  type ExactVector,
  normInf,
  product,
  rational,
  residualNorm,
  sum,
  transformed,
  transformedDirection,
  trueLocal,
  trueLocalDirection,
} from './exact-affine.fixture';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const inverse = (m: Float32Array) =>
  Float32Array.from(mat4.invert(mat4.create(), mat4.clone(Array.from(m))));
const vector = (p: readonly [number, number, number]): ExactVector =>
  p.map(rational) as unknown as ExactVector;
function expectBound(
  m: Float32Array,
  a: Float32Array,
  cert: SdfTransformCertificate,
  p: ExactVector,
) {
  const v = transformed(a, p),
    q = trueLocal(m, p),
    error = q.map((x, i) => difference(x, coordinate(v, i))) as unknown as ExactVector;
  const bound = sum(
    product(rational(cert.localRelative), normInf(v)),
    rational(cert.localAbsolute),
  );
  expect(compare(normInf(error), bound) <= 0n).toBe(true);
  return { error: normInf(error).map(String), bound: bound.map(String) };
}
function expectDirectionBound(
  m: Float32Array,
  a: Float32Array,
  cert: SdfTransformCertificate,
  d: ExactVector,
) {
  const v = transformedDirection(a, d),
    q = trueLocalDirection(m, d),
    error = q.map((x, i) => difference(x, coordinate(v, i))) as unknown as ExactVector;
  const bound = product(rational(cert.localRelative), normInf(v));
  expect(compare(normInf(error), bound) <= 0n).toBe(true);
  return { error: normInf(error).map(String), bound: bound.map(String) };
}
it('bounds actual canonical forward versus stored inverse at nonunit ray parameter distances', () => {
  let tested = 0,
    refused = 0;
  const observations: unknown[] = [],
    domains: unknown[] = [];
  for (const scale of [
    [1, 1, 1],
    [-2, 0.5, 1.25],
    [2 ** 20, 2 ** -20, 8],
  ])
    for (const angle of [0, 0.37, 1.2]) {
      const c = Math.cos(angle),
        s = Math.sin(angle),
        [x, y, z] = scale;
      if (x === undefined || y === undefined || z === undefined)
        throw Error('Missing authored scale');
      const m = new Float32Array([
          x * c,
          x * s,
          0,
          0,
          -y * s,
          y * c,
          0,
          0,
          0,
          0,
          z,
          0,
          1024,
          -512,
          32,
          1,
        ]),
        a = inverse(m),
        result = SdfTransformCertificate.create(m, a);
      const rho = residualNorm(m, a);
      domains.push({
        scale,
        angle,
        forward: Array.from(m),
        inverse: Array.from(a),
        rho: rho.map(String),
        certified: result.ok,
      });
      if (!result.ok) {
        expect(compare(rho, rational(1)) >= 0n).toBe(true);
        refused++;
        continue;
      }
      const cert = result.value;
      expect(cert.validate(m, a).ok).toBe(true);
      for (const origin of [
        [0, 0, 0],
        [1e6, -1e6, 100],
      ] as const)
        for (const direction of [
          [0, 0, 2],
          [0.125, -0.75, 2],
          [-4, 1, 0.5],
        ] as const)
          for (const t of [0, 0.25, 1, 10]) {
            const p = origin.map((v, i) =>
              sum(rational(v), product(rational(direction[i] ?? NaN), rational(t))),
            ) as unknown as ExactVector;
            const positionBound = expectBound(m, a, cert, p),
              directionBound = expectDirectionBound(m, a, cert, vector(direction));
            observations.push({
              scale,
              angle,
              origin,
              direction,
              t,
              relative: cert.localRelative,
              absolute: cert.localAbsolute,
              positionBound,
              directionBound,
            });
            tested++;
          }
    }
  expect(tested).toBe(192);
  expect(refused).toBe(1);
  const out = process.env.FORGEAX_TRANSFORM_ARTIFACTS;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      `${out}/transform-bounds.json`,
      JSON.stringify({ tested, refused, domains, observations, gpuCreated: false }, null, 2),
    );
  }
});
it('requires both residual coefficients and never applies position translation to ray directions', () => {
  const m = identity(),
    a = identity();
  a[4] = 2 ** -23;
  const relative = SdfTransformCertificate.create(m, a).unwrap(),
    p = vector([0, 1, 0]);
  const displacement = trueLocal(m, p).map((x, i) =>
    difference(x, coordinate(transformed(a, p), i)),
  ) as unknown as ExactVector;
  expect(compare(normInf(displacement), rational(0)) > 0n).toBe(true);
  expectBound(m, a, relative, p);
  expectDirectionBound(m, a, relative, p);
  const translated = identity();
  translated[12] = 0.25;
  const absolute = SdfTransformCertificate.create(m, translated).unwrap();
  expect(absolute.localRelative).toBe(0);
  expect(absolute.localAbsolute).toBe(0.25);
  const error = trueLocal(m, p).map((x, i) =>
    difference(x, coordinate(transformed(translated, p), i)),
  ) as unknown as ExactVector;
  expect(compare(normInf(error), rational(0)) > 0n).toBe(true);
  expectBound(m, translated, absolute, p);
  expectDirectionBound(m, translated, absolute, p);
});
it('keeps exact zero and rounds a positive subnormal residual outward to normal f32', () => {
  const m = identity(),
    a = identity(),
    zero = SdfTransformCertificate.create(m, a).unwrap();
  expect(zero.localRelative).toBe(0);
  expect(zero.localAbsolute).toBe(0);
  a[4] = 2 ** -149;
  const cert = SdfTransformCertificate.create(m, a).unwrap();
  expect(cert.localRelative).toBe(2 ** -126);
  expect(cert.localAbsolute).toBe(0);
  expectBound(m, a, cert, vector([1, 2, 3]));
});
it('rejects invalid canonical domains, rho >=1 and unrepresentable coefficient bounds', () => {
  expect(SdfTransformCertificate.create(new Float32Array(15), identity()).ok).toBe(false);
  for (const value of [NaN, Infinity, 1 / 3]) {
    const m = Array.from(identity());
    m[0] = value;
    expect(SdfTransformCertificate.create(m, identity()).ok).toBe(false);
  }
  const projective = identity();
  projective[3] = 0.25;
  expect(SdfTransformCertificate.create(projective, identity()).ok).toBe(false);
  for (const value of [0, 3]) {
    const a = identity();
    a[0] = value;
    expect(SdfTransformCertificate.create(identity(), a).ok).toBe(false);
  }
  const tiny = identity();
  tiny[0] = 2 ** -149;
  expect(SdfTransformCertificate.create(tiny, identity()).ok).toBe(false);
  const m = identity(),
    a = identity();
  m[12] = 3.4028234663852886e38;
  a[12] = 3.4028234663852886e38;
  expect(SdfTransformCertificate.create(m, a).ok).toBe(false);
});
it('keeps an edited forward or inverse uncertified until the exact new pair is recertified', () => {
  const m = identity(),
    a = identity(),
    cert = SdfTransformCertificate.create(m, a).unwrap();
  const moved = m.slice();
  moved[12] = 0.25;
  const newInverse = inverse(moved);
  const staleForward = cert.validate(moved, a),
    staleInverse = cert.validate(m, newInverse);
  expect(staleForward.ok).toBe(false);
  if (!staleForward.ok) expect(staleForward.error.code).toBe('ray-reference-stale');
  expect(staleInverse.ok).toBe(false);
  const replacement = SdfTransformCertificate.create(moved, newInverse).unwrap();
  expect(replacement.validate(moved, newInverse).ok).toBe(true);
  expect(Object.isFrozen(cert)).toBe(true);
  // A self-derived forward would trivially hide this stale pair. The source M
  // remains the actual authored canonical matrix throughout the oracle checks.
  expectBound(moved, newInverse, replacement, vector([1, 2, 3]));
  expect(compare(absolute(rational(replacement.localAbsolute)), rational(0)) >= 0n).toBe(true);
});
