// Shared harness of the T1 detail-source cases (C-401..C-406): mesh dumps, tiling/wrapping,
// tileable (periodic) bakes on top of the kernel bakeMaps, opacity raster, analytic height stamps,
// albedo/ORM composition, seam metrics, KTX2 encode, scene description for the Dawn renderer and
// the case history record. Runs in the Engine worktree (tsx, cwd packages/modeling).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bakeMaps, type Model, model } from '@forgeax/engine-modeling';
import { encodeTextureToKtx2 } from '@forgeax/engine-image/ktx2-encode';
import { computeTangentVec4 } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';

export type V3 = [number, number, number];
export interface Sub { indexOffset: number; indexCount: number; materialSlot: number }
export interface Dump {
  position: Float32Array; normal: Float32Array; uv: Float32Array; tangent?: Float32Array;
  indices: Uint32Array; submeshes: Sub[]; slots: string[];
}
export const tris = (d: Dump) => d.indices.length / 3;
export const verts = (d: Dump) => d.position.length / 3;
/** GPU bytes of a dump: position+normal+uv+tangent (48 B) per vertex + u32 indices. */
export const meshBytes = (d: Dump) => verts(d) * 48 + d.indices.length * 4;

export function fromModel(m: Model, key: string, normals: { mode: 'flat' | 'smooth' | 'weighted' } | { mode: 'autoSmooth'; angle: number } = { mode: 'autoSmooth', angle: 35 }, project = true): Dump {
  if (project) m.uv.project({ mode: 'box', scale: 1 });
  const r = m.finish({ key, normals });
  if (!r.ok) throw new Error(`finish ${key}: ${r.error.code} ${r.error.message}`);
  const a = Object.values(r.value)[0] as MeshAsset;
  const at = a.attributes as unknown as Record<string, Float32Array>;
  const vc = at.position!.length / 3;
  return {
    position: at.position!, normal: at.normal!, uv: at.uv ?? new Float32Array(vc * 2), ...(at.tangent ? { tangent: at.tangent } : {}),
    indices: new Uint32Array(a.indices as ArrayLike<number>),
    submeshes: a.submeshes.map((s) => ({ indexOffset: s.indexOffset, indexCount: s.indexCount, materialSlot: s.materialSlot })),
    slots: a.materialSlots.map((s) => s.slotName),
  };
}

/** Merge dumps; slots merge by name, one submesh per slot. */
export function merge(parts: Dump[]): Dump {
  const slots: string[] = [];
  for (const p of parts) for (const s of p.slots) if (!slots.includes(s)) slots.push(s);
  const nv = parts.reduce((a, p) => a + verts(p), 0);
  const position = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const perSlot: number[][] = slots.map(() => []);
  let vo = 0;
  for (const p of parts) {
    position.set(p.position, vo * 3); normal.set(p.normal, vo * 3); uv.set(p.uv, vo * 2);
    for (const s of p.submeshes) {
      const k = slots.indexOf(p.slots[s.materialSlot]!);
      const out = perSlot[k]!;
      for (let i = s.indexOffset; i < s.indexOffset + s.indexCount; i++) out.push(p.indices[i]! + vo);
    }
    vo += verts(p);
  }
  const total = perSlot.reduce((a, s) => a + s.length, 0);
  const indices = new Uint32Array(total);
  const submeshes: Sub[] = [];
  let io = 0;
  perSlot.forEach((s, k) => { if (s.length === 0) return; indices.set(s, io); submeshes.push({ indexOffset: io, indexCount: s.length, materialSlot: k }); io += s.length; });
  return { position, normal, uv, indices, submeshes, slots };
}

/** Affine copy: p' = R p + t (R orthonormal 3x3 row-major), normals rotated. */
export function transform(d: Dump, R: number[], t: V3): Dump {
  const n = verts(d), P = new Float32Array(n * 3), N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = d.position[i * 3]!, y = d.position[i * 3 + 1]!, z = d.position[i * 3 + 2]!;
    const a = d.normal[i * 3]!, b = d.normal[i * 3 + 1]!, c = d.normal[i * 3 + 2]!;
    for (let k = 0; k < 3; k++) {
      P[i * 3 + k] = R[k * 3]! * x + R[k * 3 + 1]! * y + R[k * 3 + 2]! * z + t[k]!;
      N[i * 3 + k] = R[k * 3]! * a + R[k * 3 + 1]! * b + R[k * 3 + 2]! * c;
    }
  }
  return { position: P, normal: N, uv: d.uv.slice(), indices: d.indices, submeshes: d.submeshes, slots: d.slots };
}
export const translate = (d: Dump, t: V3) => transform(d, [1, 0, 0, 0, 1, 0, 0, 0, 1], t);
export const rotX = (deg: number) => { const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180); return [1, 0, 0, 0, c, -s, 0, s, c]; };
export const rotY = (deg: number) => { const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180); return [c, 0, s, 0, 1, 0, -s, 0, c]; };

/** nx x ny copies of a tile at pitch (tx, ty) starting at (x0, y0) (XY plane). */
export function replicate(d: Dump, nx: number, ny: number, tx: number, ty: number, x0 = 0, y0 = 0): Dump {
  const parts: Dump[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) parts.push(translate(d, [x0 + i * tx, y0 + j * ty, 0]));
  return merge(parts);
}

/** Set uv = (x / tx, y / ty) from flat coordinates (tiling carrier). */
export function planarUv(d: Dump, tx: number, ty: number, u0 = 0, v0 = 0): Dump {
  const uv = new Float32Array(verts(d) * 2);
  for (let i = 0; i < verts(d); i++) { uv[i * 2] = u0 + d.position[i * 3]! / tx; uv[i * 2 + 1] = v0 + d.position[i * 3 + 1]! / ty; }
  return { ...d, uv };
}

/** Flat grid in XY facing +Z: [x0, x0 + w] x [y0, y0 + h], nx x ny quads, uv = (x / tx, y / ty). */
export function grid(w: number, h: number, nx: number, ny: number, tx: number, ty: number, slot: string, x0 = 0, y0 = 0, z = 0): Dump {
  const vx = nx + 1, vy = ny + 1;
  const position = new Float32Array(vx * vy * 3), normal = new Float32Array(vx * vy * 3), uv = new Float32Array(vx * vy * 2);
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
    const k = j * vx + i, x = x0 + (w * i) / nx, y = y0 + (h * j) / ny;
    position.set([x, y, z], k * 3); normal.set([0, 0, 1], k * 3); uv.set([x / tx, y / ty], k * 2);
  }
  const idx: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * vx + i, b = a + 1, c = a + vx, e = c + 1; idx.push(a, b, e, a, e, c); }
  return { position, normal, uv, indices: new Uint32Array(idx), submeshes: [{ indexOffset: 0, indexCount: idx.length, materialSlot: 0 }], slots: [slot] };
}

/**
 * Wrap a flat dump around a cylinder along +Y: x runs around (theta = x / R, from +Z toward +X),
 * y along the axis, z radially outward (radius R + z). Exact normals through the Jacobian.
 */
export function wrapCylinder(d: Dump, R: number): Dump {
  const n = verts(d), P = new Float32Array(n * 3), N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = d.position[i * 3]!, y = d.position[i * 3 + 1]!, z = d.position[i * 3 + 2]!;
    const th = x / R, s = Math.sin(th), c = Math.cos(th), r = R + z;
    P.set([r * s, y, r * c], i * 3);
    const sc = r / R; // d/dx stretch
    const a = d.normal[i * 3]! / sc, b = d.normal[i * 3 + 1]!, e = d.normal[i * 3 + 2]!;
    const nx = a * c + e * s, ny = b, nz = -a * s + e * c, l = Math.hypot(nx, ny, nz) || 1;
    N.set([nx / l, ny / l, nz / l], i * 3);
  }
  return { position: P, normal: N, uv: d.uv.slice(), indices: d.indices, submeshes: d.submeshes, slots: d.slots };
}

export function withTangents(d: Dump): Dump {
  const t = computeTangentVec4(d.position, d.normal, d.uv, d.indices);
  if (!t.ok) throw new Error(`tangent: ${JSON.stringify(t.error)}`);
  return { ...d, tangent: t.value };
}

export function aabb(d: Dump) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < d.position.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k]!, d.position[i + k]!); b[k + 3] = Math.max(b[k + 3]!, d.position[i + k]!); }
  return b;
}

/** Binary dump for the renderer: position, normal, uv, tangent then u32 indices; meta JSON. */
export function writeMesh(dir: string, name: string, d0: Dump) {
  const d = d0.tangent ? d0 : withTangents(d0);
  mkdirSync(dir, { recursive: true });
  const parts = [d.position, d.normal, d.uv, d.tangent!, d.indices];
  const bin = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  writeFileSync(join(dir, `${name}.bin`), bin);
  const meta = { verts: verts(d), indexCount: d.indices.length, tris: tris(d), attrs: [['position', 3], ['normal', 3], ['uv', 2], ['tangent', 4]], submeshes: d.submeshes, slots: d.slots, aabb: aabb(d), bytes: meshBytes(d) };
  writeFileSync(join(dir, `${name}.meta.json`), JSON.stringify(meta));
  return meta;
}

// ---------------------------------------------------------------------------------------- bake

const asMesh = (d: Dump): MeshAsset => {
  const vertexCount = verts(d);
  return { kind: 'mesh', vertices: new Float32Array(0), indices: d.indices, attributes: { position: d.position, normal: d.normal, uv: d.uv },
    aabb: new Float32Array(6), submeshes: d.submeshes.map((s) => ({ ...s, vertexCount, topology: 'triangle-list' as const })), materialSlots: d.slots.map((n) => ({ slotName: n, sourceKey: n })) } as unknown as MeshAsset;
};
export function liftDump(d: Dump): Model {
  const m = model();
  const r = m.lift(asMesh(d));
  if (r.status !== 'ok') throw new Error(`lift: ${JSON.stringify(r.error)}`);
  return m;
}

export interface BakeOut {
  N: number; normal: Uint8Array; ao: Uint8Array; height: Uint8Array; curvature: Uint8Array; materialId: Uint8Array;
  materials: { slot: string; color: number[] }[]; ms: number; report: unknown; diagnostics: unknown;
}
/** One kernel bakeMaps call (square N atlas); base normals flat or smooth. */
export function bake(base: Dump, detail: Dump, o: { N: number; spp: 1 | 4 | 9 | 16; distance: number; aoDistance: number; baseNormals?: 'flat' | 'smooth'; detailAngle?: number; heightRange?: [number, number] }): BakeOut {
  const b = liftDump(base), dm = liftDump(detail);
  const t0 = performance.now();
  const r = bakeMaps({ base: b, detail: dm, maps: ['normal', 'ao', 'height', 'curvature', 'materialId'], resolution: o.N, samples: o.spp, cage: { offset: o.distance, maxRay: 2 * o.distance }, gutter: 4,
    normals: { mode: o.baseNormals ?? 'flat' }, detailNormals: { mode: 'autoSmooth', angle: o.detailAngle ?? 35 }, ao: { rays: 32, distance: o.aoDistance }, mips: false, budget: 1e13, ...(o.heightRange ? { height: { range: o.heightRange } } : {}) });
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`bake: ${r.error.code} ${r.error.message} ${JSON.stringify(r.error.detail)}`);
  const B = r.value, px = (k: string) => (B.textures as Record<string, { data: Uint8Array }>)[k]!.data;
  return { N: o.N, normal: px('normal'), ao: px('ao'), height: px('height'), curvature: px('curvature'), materialId: px('materialId'), materials: B.provenance.materials as never, ms, report: B.report, diagnostics: B.diagnostics };
}

/** Crop a w x h window at (x0, y0) of an N x N rgba8 image. */
export function crop(img: Uint8Array, N: number, x0: number, y0: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.subarray(((y0 + y) * N + x0) * 4, ((y0 + y) * N + x0 + w) * 4), y * w * 4);
  return out;
}

/**
 * Tileable bake of one periodic tile [0, tx] x [0, ty] (XY plane, detail above/below z0, +Z out).
 * The detail is repeated 3 x 3 (or 3 x 1 when only x is periodic) so rays, nearest-point fallbacks
 * and AO rays near the tile border see the neighbours; the base is the centre tile only.
 * Non-square tiles bake into a sub-rectangle of the square atlas (uv v spans h / N) and are cropped.
 */
export function bakeTile(tile: Dump, o: { tx: number; ty: number; w: number; h: number; z0: number; spp: 1 | 4 | 9 | 16; distance: number; aoDistance: number; periodic: 'xy' | 'x' | 'none'; detailAngle?: number; heightRange?: [number, number] }) {
  const N = Math.max(o.w, o.h);
  const ny = o.periodic === 'xy' ? 3 : 1, nx = o.periodic === 'none' ? 1 : 3;
  const detail = o.periodic === 'none' ? tile : replicate(tile, nx, ny, o.tx, o.ty, -o.tx, o.periodic === 'xy' ? -o.ty : 0);
  const base = grid(o.tx, o.ty, 1, 1, o.tx / (o.w / N), o.ty / (o.h / N), 'base', 0, 0, o.z0);
  const out = bake(base, detail, { N, spp: o.spp, distance: o.distance, aoDistance: o.aoDistance, ...(o.detailAngle ? { detailAngle: o.detailAngle } : {}), ...(o.heightRange ? { heightRange: o.heightRange } : {}) });
  if (o.w === N && o.h === N) return { ...out, w: o.w, h: o.h, detailTris: tris(detail) };
  const c = (img: Uint8Array) => crop(img, N, 0, 0, o.w, o.h);
  return { ...out, normal: c(out.normal), ao: c(out.ao), height: c(out.height), curvature: c(out.curvature), materialId: c(out.materialId), w: o.w, h: o.h, detailTris: tris(detail) };
}

/**
 * Orthographic coverage (opacity) of the detail seen along -Z over [0, tx] x [0, ty], periodic:
 * every triangle is rasterised with wrap into an (w*ss) x (h*ss) bit grid, then box-filtered.
 * This is the see-through mask a straight-down bake ray would produce (hit vs miss).
 */
export function opacityRaster(detail: Dump, tx: number, ty: number, w: number, h: number, ss = 4): Uint8Array {
  const W = w * ss, H = h * ss, bits = new Uint8Array(W * H);
  const P = detail.position, I = detail.indices;
  for (let t = 0; t < I.length; t += 3) {
    const xs = [0, 1, 2].map((k) => (P[I[t + k]! * 3]! / tx) * W), ys = [0, 1, 2].map((k) => (P[I[t + k]! * 3 + 1]! / ty) * H);
    const area = (xs[1]! - xs[0]!) * (ys[2]! - ys[0]!) - (xs[2]! - xs[0]!) * (ys[1]! - ys[0]!);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs)), minY = Math.floor(Math.min(...ys)), maxY = Math.ceil(Math.max(...ys));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      const e = (a: number, b: number) => (xs[b]! - xs[a]!) * (cy - ys[a]!) - (ys[b]! - ys[a]!) * (cx - xs[a]!);
      const d0 = e(0, 1), d1 = e(1, 2), d2 = e(2, 0);
      if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) bits[(((y % H) + H) % H) * W + (((x % W) + W) % W)] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += bits[(y * ss + j) * W + x * ss + i]!;
    out[y * w + x] = Math.round((255 * s) / (ss * ss));
  }
  return out;
}

/** Seam metric: mean |edge column difference| / mean |adjacent column difference| (1 = seamless). */
export function seam(img: Uint8Array, w: number, h: number, channels = 3) {
  const at = (x: number, y: number, c: number) => img[(y * w + x) * 4 + c]!;
  let sx = 0, ix = 0, sy = 0, iy = 0;
  for (let y = 0; y < h; y++) for (let c = 0; c < channels; c++) { sx += Math.abs(at(0, y, c) - at(w - 1, y, c)); for (let x = 0; x < w - 1; x++) ix += Math.abs(at(x, y, c) - at(x + 1, y, c)); }
  for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) { sy += Math.abs(at(x, 0, c) - at(x, h - 1, c)); for (let y = 0; y < h - 1; y++) iy += Math.abs(at(x, y, c) - at(x, y + 1, c)); }
  const mx = sx / (h * channels), my = sy / (w * channels), ax = ix / (h * channels * (w - 1)), ay = iy / (w * channels * (h - 1));
  return { u: { edge: +mx.toFixed(3), interior: +ax.toFixed(3), ratio: +(mx / Math.max(ax, 1e-6)).toFixed(3) }, v: { edge: +my.toFixed(3), interior: +ay.toFixed(3), ratio: +(my / Math.max(ay, 1e-6)).toFixed(3) } };
}

// ------------------------------------------------------------------------ analytic height stamps

/** Periodic tangent-space normal map from a height field (metres) over a w x h tile of size tx x ty. */
export function normalFromHeightField(hf: Float64Array, w: number, h: number, tx: number, ty: number): Uint8Array {
  const out = new Uint8Array(w * h * 4), dx = tx / w, dy = ty / h;
  const H = (x: number, y: number) => hf[(((y % h) + h) % h) * w + (((x % w) + w) % w)]!;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = (H(x + 1, y) - H(x - 1, y)) / (2 * dx), gy = (H(x, y + 1) - H(x, y - 1)) / (2 * dy);
    const l = Math.hypot(gx, gy, 1);
    out.set([Math.round((-gx / l * 0.5 + 0.5) * 255), Math.round((-gy / l * 0.5 + 0.5) * 255), Math.round((1 / l * 0.5 + 0.5) * 255), 255], (y * w + x) * 4);
  }
  return out;
}
/** Height-field AO (horizon-free ray march, 16 directions x 8 elevations, periodic), 0..1 open fraction. */
export function aoFromHeightField(hf: Float64Array, w: number, h: number, tx: number, ty: number, dist: number): Float64Array {
  const ao = new Float64Array(w * h), dx = tx / w, dy = ty / h, steps = 24;
  const H = (x: number, y: number) => { const xi = Math.floor(x), yi = Math.floor(y); return hf[(((yi % h) + h) % h) * w + (((xi % w) + w) % w)]!; };
  const dirs = 16, els = [8, 20, 32, 44, 56, 68, 80];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const h0 = H(x, y);
    let open = 0, tot = 0;
    for (let d = 0; d < dirs; d++) {
      const a = (2 * Math.PI * (d + 0.5)) / dirs, ca = Math.cos(a), sa = Math.sin(a);
      for (const el of els) {
        const t = Math.tan((el * Math.PI) / 180), wgt = Math.sin((el * Math.PI) / 90); // cosine-weighted
        let hit = false;
        for (let s = 1; s <= steps && !hit; s++) {
          const r = (dist * s) / steps;
          if (H(x + 0.5 + (ca * r) / dx, y + 0.5 + (sa * r) / dy) > h0 + r * t) hit = true;
        }
        tot += wgt; if (!hit) open += wgt;
      }
    }
    ao[y * w + x] = open / tot;
  }
  return ao;
}

// --------------------------------------------------------------------------- composition, I/O

export interface Pbr { color: [number, number, number]; metallic: number; roughness: number }
export const srgb8 = (c: number) => Math.round(Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) * 255);

/** Albedo (sRGB, alpha = opacity) and ORM (R = AO, G = roughness, B = metallic) from the material-id map. */
export function compose(b: { materialId: Uint8Array; ao: Uint8Array; materials: { slot: string; color: number[] }[]; w: number; h: number }, pbr: Record<string, Pbr>, opacity?: Uint8Array) {
  const n = b.w * b.h, albedo = new Uint8Array(n * 4), orm = new Uint8Array(n * 4);
  const keys = b.materials.map((m) => m.color.map((c) => srgb8(c)));
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let best = 0, dist = Infinity;
    keys.forEach((k, j) => { const d = (b.materialId[o]! - k[0]!) ** 2 + (b.materialId[o + 1]! - k[1]!) ** 2 + (b.materialId[o + 2]! - k[2]!) ** 2; if (d < dist) { dist = d; best = j; } });
    const p = pbr[b.materials[best]?.slot ?? ''] ?? Object.values(pbr)[0]!;
    albedo.set([srgb8(p.color[0]), srgb8(p.color[1]), srgb8(p.color[2]), opacity ? opacity[i]! : 255], o);
    orm.set([b.ao[o]!, Math.round(p.roughness * 255), Math.round(p.metallic * 255), 255], o);
  }
  return { albedo, orm };
}

export function savePng(path: string, data: Uint8Array, w: number, h: number) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data);
  writeFileSync(path, PNG.sync.write(png));
}
export const grey = (v: Uint8Array | Float64Array, scale = 255) => { const o = new Uint8Array(v.length * 4); for (let i = 0; i < v.length; i++) { const g = Math.max(0, Math.min(255, Math.round(v[i]! * scale))); o.set([g, g, g, 255], i * 4); } return o; };
export const channel = (img: Uint8Array, c: number) => { const o = new Uint8Array(img.length / 4); for (let i = 0; i < o.length; i++) o[i] = img[i * 4 + c]!; return o; };

/** Writes PNG + raw rgba of each map and KTX2 (UASTC+zstd and ETC1S, full mip chain) of the shipped ones. */
export async function writeMaps(dir: string, w: number, h: number, maps: Record<string, Uint8Array>, shipped: Record<string, 'srgb' | 'linear'>) {
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(maps)) { savePng(join(dir, `${k}.png`), v, w, h); }
  const ktx: Record<string, Record<string, number>> = {};
  let encodeMs = 0;
  for (const [k, cs] of Object.entries(shipped)) {
    writeFileSync(join(dir, `${k}.rgba`), maps[k]!);
    ktx[k] = {};
    for (const mode of ['uastc-ldr', 'etc1s'] as const) {
      const t0 = performance.now();
      const r = await encodeTextureToKtx2(maps[k]!, w, h, { mode, srgb: cs === 'srgb', perceptual: cs === 'srgb', uastcSupercompression: mode === 'uastc-ldr', mipGen: true } as never);
      encodeMs += performance.now() - t0;
      if (!r.ok) throw new Error(`ktx2 ${k} ${mode}: ${JSON.stringify(r.error)}`);
      ktx[k]![mode] = r.value.ktx2.byteLength;
      writeFileSync(join(dir, `${k}.${mode}.ktx2`), r.value.ktx2);
    }
  }
  const sum = (mode: string) => Object.values(ktx).reduce((a, m) => a + (m[mode] ?? 0), 0);
  let mip = 0; for (let a = w, b = h; ; a = Math.max(1, a >> 1), b = Math.max(1, b >> 1)) { mip += a * b; if (a === 1 && b === 1) break; }
  return { w, h, ktx, totals: { uastc: sum('uastc-ldr'), etc1s: sum('etc1s'), rgba8Mips: Object.keys(shipped).length * mip * 4, bc1BytePerTexelMips: Object.keys(shipped).length * mip }, encodeMs: Math.round(encodeMs) };
}

// ----------------------------------------------------------------------------- scene + history

export interface MatDesc {
  color: [number, number, number]; metallic: number; roughness: number;
  emissive?: [number, number, number]; ei?: number; maps?: string; alphaCutoff?: number; doubleSided?: boolean; normalScale?: number;
}
export interface Scene {
  W: number; H: number; fov: number; backdrop?: { center: V3; size: [number, number]; normal: V3; color: [number, number, number]; intensity: number };
  meshes: string[];
  textures: Record<string, { w: number; h: number; dir: string }>;
  materials: Record<string, MatDesc>;
  variants: Record<string, { mesh: string; materials: string[] }[]>;
  views: Record<string, { eye: V3; target: V3 }>;
  jobs: { view: string; variant: string; out: string; jitter?: [number, number]; id?: boolean }[];
}

export class History {
  steps: Record<string, unknown>[] = [];
  readonly caseId: string;
  readonly title: string;
  constructor(caseId: string, title: string) {
    this.caseId = caseId;
    this.title = title;
  }
  step(s: { op: string; summary: string; stats: string; image?: string; ms?: number; kernel?: unknown; data?: unknown }) {
    this.steps.push({ n: this.steps.length + 1, ...s });
  }
  /** Kernel journal of a session as history sub-steps. */
  static journal(m: Model) {
    return m.journal.map((j) => ({ opIndex: j.opIndex, op: j.op, label: j.label, status: j.status, roles: j.roles, ...(j.repair === undefined ? {} : { repair: j.repair }), faces: j.faces, vertices: j.vertices, ms: +j.durationMs.toFixed(2), diagnostics: (j.diagnostics ?? []).map((d) => `${d.severity}:${d.message}`) }));
  }
}

export const save = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 1));

// ------------------------------------------------------------------------------ module bake

export interface Module {
  name: string; tile: Dump; tx: number; ty: number; w: number; h: number; z0: number;
  distance: number; aoDistance: number; periodic: 'xy' | 'x' | 'none'; spp: 1 | 4 | 9 | 16;
  pbr: Record<string, Pbr>; opacity?: boolean; detailAngle?: number;
  /** Height encoding [inner, outer] (m along +Z); default symmetric +-distance. POM reads it from bake.json. */
  heightRange?: [number, number];
}
/** Tileable bake of one module + opacity + albedo/ORM + seam metrics + PNG/KTX2. */
export async function bakeModule(mod: Module, dir: string) {
  const b = bakeTile(mod.tile, mod);
  const opacity = mod.opacity ? opacityRaster(mod.tile, mod.tx, mod.ty, mod.w, mod.h) : undefined;
  if (opacity) { dilateUnder(b.normal, opacity, b.w, b.h, 8, [128, 128, 255, 255]); dilateUnder(b.ao, opacity, b.w, b.h, 8, [255, 255, 255, 255]); dilateUnder(b.height, opacity, b.w, b.h, 8, [128, 128, 128, 255]); dilateUnder(b.materialId, opacity, b.w, b.h, 64, [b.materialId[0]!, b.materialId[1]!, b.materialId[2]!, 255]); }
  const { albedo, orm } = compose(b, mod.pbr, opacity);
  const maps: Record<string, Uint8Array> = { normal: b.normal, ao: b.ao, height: b.height, curvature: b.curvature, materialId: b.materialId, albedo, orm };
  if (opacity) maps.opacity = grey(opacity, 1);
  const seams: Record<string, unknown> = {
    normal: seam(b.normal, b.w, b.h), ao: seam(b.ao, b.w, b.h, 1), height: seam(b.height, b.h === b.w ? b.w : b.w, b.h, 1),
    ...(opacity ? { opacity: seam(maps.opacity!, b.w, b.h, 1) } : {}),
  };
  const bytes = await writeMaps(dir, b.w, b.h, maps, { normal: 'linear', albedo: 'srgb', orm: 'linear' });
  const out = { name: mod.name, tile: { tx: mod.tx, ty: mod.ty, w: mod.w, h: mod.h, mmPerTexel: [+(1000 * mod.tx / mod.w).toFixed(3), +(1000 * mod.ty / mod.h).toFixed(3)] }, periodic: mod.periodic, spp: mod.spp,
    distance: mod.distance, heightRange: mod.heightRange ?? [-mod.distance, mod.distance], aoDistance: mod.aoDistance, bakeMs: Math.round(b.ms), detailTris: b.detailTris, tileTris: tris(mod.tile), materials: b.materials, report: b.report, diagnostics: b.diagnostics, seams, bytes, opacity: !!opacity };
  save(join(dir, 'bake.json'), out);
  return out;
}

/**
 * Seam falsifier ("shift test"): bake the same periodic tile with its origin moved by half a tile
 * (so the original borders fall in the middle), roll it back by half and compare per texel.
 * Returns mean abs difference in the 4-texel band along the original borders vs everywhere else:
 * a seamless bake has band ~ rest (sampling noise only); a seam shows band >> rest.
 */
export function shiftCompare(a: Uint8Array, shifted: Uint8Array, w: number, h: number, channels: number, band = 4) {
  let sb = 0, nb = 0, sr = 0, nr = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xs = (x + w / 2) % w, ys = (y + h / 2) % h; // texel x of `a` sits at xs in the shifted bake
    let d = 0;
    for (let c = 0; c < channels; c++) d += Math.abs(a[(y * w + x) * 4 + c]! - shifted[(ys * w + xs) * 4 + c]!);
    d /= channels;
    const inBand = x < band || x >= w - band || y < band || y >= h - band;
    if (inBand) { sb += d; nb++; } else { sr += d; nr++; }
  }
  return { band: +(sb / nb).toFixed(3), rest: +(sr / nr).toFixed(3), ratio: +((sb / nb) / Math.max(1e-6, sr / nr)).toFixed(3) };
}
export function shiftedBake(tile: Dump, o: Parameters<typeof bakeTile>[1]) {
  const N = Math.max(o.w, o.h);
  const detail = replicate(tile, 4, 4, o.tx, o.ty, -1.5 * o.tx, -1.5 * o.ty);
  const base = grid(o.tx, o.ty, 1, 1, o.tx / (o.w / N), o.ty / (o.h / N), 'base', 0, 0, o.z0);
  return bake(base, detail, { N, spp: o.spp, distance: o.distance, aoDistance: o.aoDistance });
}

/**
 * Replace texels under opacity < 50 % by the average of filled neighbours, ring by ring (wrapped),
 * `passes` rings deep; beyond that flat (normal 128,128,255 / ao 255). The kernel's nearest-point
 * fallback in see-through areas would otherwise bleed into the cutout edges through filtering and mips.
 */
export function dilateUnder(img: Uint8Array, opacity: Uint8Array, w: number, h: number, passes: number, fill: number[]) {
  let filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = opacity[i]! >= 128 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = filled.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (filled[i]) continue;
      const acc = [0, 0, 0, 0]; let n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = (((y + dy!) % h + h) % h) * w + (((x + dx!) % w + w) % w); if (filled[j]) { for (let c = 0; c < 4; c++) acc[c]! += img[j * 4 + c]!; n++; } }
      if (n) { for (let c = 0; c < 4; c++) img[i * 4 + c] = Math.round(acc[c]! / n); next[i] = 1; }
    }
    filled = next;
  }
  for (let i = 0; i < w * h; i++) if (!filled[i]) img.set(fill, i * 4);
}
