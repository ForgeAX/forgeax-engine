import { createMeshBuilder } from '@forgeax/engine/geometry';
import { halfFloat } from '@forgeax/engine/math';
import type { EquirectAsset, TextureAsset } from '@forgeax/engine/types';
import { COAST_SEED, SUN_DIRECTION } from '../src/identity';

export const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function coastHeight(x: number, z: number): number {
  const island = Math.exp(-((x + 16) ** 2 / 620 + (z + 62) ** 2 / 160));
  const islet = Math.exp(-((x - 3) ** 2 / 70 + (z + 64) ** 2 / 72));
  const shelfDistance = Math.hypot((x + 16) / 1.4, z + 62);
  const offshore = clamp((shelfDistance - 25) / 90);
  const islandGround = -4.3 + island * 7.8 + islet * 6 + -120 * offshore * offshore;
  const shipShelfDistance = Math.hypot((x + 3) / 1.25, (z + 10) / 1.1);
  const shipOffshore = clamp((shipShelfDistance - 33) / 60);
  const shipShelf = -3.8 - 85 * shipOffshore * shipOffshore;
  const sandRipples = 0.08 * Math.sin(x * 0.43 + z * 0.61 + Math.sin(z * 0.11) * 1.8);
  return Math.max(islandGround, shipShelf) + sandRipples;
}

export function surfaceTexture(kind: 'sand' | 'wood' | 'rock'): TextureAsset {
  const size = 256,
    data = new Uint8Array(size * size * 4);
  let seed = COAST_SEED;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = (seed >>> 0) / 0xffffffff;
      const grain =
        kind === 'sand'
          ? 0.88 +
            0.045 * Math.cos(y * 0.147 + Math.sin(x * 0.049) * 1.8 + Math.sin(y * 0.0245) * 1.2) +
            noise * 0.08
          : kind === 'wood'
            ? 0.83 + 0.055 * Math.sin(y * 0.19 + Math.sin(x * 0.035)) + 0.06 * noise
            : 0.6 + 0.25 * noise + 0.15 * Math.sin(x * 0.08) * Math.cos(y * 0.12);
      const color =
        kind === 'sand'
          ? [1, 0.94, 0.79]
          : kind === 'wood'
            ? [0.91, 0.86, 0.77]
            : [0.82, 0.85, 0.83];
      for (let c = 0; c < 3; c++)
        data[(y * size + x) * 4 + c] = Math.round(clamp(grain * color[c]!) * 255);
      data[(y * size + x) * 4 + 3] = 255;
    }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    data,
    mips: { kind: 'generate' },
  };
}

export function seagrassMesh() {
  const position: number[] = [],
    uv: number[] = [],
    indices: number[] = [];
  for (let blade = 0; blade < 13; blade++) {
    const angle = blade * 2.399,
      radius = 0.12 + (blade % 4) * 0.1,
      height = 0.4 + (blade % 5) * 0.13,
      x = Math.cos(angle) * radius,
      z = Math.sin(angle) * radius,
      width = 0.035 + (blade % 3) * 0.012;
    const first = position.length / 3;
    for (let step = 0; step <= 4; step++) {
      const t = step / 4,
        bend = t * t * height * 0.42;
      for (const side of [-1, 1]) {
        const halfWidth = width * (1 - t * 0.94) * side;
        position.push(
          x + Math.cos(angle) * bend + Math.sin(angle) * halfWidth,
          t * height,
          z + Math.sin(angle) * bend - Math.cos(angle) * halfWidth,
        );
        uv.push((side + 1) / 2, t);
      }
      if (step < 4) {
        const a = first + step * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
  }
  return createMeshBuilder({
    attributes: { position: new Float32Array(position), uv: new Float32Array(uv) },
    indices,
  })
    .build()
    .unwrap();
}

const smooth = (a: number, b: number, value: number) => {
  const t = clamp((value - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const noise = (x: number, y: number) => {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    sx = smooth(0, 1, x - ix),
    sy = smooth(0, 1, y - iy);
  const hash = (a: number, b: number) => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ COAST_SEED;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 0xffffffff;
  };
  const lower = hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx,
    upper = hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx;
  return lower * (1 - sy) + upper * sy;
};
const cloudNoise = (x: number, y: number) =>
  noise(x, y) * 0.55 +
  noise(x * 2.03 + 17, y * 2.03 - 9) * 0.27 +
  noise(x * 4.1 - 31, y * 4.1 + 23) * 0.13 +
  noise(x * 8.2 + 3, y * 8.2 + 11) * 0.05;

const cloudPuffs = Array.from({ length: 72 }, (_, cluster) => {
  const distant = cluster >= 30,
    angle = cluster * 2.399 + 0.17,
    distance = distant ? 2700 + noise(cluster, 4) * 2300 : 1200 + noise(cluster, 4) * 1800,
    radius = distant ? 30 + noise(cluster, 9) * 42 : 17 + noise(cluster, 9) * 24,
    base = distant ? 105 + noise(cluster, 19) * 90 : 150 + noise(cluster, 19) * 290;
  return Array.from({ length: 7 }, (_, puff) => {
    const lateral = (puff - 3) * radius * 0.75,
      radial = (noise(cluster, puff + 27) - 0.5) * radius,
      size = radius * (0.7 + noise(cluster, puff + 43) * 0.55),
      vertical = puff === 2 || puff === 4 ? size * 0.65 : 0,
      x = Math.sin(angle) * (distance + radial) + Math.cos(angle) * lateral,
      y = base + size * 0.55 + vertical,
      z = Math.cos(angle) * (distance + radial) - Math.sin(angle) * lateral;
    return { x, y, z, radius: size, distanceSquared: x * x + y * y + z * z };
  });
}).flat();

export function environment(
  preset: 'day' | 'sunset' | 'overcast',
  cloudsEnabled = true,
): EquirectAsset {
  const width = 2048,
    height = 1024,
    data = new Uint8Array(width * height * 8),
    view = new DataView(data.buffer);
  const cover = preset === 'overcast' ? 1.45 : 1;
  // A sphere can only intersect rays inside its conservative azimuth interval.
  const cloudColumns = cloudsEnabled
    ? Array.from({ length: width }, (_, x) => {
        const phi = ((x / width) * 2 - 1) * Math.PI;
        return cloudPuffs.filter((puff) => {
          const center = Math.atan2(puff.x, puff.z),
            halfAngle = Math.asin(
              Math.min(1, (puff.radius * 1.16 * cover) / Math.hypot(puff.x, puff.z)),
            ),
            delta = Math.atan2(Math.sin(phi - center), Math.cos(phi - center));
          return Math.abs(delta) <= halfAngle;
        });
      })
    : [];
  const length = Math.hypot(...SUN_DIRECTION),
    sun = SUN_DIRECTION.map((value) => -value / length);
  const zenith =
    preset === 'sunset'
      ? [0.16, 0.22, 0.38]
      : preset === 'overcast'
        ? [0.25, 0.31, 0.38]
        : [0.045, 0.12, 0.27];
  const horizon =
    preset === 'sunset'
      ? [0.95, 0.53, 0.32]
      : preset === 'overcast'
        ? [0.57, 0.63, 0.68]
        : [0.2, 0.31, 0.44];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const phi = ((x / width) * 2 - 1) * Math.PI,
        theta = (0.5 - y / height) * Math.PI,
        up = Math.sin(theta),
        cp = Math.cos(theta),
        dx = cp * Math.sin(phi),
        dz = cp * Math.cos(phi);
      const h = Math.exp(-Math.max(up, 0) * 6),
        alignment = Math.max(0, dx * sun[0]! + up * sun[1]! + dz * sun[2]!);
      let cloud = 0,
        cloudLight = 0,
        nearestCloud = Number.POSITIVE_INFINITY;
      if (cloudsEnabled && up > 0.005) {
        const detail = cloudNoise(dx * 104 + dz * 31, up * 168 + dz * 61),
          edge = 0.78 + detail * 0.38;
        // Ray/sphere thickness gives the bitmap clouds rounded tops and shaded bases.
        for (const puff of cloudColumns[x]!) {
          const along = dx * puff.x + up * puff.y + dz * puff.z,
            radius = puff.radius * edge * cover,
            discriminant = radius * radius - puff.distanceSquared + along * along;
          if (along <= 0 || discriminant <= 0) continue;
          const halfThickness = Math.sqrt(discriminant),
            entry = along - halfThickness,
            opacity =
              smooth(radius * 0.08, radius * 0.65, halfThickness) *
              smooth(0.23, 0.51, detail + (halfThickness / radius) * 0.25);
          cloud = 1 - (1 - cloud) * (1 - opacity);
          if (entry >= nearestCloud) continue;
          nearestCloud = entry;
          const nx = (dx * entry - puff.x) / radius,
            ny = (up * entry - puff.y) / radius,
            nz = (dz * entry - puff.z) / radius,
            direct = Math.max(0, nx * sun[0]! + ny * sun[1]! + nz * sun[2]!);
          const interior = cloudNoise(puff.x * 0.05 + nx * 4, puff.z * 0.05 + nz * 4 + ny * 3);
          cloudLight =
            0.16 + direct * 0.23 + clamp(ny + 0.25) * 0.2 + interior * 0.14 + detail * 0.1;
        }
        const haze = Number.isFinite(nearestCloud) ? clamp(nearestCloud / 6000) : 0;
        cloud *= smooth(0.005, 0.04, up) * (1 - haze * 0.3);
        cloudLight = cloudLight * (1 - haze * 0.3) + 0.45 * haze * 0.3;
      }
      const ground = clamp((up + 0.05) * 20);
      for (let c = 0; c < 3; c++) {
        const base =
          (zenith[c]! * (1 - h) + horizon[c]! * h) * (1 - cloud) +
          cloud * cloudLight * [1.04, 1.06, 1.08][c]!;
        const glow = (alignment ** 80 * 0.2 + alignment ** 600 * 3) * [1, 0.85, 0.62][c]!;
        const value = (base + glow) * ground + [0.08, 0.13, 0.14][c]! * (1 - ground);
        view.setUint16((y * width + x) * 8 + c * 2, halfFloat.f32ToF16(value), true);
      }
      view.setUint16((y * width + x) * 8 + 6, halfFloat.f32ToF16(1), true);
    }
  return { kind: 'equirect', width, height, format: 'rgba16float', data, colorSpace: 'linear' };
}

const stations = [
  [-9, 1.35],
  [-8, 1.9],
  [-6, 2.3],
  [-3, 2.6],
  [0, 2.6],
  [3, 2.35],
  [5.8, 1.7],
  [7.2, 0.85],
  [8.2, 0.04],
] as const;
export const hullSheer = (x: number) => 1.4 * clamp(-x / 9) ** 2 + 0.75 * clamp(x / 8.2) ** 4;
export const hullWidth = (x: number) => {
  const last = stations[stations.length - 1]!;
  if (x >= last[0]) return last[1];
  const index = Math.max(
    0,
    Math.min(stations.length - 2, stations.findIndex((station) => station[0] > x) - 1),
  );
  const a = stations[index]!,
    b = stations[index + 1]!,
    t = clamp((x - a[0]) / (b[0] - a[0]));
  const p = stations[Math.max(0, index - 1)]![1],
    q = stations[Math.min(stations.length - 1, index + 2)]![1];
  return (
    0.5 *
    (2 * a[1] +
      (-p + b[1]) * t +
      (2 * p - 5 * a[1] + 4 * b[1] - q) * t * t +
      (-p + 3 * a[1] - 3 * b[1] + q) * t * t * t)
  );
};
const hullSection = [
  [-1.35, 0],
  [-0.95, -0.53],
  [-0.25, -0.88],
  [0.65, -1],
  [1.55, -0.98],
  [1.55, 0.98],
  [0.65, 1],
  [-0.25, 0.88],
  [-0.95, 0.53],
] as const;

function hullVertex(x: number, y: number, z: number): readonly [number, number, number] {
  const rocker = 1.05 * (Math.abs(x + 0.5) / 10) ** 3,
    heightWeight = clamp((y + 1.35) / 2.9);
  return [
    x - 1.5 * smooth(5, 8.2, x) * (1 - heightWeight),
    y + rocker * (1 - heightWeight) + hullSheer(x) * heightWeight,
    z * hullWidth(x),
  ];
}

export function hullWaterlinePoint(
  x: number,
  heightM: number,
): readonly [number, number, number] | undefined {
  const rocker = 1.05 * (Math.abs(x + 0.5) / 10) ** 3,
    delta = hullSheer(x) - rocker,
    y = (heightM - rocker - (delta * 1.35) / 2.9) / (1 + delta / 2.9);
  if (y < hullSection[0]![0] || y > 1.55) return undefined;
  const side = hullSection.slice(0, 5);
  const next = side.findIndex((point) => point[0] >= y);
  const a = side[Math.max(0, next - 1)]!,
    b = side[Math.max(1, next)]!;
  const weight = clamp((y - a[0]) / (b[0] - a[0]));
  return hullVertex(x, y, Math.abs(a[1] + (b[1] - a[1]) * weight));
}

export function hullMesh(includeDeck = true) {
  const section = hullSection;
  const positions: number[] = [],
    uv: number[] = [],
    indices: number[] = [];
  const count = 56;
  for (let i = 0; i <= count; i++)
    for (let j = 0; j < section.length; j++) {
      const x = -9 + (17.2 * i) / count,
        [y, z] = section[j]!;
      positions.push(...hullVertex(x, y, z));
      uv.push((x + 9) / 3, j * 0.075);
    }
  for (let i = 0; i < count; i++)
    for (let j = 0; j < section.length; j++) {
      if (!includeDeck && j === 4) continue;
      const a = i * section.length + j,
        b = i * section.length + ((j + 1) % section.length),
        c = b + section.length,
        d = a + section.length;
      indices.push(a, b, c, a, c, d);
    }
  const end = count * section.length;
  for (let j = 1; j < section.length - 1; j++) indices.push(0, j + 1, j, end, end + j, end + j + 1);
  return createMeshBuilder({
    attributes: { position: new Float32Array(positions), uv: new Float32Array(uv) },
    indices,
  })
    .build()
    .unwrap();
}

export function sailMesh(width: number, height: number, triangular = false, rake = 0) {
  const positions: number[] = [],
    uv: number[] = [],
    indices: number[] = [],
    n = 16;
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) {
      const u = x / n,
        v = y / n,
        span = triangular ? 1 - v : 1;
      positions.push(
        triangular
          ? u * width * span - width * 0.5 + rake * v + Math.sin(v * Math.PI) * width * 0.12
          : (u - 0.5) * width + rake * v,
        v * height + Math.sin(u * Math.PI) * 0.18 * span,
        Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * Math.min(width * 0.35, 1.8),
      );
      uv.push(u, v);
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return createMeshBuilder({
    attributes: { position: new Float32Array(positions), uv: new Float32Array(uv) },
    indices,
  })
    .build()
    .unwrap();
}

export function palmFrondMesh() {
  const positions: number[] = [],
    uv: number[] = [],
    indices: number[] = [],
    count = 12;
  for (let i = 0; i <= count; i++) {
    const t = i / count,
      width = 0.24 * Math.sin(Math.PI * t);
    for (const side of [-1, 1]) {
      positions.push(t * 2.8, -1.1 * t * t, side * width);
      uv.push(t, (side + 1) / 2);
    }
    if (i < count) {
      const a = i * 2;
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  return createMeshBuilder({
    attributes: { position: new Float32Array(positions), uv: new Float32Array(uv) },
    indices,
  })
    .build()
    .unwrap();
}

export function waterPlane(width: number, length: number) {
  return createMeshBuilder({
    attributes: {
      position: new Float32Array([
        -width / 2,
        0,
        -length / 2,
        width / 2,
        0,
        -length / 2,
        width / 2,
        0,
        length / 2,
        -width / 2,
        0,
        length / 2,
      ]),
      uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    },
    indices: [0, 2, 1, 0, 3, 2],
  })
    .build()
    .unwrap();
}
