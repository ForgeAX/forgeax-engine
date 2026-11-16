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
const outline = islandOutline(96);
function shoreDistance(x: number, z: number) {
  let inside = false,
    distance = Infinity;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i],
      b = outline[j];
    if (!a || !b) continue;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
    distance = Math.min(distance, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz));
  }
  return { inside, distance };
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
  for (let i = 0; i < RIVER_PATH.length - 1; i++) {
    const a = RIVER_PATH[i],
      b = RIVER_PATH[i + 1];
    if (!a || !b) continue;
    const dx = b[0] - a[0],
      dz = b[2] - a[2],
      t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz)));
    const width = a[3] + (b[3] - a[3]) * t,
      d = Math.hypot(x - a[0] - dx * t, z - a[2] - dz * t),
      y = a[1] + (b[1] - a[1]) * t;
    if (d < width * 0.5 + 16) h = Math.min(h, y - 2.3 + Math.max(0, d - width * 0.35) * 0.6);
  }
  return h + (variant ? 0.8 * Math.exp(-((x + 50) ** 2 + (z + 170) ** 2) / 4000) : 0);
}
