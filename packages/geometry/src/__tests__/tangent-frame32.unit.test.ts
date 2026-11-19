import { expect, it } from 'vitest';
import { decodeTangentFrame32, encodeTangentFrame32 } from '../tangent-frame32';

const angle = (a: number[], b: number[]) =>
  (Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        a.reduce((s, v, i) => s + v * (b[i] as number), 0) / Math.hypot(...a) / Math.hypot(...b),
      ),
    ),
  ) *
    180) /
  Math.PI;
it('preserves orientation and bounds angular error across the sphere and basis seams', () => {
  const output = new Float32Array(7);
  let worstNormal = 0,
    worstTangent = 0;
  for (let i = 0; i < 8192; i++) {
    const z = 1 - (2 * (i + 0.5)) / 8192,
      r = Math.sqrt(1 - z * z),
      phi = i * 2.399963229728653;
    const n = [r * Math.cos(phi), r * Math.sin(phi), z];
    const a = Math.abs(z) < 0.9 ? [-(n[1] as number), n[0] as number, 0] : [0, -z, n[1] as number],
      length = Math.hypot(...a);
    a.forEach((v, k) => {
      a[k] = v / length;
    });
    const b = [
      (n[1] as number) * (a[2] as number) - z * (a[1] as number),
      z * (a[0] as number) - (n[0] as number) * (a[2] as number),
      (n[0] as number) * (a[1] as number) - (n[1] as number) * (a[0] as number),
    ];
    const theta = i * 0.71,
      t = a.map((v, k) => v * Math.cos(theta) + (b[k] as number) * Math.sin(theta));
    for (const sign of [-1, 1]) {
      const word = encodeTangentFrame32(
        n[0] as number,
        n[1] as number,
        z,
        t[0] as number,
        t[1] as number,
        t[2] as number,
        sign,
      );
      decodeTangentFrame32(word, output);
      const normal = Array.from(output.subarray(0, 3)),
        tangent = Array.from(output.subarray(3, 6));
      worstNormal = Math.max(worstNormal, angle(n, normal));
      worstTangent = Math.max(worstTangent, angle(t, tangent));
      expect(output[6]).toBe(sign);
      expect(Math.abs(normal.reduce((s, v, k) => s + v * (tangent[k] as number), 0))).toBeLessThan(
        1e-6,
      );
    }
  }
  expect(worstNormal).toBeLessThan(0.15);
  expect(worstTangent).toBeLessThan(0.6);
});

it('handles all poles, diamond wrap and the full unsigned word range', () => {
  const output = new Float32Array(12).fill(99);
  for (const n of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]) {
    const t = n[2] === 0 ? [0, 0, 1] : [1, 0, 0];
    for (const sign of [-1, 1]) {
      decodeTangentFrame32(
        encodeTangentFrame32(
          n[0] as number,
          n[1] as number,
          n[2] as number,
          t[0] as number,
          t[1] as number,
          t[2] as number,
          sign,
        ),
        output,
        2,
      );
      expect(angle(n, Array.from(output.subarray(2, 5)))).toBeLessThan(0.15);
      expect(angle(t, Array.from(output.subarray(5, 8)))).toBeLessThan(0.6);
      expect(output[8]).toBe(sign);
      expect(output[1]).toBe(99);
      expect(output[9]).toBe(99);
    }
  }
  for (const word of [0, 0x7fffffff, 0x80000000, 0xffffffff]) {
    decodeTangentFrame32(word, output);
    expect(Array.from(output.subarray(0, 7)).every(Number.isFinite)).toBe(true);
  }
});

it('rejects invalid source directions rather than silently changing authored frames', () => {
  for (const args of [
    [0, 0, 0, 1, 0, 0, 1],
    [0, 0, 1, 0, 0, 1, 1],
    [NaN, 0, 1, 1, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0],
  ])
    expect(() =>
      encodeTangentFrame32(...(args as [number, number, number, number, number, number, number])),
    ).toThrow(RangeError);
});
