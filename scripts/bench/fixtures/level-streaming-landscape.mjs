import { meshFromInterleaved, withVertexColors } from '../../../packages/geometry/dist/index.mjs';

export const cellMeters = 512;
export const gridWidth = 8;
export const worldMeters = cellMeters * gridWidth;
export const worldEdge = worldMeters / 2;
export const start = { z: 1780 };
export const streamingRadius = { visible: 704, prepare: 960, retire: 1088 };

export const cellAt = (x, z) => {
  const column = Math.floor((x + worldEdge) / cellMeters);
  const row = Math.floor((z + worldEdge) / cellMeters);
  return column >= 0 && column < gridWidth && row >= 0 && row < gridWidth
    ? row * gridWidth + column
    : undefined;
};

export const cells = Array.from({ length: gridWidth ** 2 }, (_, id) => ({
  id,
  x: (id % gridWidth) * cellMeters - worldEdge,
  z: Math.floor(id / gridWidth) * cellMeters - worldEdge,
}));

export function distanceToCell(x, z, id) {
  const cell = cells[id];
  return Math.hypot(
    Math.max(cell.x - x, 0, x - cell.x - cellMeters),
    Math.max(cell.z - z, 0, z - cell.z - cellMeters),
  );
}

export const roadX = (z) => 235 * Math.sin(z / 490) + 92 * Math.sin(z / 193);
const riverX = (z) => -740 + 185 * Math.sin(z / 760) + 50 * Math.cos(z / 230);
const ridge = (x, z, cx, cz, spread, elevation) =>
  elevation * Math.exp(-(((x - cx) / spread) ** 2 + ((z - cz) / spread) ** 2));

function sampleHeight(x, z) {
  const hills =
    ridge(x, z, 1400, -1350, 760, 465) +
    ridge(x, z, 1500, -160, 590, 252) +
    ridge(x, z, -1450, -1630, 730, 380) +
    ridge(x, z, -1600, 380, 650, 270) +
    ridge(x, z, 1330, 1450, 590, 255);
  const roadGrade = 26 + 14 * Math.cos(z / 710) + 7 * Math.sin(z / 380);
  const relief = 36 + hills + 18 * Math.sin(x / 230 + z / 310) + 14 * Math.cos(z / 160 - x / 260);
  const verge = Math.min(1, Math.abs(x - roadX(z)) / 265);
  const land = roadGrade + (relief - roadGrade) * verge ** 2 * (3 - 2 * verge);
  const valley = Math.min(1, Math.abs(x - riverX(z)) / 170);
  return -8 + (land + 8) * valley ** 2 * (3 - 2 * valley);
}

const spacing = 32;

// Match the baked triangle split for wheel height and cell collider seams.
export function groundHeight(x, z) {
  const left = Math.floor(x / spacing) * spacing;
  const near = Math.floor(z / spacing) * spacing;
  const u = (x - left) / spacing;
  const v = (z - near) / spacing;
  if (u + v <= 1)
    return (
      sampleHeight(left, near) * (1 - u - v) +
      sampleHeight(left + spacing, near) * u +
      sampleHeight(left, near + spacing) * v
    );
  return (
    sampleHeight(left + spacing, near + spacing) * (u + v - 1) +
    sampleHeight(left, near + spacing) * (1 - u) +
    sampleHeight(left + spacing, near) * (1 - v)
  );
}

function groundColor(x, z, y) {
  const grain = 0.04 * Math.sin(x / 75 + z / 67) + 0.045 * Math.cos(z / 143 - x / 157);
  const stone = Math.max(0, Math.min(1, (y - 110) / 330));
  return [
    0.39 + grain + stone * 0.29,
    0.55 + grain * 0.6 + stone * 0.08,
    0.3 + grain + stone * 0.28,
  ];
}

export function terrainMesh(
  left = -worldEdge,
  near = -worldEdge,
  size = worldMeters,
  painted = true,
) {
  const steps = size / spacing;
  const stride = steps + 1;
  const vertices = new Float32Array(stride ** 2 * 8);
  const colors = painted ? new Float32Array(stride ** 2 * 3) : undefined;
  const indices = new Uint16Array(steps ** 2 * 6);
  for (let row = 0; row <= steps; row++) {
    for (let column = 0; column <= steps; column++) {
      const i = row * stride + column;
      const x = left + column * spacing;
      const z = near + row * spacing;
      const y = sampleHeight(x, z);
      const normal = [
        sampleHeight(x - 4, z) - sampleHeight(x + 4, z),
        8,
        sampleHeight(x, z - 4) - sampleHeight(x, z + 4),
      ];
      const length = Math.hypot(...normal);
      vertices.set(
        [x - left, y, z - near, ...normal.map((n) => n / length), x / 80, z / 80],
        i * 8,
      );
      if (colors) colors.set(groundColor(x, z, y), i * 3);
      if (row < steps && column < steps)
        indices.set(
          [i, i + stride, i + 1, i + 1, i + stride, i + stride + 1],
          (row * steps + column) * 6,
        );
    }
  }
  const mesh = meshFromInterleaved(vertices, indices).unwrap();
  return colors ? withVertexColors(mesh, colors, { space: 'srgb' }).unwrap() : mesh;
}

export function landscapeRibbon(kind) {
  const vertices = [];
  const indices = [];
  const strip = (near, far, left, right) => {
    const index = vertices.length / 8;
    for (const z of [near, far]) {
      for (const offset of [left, right]) {
        const x = (kind === 'water' ? riverX(z) : roadX(z)) + offset;
        const elevation =
          kind === 'water' ? 2 : groundHeight(x, z) + (kind === 'marks' ? 0.42 : 0.31);
        vertices.push(x, elevation, z, 0, 1, 0, offset * 0.03, z * 0.02);
      }
    }
    indices.push(index, index + 2, index + 1, index + 1, index + 2, index + 3);
  };
  for (let z = -worldEdge; z < worldEdge; z += kind === 'marks' ? 22 : 8) {
    if (kind === 'marks') strip(z, Math.min(worldEdge, z + 9), -0.24, 0.24);
    else if (kind === 'water') strip(z, Math.min(worldEdge, z + 8), -74, 74);
    else strip(z, Math.min(worldEdge, z + 8), -6.6, 6.6);
  }
  return meshFromInterleaved(new Float32Array(vertices), new Uint16Array(indices)).unwrap();
}
