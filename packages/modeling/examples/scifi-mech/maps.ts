/**
 * C-410 wear composition shared by the case harness (`case/compose.mts`) and the show Pack job.
 * The bake writes the slot surfaces (layer 2: `baseColor`, `ormh`, `emissive` from the
 * palette's kernel slots, U89); this adds the wear layer (layer 3: edge chipping, scratches,
 * grime, rust from the baked curvature and AO masks and object-space noise), with the baked
 * material ids only telling painted and glowing texels apart. Maps are RGBA bytes, N x N, rows
 * following v as the bake writes them.
 */
export interface SetMesh {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly indices: ArrayLike<number>;
}
export interface SetBake {
  readonly normal: Uint8Array;
  readonly curvature: Uint8Array;
  readonly materialId: Uint8Array;
  /** sRGB base color, then occlusion / roughness / metallic / height, then linear emission (the U89 slot maps). */
  readonly baseColor: Uint8Array;
  readonly ormh: Uint8Array;
  readonly emissive: Uint8Array;
}
export interface PreparedSet {
  readonly size: number;
  readonly covered: number;
  readonly slotNames: readonly string[];
  readonly wear: WearContext;
  readonly pos: Float32Array;
  readonly upv: Float32Array;
  readonly slotOf: Int8Array;
  readonly maps: SetBake;
}

// ------------------------------------------------------------------- deterministic noise
const h3 = (x: number, y: number, z: number) => {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(fx), v = s(fy), w = s(fz);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    r += h3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}
const fbm = (x: number, y: number, z: number, o = 4) => {
  let a = 0, f = 1, w = 0.5, n = 0;
  for (let i = 0; i < o; i++) { a += w * vnoise(x * f, y * f, z * f); n += w; f *= 2.03; w *= 0.5; }
  return a / n;
};
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const srgb8 = (c: number) => Math.round(Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) * 255);
export const lin8 = (b: number) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

export type Pbr = { color: [number, number, number]; metallic: number; roughness: number };
const PAINTED = new Set(['armor', 'accent', 'hazard']);
/** Set-relative curvature thresholds: the baked curvature is normalized per bake, so convex edges are its top percentiles. */
export interface WearContext { readonly edgeLo: number; readonly edgeHi: number }
/** Wear coverage of the last compose (fractions of painted texels). */
export const WEAR = { painted: 0, bare: 0, rust: 0, grime: 0 };
/**
 * Layer 3: wear of one texel from its masks (AO, curvature), object-space position and up
 * component of the low normal: edge chipping to satin steel on the top curvature percentiles
 * broken by noise, rare scratches, cavity grime, rust in deep cavities with short vertical
 * streaks, and dust on upward faces. The paint stays dominant.
 */
function wear(slot: string, p: Pbr, ao: number, curv: number, x: number, y: number, z: number, up: number, w: WearContext): Pbr {
  let c: [number, number, number] = [...p.color];
  let met = p.metallic, rough = p.roughness;
  const n1 = fbm(x * 7, y * 7, z * 7), n2 = fbm(x * 45 + 11, y * 45, z * 45), n3 = vnoise(x * 90, y * 3.5, z * 90);
  const cavity = 1 - ao;
  const grime = Math.min(1, cavity ** 1.5 * (0.5 + 0.7 * n1) + smooth(0.8, 0.0, y) * 0.25 * n1);
  c = c.map((v) => v * (1 - 0.5 * grime)) as typeof c;
  rough = Math.min(1, rough + 0.2 * grime);
  const painted = PAINTED.has(slot);
  if (painted) {
    WEAR.painted++;
    if (grime > 0.3) WEAR.grime++;
    c = c.map((v) => v * (0.9 + 0.16 * n1 - 0.06 * n2)) as typeof c;
    const edge = smooth(w.edgeLo, w.edgeHi, curv);
    const chip = smooth(0.3, 0.52, edge * (0.45 + 0.75 * n2)) + (n2 > 0.88 ? smooth(0.88, 0.95, n2) * 0.8 : 0);
    const scratch = n3 > 0.9 && n1 > 0.5 ? smooth(0.9, 0.95, n3) * 0.7 : 0;
    const bare = Math.min(1, Math.max(chip, scratch));
    if (bare > 0.5) WEAR.bare++;
    if (bare > 0) {
      const steel: [number, number, number] = [0.26, 0.26, 0.27];
      c = c.map((v, i) => v * (1 - bare) + steel[i]! * bare) as typeof c;
      met = met * (1 - bare) + bare;
      rough = rough * (1 - bare) + 0.45 * bare;
    }
    const streak = smooth(0.72, 0.85, vnoise(x * 60 + 3, y * 2.4, z * 60)) * smooth(0.5, 0.75, n1) * 0.45;
    const rust = Math.min(0.75, smooth(0.84, 0.99, cavity * 0.75 + n1 * 0.35 + bare * 0.2) * 0.65 + streak);
    if (rust > 0.3) WEAR.rust++;
    if (rust > 0) {
      const rc: [number, number, number] = [0.14, 0.05, 0.02];
      c = c.map((v, i) => v * (1 - rust) + rc[i]! * rust) as typeof c;
      met *= 1 - rust;
      rough = rough * (1 - rust) + 0.9 * rust;
    }
  }
  const dust = smooth(0.55, 0.95, up) * (0.15 + 0.25 * n1);
  if (dust > 0) {
    const dc: [number, number, number] = [0.3, 0.27, 0.23];
    c = c.map((v, i) => v * (1 - dust) + dc[i]! * dust) as typeof c;
    rough = rough * (1 - dust) + 0.85 * dust;
    met *= 1 - dust;
  }
  return { color: c, metallic: met, roughness: rough };
}

/**
 * Per-texel object-space position and up component (the wear noise domain, from the set's low
 * triangles grown 24 texels into the gutter), the material class of every texel and the
 * set-relative curvature thresholds. `materials` are the bake provenance classes (sRGB color
 * key in 0..1), `maps` the set's bake at `size` texels square.
 */
export function prepareSet(size: number, m: SetMesh, maps: SetBake, materials: readonly { slot: string; color: readonly number[] }[]): PreparedSet {
  const N = size;
  const pos = new Float32Array(N * N * 3);
  const upv = new Float32Array(N * N);
  const has = new Uint8Array(N * N);
  for (let t = 0; t < m.indices.length; t += 3) {
    const ia = m.indices[t]!, ib = m.indices[t + 1]!, ic = m.indices[t + 2]!;
    const ax = m.uv[ia * 2]! * N, ay = m.uv[ia * 2 + 1]! * N, bx = m.uv[ib * 2]! * N, by = m.uv[ib * 2 + 1]! * N, cx = m.uv[ic * 2]! * N, cy = m.uv[ic * 2 + 1]! * N;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (area === 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / area, w2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / area, w0 = 1 - w1 - w2;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const i = y * N + x;
      has[i] = 1;
      for (let c = 0; c < 3; c++) pos[i * 3 + c] = w0 * m.position[ia * 3 + c]! + w1 * m.position[ib * 3 + c]! + w2 * m.position[ic * 3 + c]!;
      upv[i] = w0 * m.normal[ia * 3 + 1]! + w1 * m.normal[ib * 3 + 1]! + w2 * m.normal[ic * 3 + 1]!;
    }
  }
  let covered = 0;
  for (let i = 0; i < N * N; i++) covered += has[i]!;
  for (let ring = 0; ring < 24; ring++) {
    const grow: [number, number][] = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (has[i]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        if (has[yy * N + xx]) { grow.push([i, yy * N + xx]); break; }
      }
    }
    for (const [i, j] of grow) { has[i] = 1; pos.copyWithin(i * 3, j * 3, j * 3 + 3); upv[i] = upv[j]!; }
  }
  const keys = materials.map((mm) => ({ slot: mm.slot, rgb: mm.color.map(srgb8) }));
  const slotNames = keys.map((k) => k.slot);
  const slotOf = new Int8Array(N * N);
  const id = maps.materialId;
  for (let i = 0; i < N * N; i++) {
    let best = 0, dist = Infinity;
    // Supersampled ids average neighbouring classes at part borders (a rivet rim blends steel
    // and paint); such a mix can land nearest to an unrelated palette color. Emissive must be an
    // exact class: a glow texel needs a near-pure match, otherwise the next nearest class wins.
    keys.forEach((kk, j) => { const d = (id[i * 4]! - kk.rgb[0]!) ** 2 + (id[i * 4 + 1]! - kk.rgb[1]!) ** 2 + (id[i * 4 + 2]! - kk.rgb[2]!) ** 2; if (d < dist && (kk.slot !== 'glow' || d < 24 * 24)) { dist = d; best = j; } });
    slotOf[i] = best;
  }
  const cv: number[] = [];
  for (let i = 0; i < N * N; i += 7) if (PAINTED.has(slotNames[slotOf[i]!] ?? '')) cv.push(maps.curvature[i * 4]!);
  cv.sort((a, q) => a - q);
  const wctx: WearContext = { edgeLo: (cv[Math.floor(0.87 * (cv.length - 1))] ?? 200) / 255, edgeHi: Math.min(1, ((cv[Math.floor(0.99 * (cv.length - 1))] ?? 250) + 1) / 255) };
  for (const k of Object.keys(WEAR) as (keyof typeof WEAR)[]) WEAR[k] = 0;
  return { size: N, covered, slotNames, wear: wctx, pos, upv, slotOf, maps };
}

/**
 * Albedo (sRGB bytes) and ORM (AO, roughness, metal): fair is the baked slot surface (layer 2),
 * art adds the wear layer. Emission is the baked map unchanged (linear, over the slot table's
 * emissive scale).
 */
export function composeVariant(p: PreparedSet, variant: 'fair' | 'art'): { albedo: Uint8Array; orm: Uint8Array; emissive: Uint8Array } {
  const N = p.size;
  const { maps, slotNames, slotOf, pos, upv } = p;
  if (variant === 'fair') {
    const orm = maps.ormh.slice();
    for (let i = 3; i < orm.length; i += 4) orm[i] = 255;
    return { albedo: maps.baseColor, orm, emissive: maps.emissive };
  }
  const albedo = new Uint8Array(N * N * 4), orm = new Uint8Array(N * N * 4);
  const { baseColor: bc, ormh } = maps;
  for (let i = 0; i < N * N; i++) {
    const o = i * 4;
    const base: Pbr = { color: [lin8(bc[o]!), lin8(bc[o + 1]!), lin8(bc[o + 2]!)], roughness: ormh[o + 1]! / 255, metallic: ormh[o + 2]! / 255 };
    const q = wear(slotNames[slotOf[i]!] ?? 'frame', base, ormh[o]! / 255, maps.curvature[o]! / 255, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, upv[i]!, p.wear);
    albedo.set([srgb8(q.color[0]), srgb8(q.color[1]), srgb8(q.color[2]), 255], o);
    orm.set([ormh[o]!, Math.round(Math.max(0, Math.min(1, q.roughness)) * 255), Math.round(Math.max(0, Math.min(1, q.metallic)) * 255), 255], o);
  }
  return { albedo, orm, emissive: maps.emissive };
}
