// Deterministic software rasterizer: orthographic z-buffer triangles, soft depth-tested lines and
// markers, 2x supersampled. Pure TypeScript (no GPU, no browser), so output is byte-stable.

import { type ViewBasis, type ViewSpec, viewBasis } from './camera.ts';
import { createImage, type Image, type RGB, resize } from './image.ts';
import { type P3, type Scene, sceneBounds } from './scene.ts';

export interface RenderOptions {
  /** Output width and height in pixels (default 640). */
  readonly size?: number;
  /** Supersampling factor per axis (default 2). */
  readonly supersample?: number;
  readonly background?: RGB;
  /** Fraction of the image the model spans (default 0.86). */
  readonly fill?: number;
  /** Depth tolerance for lines against surfaces, as a fraction of the model diagonal (default 0.004). */
  readonly depthBias?: number;
  /** Tint mixed into back faces so open shells and holes read (default blue-grey). */
  readonly backTint?: RGB;
}

const DEFAULT_BACKGROUND: RGB = [24, 27, 34];
const DEFAULT_TINT: RGB = [70, 100, 150];
const LIGHT: P3 = [-0.35, 0.55, 0.75];

interface Frame {
  readonly basis: ViewBasis;
  readonly scale: number;
  readonly cx: number;
  readonly cy: number;
  readonly half: number;
  readonly bias: number;
}

interface Screen {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function dot(a: P3, b: P3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function project(frame: Frame, p: P3): Screen {
  const { basis } = frame;
  return {
    x: frame.half + (dot(p, basis.right) - frame.cx) * frame.scale,
    y: frame.half - (dot(p, basis.up) - frame.cy) * frame.scale,
    z: dot(p, basis.toward),
  };
}

function fitFrame(scene: Scene, basis: ViewBasis, hi: number, options: RenderOptions): Frame {
  const bounds = sceneBounds(scene);
  const min = bounds?.min ?? [0, 0, 0];
  const max = bounds?.max ?? [1, 1, 1];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const corner: P3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const px = dot(corner, basis.right);
    const py = dot(corner, basis.up);
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
  }
  const diag = Math.sqrt(
    (max[0] - min[0]) * (max[0] - min[0]) +
      (max[1] - min[1]) * (max[1] - min[1]) +
      (max[2] - min[2]) * (max[2] - min[2]),
  );
  // The projected bound of an axis-aligned box over-covers a rotated model slightly; that margin is intended.
  const span = Math.max(x1 - x0, y1 - y0, 1e-12);
  return {
    basis,
    scale: (hi * (options.fill ?? 0.86)) / span,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    half: hi / 2,
    bias: Math.max(diag, 1e-12) * (options.depthBias ?? 0.004),
  };
}

interface Buffers {
  readonly image: Image;
  readonly depth: Float32Array;
}

function shadeTri(a: P3, b: P3, c: P3, base: RGB, basis: ViewBasis, tint: RGB): RGB {
  const e1: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: P3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: P3 = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const l = Math.sqrt(dot(n, n));
  if (l === 0) return base;
  const view: P3 = [dot(n, basis.right) / l, dot(n, basis.up) / l, dot(n, basis.toward) / l];
  const back = view[2] < 0;
  const s = back ? -1 : 1;
  const ll = Math.sqrt(dot(LIGHT, LIGHT));
  const lambert = Math.max(0, (s * dot(view, LIGHT)) / ll);
  const k = 0.34 + 0.66 * lambert;
  const mix = back ? 0.35 : 0;
  const k2 = back ? k * 0.8 : k;
  return [
    Math.round((base[0] * (1 - mix) + tint[0] * mix) * k2),
    Math.round((base[1] * (1 - mix) + tint[1] * mix) * k2),
    Math.round((base[2] * (1 - mix) + tint[2] * mix) * k2),
  ];
}

function fillTri(buf: Buffers, p0: Screen, p1: Screen, p2: Screen, c: RGB): void {
  const { width, height, rgba } = buf.image;
  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  const eps = -1e-7;
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((p1.x - px) * (p2.y - py) - (p2.x - px) * (p1.y - py)) / area;
      const w1 = ((p2.x - px) * (p0.y - py) - (p0.x - px) * (p2.y - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      const z = w0 * p0.z + w1 * p1.z + w2 * p2.z;
      const o = y * width + x;
      if (z <= (buf.depth[o] as number)) continue;
      buf.depth[o] = z;
      rgba[o * 4] = c[0];
      rgba[o * 4 + 1] = c[1];
      rgba[o * 4 + 2] = c[2];
    }
}

function blend(buf: Buffers, o: number, c: RGB, alpha: number): void {
  const { rgba } = buf.image;
  rgba[o * 4] = Math.round((rgba[o * 4] as number) * (1 - alpha) + c[0] * alpha);
  rgba[o * 4 + 1] = Math.round((rgba[o * 4 + 1] as number) * (1 - alpha) + c[1] * alpha);
  rgba[o * 4 + 2] = Math.round((rgba[o * 4 + 2] as number) * (1 - alpha) + c[2] * alpha);
}

/** Soft capsule: coverage falls off over one supersampled pixel; hidden pixels are skipped unless `xray`. */
function drawSegment(
  buf: Buffers,
  a: Screen,
  b: Screen,
  half: number,
  c: RGB,
  bias: number,
  xray: boolean,
  dash: readonly [number, number] | undefined,
  arc: number,
): number {
  const { width, height } = buf.image;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  const r = half + 1;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - r));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + r));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - r));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + r));
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - a.x;
      const py = y + 0.5 - a.y;
      const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
      const ex = px - t * dx;
      const ey = py - t * dy;
      const dist = Math.sqrt(ex * ex + ey * ey);
      const coverage = Math.min(1, half + 0.5 - dist);
      if (coverage <= 0) continue;
      if (dash !== undefined) {
        const s = (arc + t * len) % (dash[0] + dash[1]);
        if (s >= dash[0]) continue;
      }
      const o = y * width + x;
      const z = a.z + (b.z - a.z) * t + bias;
      const hidden = z < (buf.depth[o] as number);
      if (hidden && !xray) continue;
      blend(buf, o, c, hidden ? coverage * 0.35 : coverage);
    }
  return arc + len;
}

function drawMarker(
  buf: Buffers,
  p: Screen,
  radius: number,
  c: RGB,
  ring: boolean,
  bias: number,
): void {
  const { width, height } = buf.image;
  const r = radius + 1;
  for (let y = Math.max(0, Math.floor(p.y - r)); y <= Math.min(height - 1, Math.ceil(p.y + r)); y++)
    for (
      let x = Math.max(0, Math.floor(p.x - r));
      x <= Math.min(width - 1, Math.ceil(p.x + r));
      x++
    ) {
      const ddx = x + 0.5 - p.x;
      const ddy = y + 0.5 - p.y;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      const coverage = ring
        ? Math.min(1, 1.2 - Math.abs(dist - radius + 0.6))
        : Math.min(1, radius + 0.5 - dist);
      if (coverage <= 0) continue;
      const o = y * width + x;
      if (p.z + bias < (buf.depth[o] as number)) continue;
      blend(buf, o, c, coverage);
    }
}

/** Renders `scene` from `view` into a square image. */
export function renderScene(scene: Scene, view: ViewSpec, options: RenderOptions = {}): Image {
  const size = options.size ?? 640;
  const ss = options.supersample ?? 2;
  const hi = size * ss;
  const frame = fitFrame(scene, viewBasis(view), hi, options);
  const buf: Buffers = {
    image: createImage(hi, hi, options.background ?? DEFAULT_BACKGROUND),
    depth: new Float32Array(hi * hi).fill(Number.NEGATIVE_INFINITY),
  };
  const tint = options.backTint ?? DEFAULT_TINT;
  for (const t of scene.tris) {
    const colour = t.unlit === true ? t.color : shadeTri(t.a, t.b, t.c, t.color, frame.basis, tint);
    fillTri(buf, project(frame, t.a), project(frame, t.b), project(frame, t.c), colour);
  }
  for (const l of scene.lines) {
    const pts = l.points.map((p) => project(frame, p));
    const dash = l.dash === undefined ? undefined : ([l.dash[0] * ss, l.dash[1] * ss] as const);
    let arc = 0;
    for (let i = 0; i + 1 < pts.length; i++)
      arc = drawSegment(
        buf,
        pts[i] as Screen,
        pts[i + 1] as Screen,
        (l.width * ss) / 2,
        l.color,
        frame.bias * (l.bias ?? 1),
        l.xray === true,
        dash,
        arc,
      );
  }
  for (const m of scene.markers)
    drawMarker(buf, project(frame, m.p), m.radius * ss, m.color, m.ring === true, frame.bias);
  return ss === 1 ? buf.image : resize(buf.image, size, size);
}
