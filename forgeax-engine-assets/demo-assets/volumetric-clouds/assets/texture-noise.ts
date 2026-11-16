import { rng } from '@forgeax/engine/math';

type Field = (u: number, v: number, w: number) => number;
const wrap = (x: number, period: number) => ((x % period) + period) % period;
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a + t * (b - a);

function gradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Seeded gradient Perlin field, periodic over one unit on each axis. */
export function periodicPerlin(seed: number, period: number): Field {
  const random = rng.create(seed);
  const permutation = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = random.int(0, i);
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }
  const hash = (x: number, y: number, z: number) =>
    permutation[(wrap(x, period) + permutation[(wrap(y, period) + permutation[wrap(z, period) & 255]) & 255]) & 255];
  return (u, v, w) => {
    const x = u * period, y = v * period, z = w * period;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const tx = fade(fx), ty = fade(fy), tz = fade(fz);
    return mix(
      mix(mix(gradient(hash(ix, iy, iz), fx, fy, fz), gradient(hash(ix + 1, iy, iz), fx - 1, fy, fz), tx),
        mix(gradient(hash(ix, iy + 1, iz), fx, fy - 1, fz), gradient(hash(ix + 1, iy + 1, iz), fx - 1, fy - 1, fz), tx), ty),
      mix(mix(gradient(hash(ix, iy, iz + 1), fx, fy, fz - 1), gradient(hash(ix + 1, iy, iz + 1), fx - 1, fy, fz - 1), tx),
        mix(gradient(hash(ix, iy + 1, iz + 1), fx, fy - 1, fz - 1), gradient(hash(ix + 1, iy + 1, iz + 1), fx - 1, fy - 1, fz - 1), tx), ty), tz);
  };
}

/** Periodic inverted F1 distance with fully jittered features and exact nearest-cell search. */
export function periodicWorley(seed: number, period: number): Field {
  const random = rng.create(seed);
  const points = new Float32Array(period ** 3 * 3);
  for (let i = 0; i < points.length; i++) points[i] = random.next();
  return (u, v, w) => {
    const x = u * period, y = v * period, z = w * period;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let nearest = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      const at = (wrap(cx, period) + period * (wrap(cy, period) + period * wrap(cz, period))) * 3;
      const rx = cx + points[at] - x, ry = cy + points[at + 1] - y, rz = cz + points[at + 2] - z;
      nearest = Math.min(nearest, rx * rx + ry * ry + rz * rz);
    }
    // Outside the nearest 27 cells, every feature is at least one cell away.
    if (nearest > 1) {
      for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(dz) < 2) continue;
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const bx = Math.max(cx - x, 0, x - cx - 1);
        const by = Math.max(cy - y, 0, y - cy - 1);
        const bz = Math.max(cz - z, 0, z - cz - 1);
        if (bx * bx + by * by + bz * bz >= nearest) continue;
        const at = (wrap(cx, period) + period * (wrap(cy, period) + period * wrap(cz, period))) * 3;
        const rx = cx + points[at] - x, ry = cy + points[at + 1] - y, rz = cz + points[at + 2] - z;
        nearest = Math.min(nearest, rx * rx + ry * ry + rz * rz);
      }
    }
    return 1 - Math.sqrt(nearest);
  };
}
