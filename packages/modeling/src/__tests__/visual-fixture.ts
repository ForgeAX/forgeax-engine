import type { ColorImage } from '../tools/image-metrics';

export interface Shape {
  readonly body?: readonly [number, number, number, number];
  readonly eye?: readonly [number, number, number];
  readonly rgb?: readonly [number, number, number];
  /** A body-colored rectangle (u0, v0, u1, v1) that may extend the subject bbox. */
  readonly fin?: readonly [number, number, number, number];
}

/** A gray-background subject: a body ellipse (cx, cy, rx, ry) with optional dark eye disc. */
export function subject(size: number, shape: Shape = {}): ColorImage {
  const [cx, cy, rx, ry] = shape.body ?? [0.5, 0.5, 0.3, 0.35];
  const body = shape.rgb ?? [0.8, 0.35, 0.2];
  const rgb = new Float32Array(size * size * 3).fill(0.85);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const inFin =
        shape.fin !== undefined &&
        u >= shape.fin[0] &&
        u < shape.fin[2] &&
        v >= shape.fin[1] &&
        v < shape.fin[3];
      const inBody = inFin || ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
      if (!inBody) continue;
      const shade = 0.75 + 0.25 * (1 - (v - (cy - ry)) / (2 * ry));
      let c: readonly number[] = body.map((k) => k * shade);
      if (shape.eye !== undefined) {
        const [ex, ey, er] = shape.eye;
        if ((u - ex) ** 2 + (v - ey) ** 2 <= er * er) c = [0.05, 0.05, 0.08];
      }
      for (let k = 0; k < 3; k++) rgb[(y * size + x) * 3 + k] = c[k] as number;
    }
  return { width: size, height: size, rgb };
}

/** A gray-background plate seen from `azimuth`: width follows |cos| (a billboard is thin edge-on); `ring` cuts a through-hole. */
export function plate(
  size: number,
  options: { readonly thin?: boolean; readonly ring?: boolean; readonly azimuth: number },
): ColorImage {
  const rgb = new Float32Array(size * size * 3).fill(0.85);
  const full = 0.3;
  const half =
    options.thin === true
      ? full * Math.max(0.02, Math.abs(Math.cos((options.azimuth * Math.PI) / 180)))
      : full * (0.75 + 0.25 * Math.abs(Math.cos((options.azimuth * Math.PI) / 180)));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      if (Math.abs(u) > half || Math.abs(v) > 0.3) continue;
      if (options.ring === true && u * u + v * v < 0.01) continue;
      for (let k = 0; k < 3; k++) rgb[(y * size + x) * 3 + k] = [0.7, 0.4, 0.3][k] as number;
    }
  return { width: size, height: size, rgb };
}
