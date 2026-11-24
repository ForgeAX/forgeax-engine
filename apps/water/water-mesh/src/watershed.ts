/** One authored arc-shaped watershed in world metres. */
export const WORLD_ORIGIN = [-480, 0, -480] as const;
export const WORLD_COLUMNS = 253;
export const WORLD_SPACING_M = 960 / (WORLD_COLUMNS - 1);
export const LAKE_CENTER = [-190, 30, -75] as const;
const smooth = (a: number, b: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** The visible lake and the Terrain basin share this noncircular shore. */
export function lakeShoreRadius(angle: number) {
  const outletAngle = Math.atan2(-22 / 41, 42 / 53);
  const delta = Math.atan2(Math.sin(angle - outletAngle), Math.cos(angle - outletAngle));
  const outline = 0.87 + 0.065 * Math.sin(angle * 3 + 0.6) + 0.035 * Math.cos(angle * 5 - 0.2);
  return outline + (0.97 - outline) * Math.exp((-delta * delta) / 0.08);
}
export function lakeOutline(count = 48) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    const radius = lakeShoreRadius(angle);
    return [
      LAKE_CENTER[0] + 53 * radius * Math.cos(angle),
      LAKE_CENTER[2] + 41 * radius * Math.sin(angle),
    ] as const;
  });
}
export function lakeShoreDistance(x: number, z: number) {
  const dx = (x - LAKE_CENTER[0]) / 53,
    dz = (z - LAKE_CENTER[2]) / 41;
  return Math.hypot(dx, dz) / lakeShoreRadius(Math.atan2(dz, dx));
}
export const RIVER_PATH = [
  [-148, 30, -97, 13],
  [-110, 24, -137, 12],
  [-59, 17, -176, 11],
  [2, 10, -181, 14],
  [71, 4, -170, 20],
  [135, 0.15, -123, 30],
  [185, 0, -88, 42],
] as const;
export const RIVER_TANGENTS = RIVER_PATH.map((point, index) => {
  const before = RIVER_PATH[Math.max(0, index - 1)] ?? point;
  const after = RIVER_PATH[Math.min(RIVER_PATH.length - 1, index + 1)] ?? point;
  const divisor = index === 0 || index === RIVER_PATH.length - 1 ? 1 : 2;
  return [0, 1, 2].map((axis) => ((after[axis] ?? 0) - (before[axis] ?? 0)) / divisor) as [
    number,
    number,
    number,
  ];
});

// Subdivide the authored Hermite route below Terrain sample spacing, rather than
// cutting straight chords across the visible River bends.
const riverSections = RIVER_PATH.slice(0, -1).flatMap((a, index) => {
  const b = RIVER_PATH[index + 1];
  const ta = RIVER_TANGENTS[index],
    tb = RIVER_TANGENTS[index + 1];
  if (!b || !ta || !tb) throw new Error('Missing river section');
  const at = (t: number) => ({
    position: ([0, 1, 2] as const).map(
      (axis) =>
        (2 * t ** 3 - 3 * t ** 2 + 1) * a[axis] +
        (t ** 3 - 2 * t ** 2 + t) * ta[axis] +
        (-2 * t ** 3 + 3 * t ** 2) * b[axis] +
        (t ** 3 - t ** 2) * tb[axis],
    ) as [number, number, number],
    width: a[3] + (b[3] - a[3]) * t,
    key: index + t,
  });
  return Array.from({ length: 32 }, (_, step) => {
    const start = at(step / 32),
      end = at((step + 1) / 32);
    const dx = end.position[0] - start.position[0],
      dz = end.position[2] - start.position[2];
    return { start, end, dx, dz, lengthSquared: dx * dx + dz * dz };
  });
});

function riverTerrainHeight(x: number, z: number, height: number) {
  let nearest: { distance: number; y: number; width: number; key: number } | undefined;
  for (const section of riverSections) {
    const { start, end, dx, dz, lengthSquared } = section;
    const reach = Math.max(start.width, end.width) * 0.5 + 30;
    if (
      Math.abs(x - start.position[0]) > reach + Math.abs(dx) ||
      Math.abs(z - start.position[2]) > reach + Math.abs(dz)
    )
      continue;
    const t = Math.max(
      0,
      Math.min(1, ((x - start.position[0]) * dx + (z - start.position[2]) * dz) / lengthSquared),
    );
    const distance = Math.hypot(x - start.position[0] - dx * t, z - start.position[2] - dz * t);
    if (nearest && distance >= nearest.distance) continue;
    nearest = {
      distance,
      y: start.position[1] + (end.position[1] - start.position[1]) * t,
      width: start.width + (end.width - start.width) * t,
      key: start.key + (end.key - start.key) * t,
    };
  }
  if (!nearest) return height;
  const { distance, y, width, key } = nearest;
  const halfWidth = width * 0.5;
  const freeboard = 2.2 * (1 - smooth(4, 6, key));
  const bank = y + freeboard;
  const valley = Math.max(height, bank);
  // The tidal reach joins the sea plane before the spline's last elevated control point.
  const bed = y * (1 - smooth(3.5, 4, key)) - 2.8;
  const channel = bed + (bank - bed) * smooth(halfWidth * 0.25, halfWidth, distance);
  const shaped =
    distance <= halfWidth
      ? channel
      : bank + (valley - bank) * smooth(halfWidth, halfWidth + 16, distance);
  return shaped + (height - shaped) * smooth(halfWidth + 5, halfWidth + 30, distance);
}
export function islandOutline(count = 72) {
  const half = Math.floor(count / 2);
  const outer = Array.from({ length: half }, (_, i) => {
    const a = 0.48 + (i * (Math.PI * 2 - 0.96)) / (half - 1);
    const shape = 1 + 0.04 * Math.sin(a * 5);
    return [-65 + 275 * shape * Math.cos(a), -40 + 225 * shape * Math.sin(a)] as const;
  });
  const inner = Array.from({ length: half }, (_, i) => {
    const a = Math.PI * 2 - 0.48 - (i * (Math.PI * 2 - 0.96)) / (half - 1);
    return [45 + 155 * Math.cos(a), -40 + 118 * Math.sin(a)] as const;
  });
  return [...outer, ...inner];
}
const shoreEdges = islandOutline(96).map((a, index, outline) => {
  const b = outline[(index + outline.length - 1) % outline.length];
  if (!b) throw new Error('Missing island shore endpoint');
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  return {
    x: a[0],
    z: a[1],
    endZ: b[1],
    dx,
    dz,
    lengthSquared: dx * dx + dz * dz,
    minX: Math.min(a[0], b[0]),
    maxX: Math.max(a[0], b[0]),
    minZ: Math.min(a[1], b[1]),
    maxZ: Math.max(a[1], b[1]),
  };
});
function shoreDistance(x: number, z: number) {
  let inside = false,
    distance = Infinity;
  for (const edge of shoreEdges) {
    if (edge.z > z !== edge.endZ > z && x < (edge.dx * (z - edge.z)) / edge.dz + edge.x)
      inside = !inside;
    // The segment's axis-aligned bounds cannot be nearer than the current
    // winner. Keep crossing parity independent, and retain exact projection
    // arithmetic for every segment that can still change the distance.
    if (
      x < edge.minX - distance ||
      x > edge.maxX + distance ||
      z < edge.minZ - distance ||
      z > edge.maxZ + distance
    )
      continue;
    const t = Math.max(
      0,
      Math.min(1, ((x - edge.x) * edge.dx + (z - edge.z) * edge.dz) / edge.lengthSquared),
    );
    const px = x - edge.x - t * edge.dx,
      pz = z - edge.z - t * edge.dz;
    // Either absolute component bounds the distance from below. Preserve the
    // exact hypot result and arithmetic for every potentially closer segment.
    if (Math.abs(px) < distance && Math.abs(pz) < distance)
      distance = Math.min(distance, Math.hypot(px, pz));
  }
  return { inside, distance };
}
export function watershedVariantOffset(x: number, z: number, variant = 0) {
  return variant ? 0.8 * Math.exp(-((x + 50) ** 2 + (z + 170) ** 2) / 4000) : 0;
}
export function watershedHeight(x: number, z: number, variant = 0) {
  const shore = shoreDistance(x, z);
  let h = shore.inside ? Math.min(27, shore.distance * 0.52) : -Math.min(80, shore.distance * 0.4);
  if (shore.inside)
    h +=
      (Math.sin(x * 0.024 + Math.sin(z * 0.019)) * 2.1 +
        Math.cos(z * 0.033) * 1.5 +
        Math.sin(x * 0.093 + z * 0.071) * 0.35) *
      smooth(3, 36, shore.distance);
  if (shore.inside)
    h +=
      (5 * Math.exp(-((x + 220) ** 2 + (z - 40) ** 2) / 5200) +
        3.6 * Math.exp(-((x + 55) ** 2 + (z - 100) ** 2) / 3600)) *
      smooth(8, 42, shore.distance);
  const lake = lakeShoreDistance(x, z);
  if (shore.inside && lake < 2.1) {
    const rim = 32.2 + Math.sin(x * 0.042 + z * 0.013) * 1.1;
    h = Math.max(h, rim - smooth(1.25, 2.1, lake) * 9);
  }
  if (lake < 1.3) h = Math.min(h, 26.2 + smooth(0.62, 1.3, lake) * 6.4);
  const shaped = riverTerrainHeight(x, z, h);
  // Raised banks belong inland; the estuary may carve, but never fill, the sea floor.
  const bankWeight = shore.inside ? smooth(0, WORLD_SPACING_M, shore.distance) : 0;
  const river = Math.min(h, shaped) + Math.max(0, shaped - h) * bankWeight;
  // Keep the lake's submerged outline open; River banks take over beyond its outlet.
  return h + (river - h) * smooth(1, 1.12, lake) + watershedVariantOffset(x, z, variant);
}
