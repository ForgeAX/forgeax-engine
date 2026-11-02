// Pixel segmentation of the maid-whale turnaround: background model, color classes,
// view frames and masks. Pure functions over decoded RGBA; no image data leaves here.

/** Rows below this line hold the view captions, never the subject. */
export const CAPTION_ROW = 648;

export function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max > 0 ? d / max : 0, max / 255];
}

/**
 * Closed color classes. The backdrop and its floor shadow, down to the dark contact
 * shadow under the soles, are neutral gray (spread <= 6, value 40..236); every cloth
 * white is warm and every dark cloth saturated, so neither matches.
 */
export const CLASSES = ['bg', 'white', 'skin', 'navy', 'hair', 'light', 'gold', 'gem', 'dark', 'other'];

export function classify(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min <= 6 && max >= 40 && max <= 236) return 'bg';
  const [h, s, v] = hsv(r, g, b);
  if (v < 0.16) return 'dark';
  if (h >= 10 && h <= 50 && s > 0.12 && s < 0.5 && v > 0.6) return 'skin';
  if (s < 0.16 && v > 0.6) return 'white';
  if (h >= 30 && h <= 60 && s >= 0.4) return 'gold';
  if (h >= 165 && h < 195 && s > 0.35 && v > 0.45) return 'gem';
  if (h >= 190 && h <= 260) {
    // Navy cloth stays under half value even where lit; hair is brighter.
    if (v < 0.5 && s > 0.35) return 'navy';
    if (h < 212 && v > 0.6) return 'light';
    return 'hair';
  }
  return 'other';
}

/** Per-pixel class index map plus the foreground mask (caption rows excluded). */
export function classMap(image) {
  const { width, height, rgba } = image;
  const cls = new Uint8Array(width * height);
  const fg = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const c = classify(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    cls[i] = CLASSES.indexOf(c);
    fg[i] = c !== 'bg' && Math.floor(i / width) < CAPTION_ROW ? 1 : 0;
  }
  return { cls, fg };
}

function components(mask, width, height, value) {
  const label = new Int32Array(width * height).fill(-1);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (mask[start] !== value || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    let border = false;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop();
      size++;
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
      for (const q of [p - 1, p + 1, p - width, p + width]) {
        if (q < 0 || q >= width * height) continue;
        if (Math.abs((q % width) - x) > 1) continue;
        if (mask[q] === value && label[q] < 0) {
          label[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push({ size, border });
  }
  return { label, sizes };
}

/**
 * Cleaned silhouette mask: foreground specks under `minIsland` px are dropped and
 * enclosed background pockets under `maxHole` px (anti-aliasing leaks inside white
 * cloth) are filled; larger enclosed gaps stay open, they are real.
 */
export function cleanMask(fg, width, height, { minIsland = 40, maxHole = 160 } = {}) {
  const out = Uint8Array.from(fg);
  const islands = components(out, width, height, 1);
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 1 && islands.sizes[islands.label[i]].size < minIsland) out[i] = 0;
  }
  const holes = components(out, width, height, 0);
  for (let i = 0; i < out.length; i++) {
    const hole = holes.sizes[holes.label[i]];
    if (out[i] === 0 && !hole.border && hole.size < maxHole) out[i] = 1;
  }
  return out;
}

/** Column runs that contain foreground: the three view frames, left to right. */
export function viewFrames(mask, width, height, minWidth = 40) {
  const runs = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    let any = false;
    if (x < width) for (let y = 0; y < height && !any; y++) any = mask[y * width + x] === 1;
    if (any && start < 0) start = x;
    if (!any && start >= 0) {
      if (x - start >= minWidth) runs.push([start, x - 1]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Pixels of `classes` inside `rect` = [x0, y0, x1, y1] (inclusive): bounds counting
 * only rows/columns with at least `min` hits, so anti-aliased fringes do not set an
 * extreme. Returns null when nothing qualifies.
 */
export function classBounds(map, width, rect, classes, min = 2) {
  const want = new Set(classes.map((c) => CLASSES.indexOf(c)));
  const [x0, y0, x1, y1] = rect;
  const rows = new Map();
  const cols = new Map();
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (map.fg[i] !== 1 || !want.has(map.cls[i])) continue;
      rows.set(y, (rows.get(y) ?? 0) + 1);
      cols.set(x, (cols.get(x) ?? 0) + 1);
      count++;
      sx += x;
      sy += y;
    }
  }
  const ys = [...rows].filter(([, n]) => n >= min).map(([y]) => y);
  const xs = [...cols].filter(([, n]) => n >= min).map(([x]) => x);
  if (ys.length === 0 || xs.length === 0) return null;
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
    count,
    cx: sx / count,
    cy: sy / count,
  };
}

/** Median sRGB of the pixels of `classes` inside `rect`. */
export function medianColor(image, map, rect, classes) {
  const want = new Set(classes.map((c) => CLASSES.indexOf(c)));
  const [x0, y0, x1, y1] = rect;
  const channels = [[], [], []];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * image.width + x;
      if (map.fg[i] !== 1 || !want.has(map.cls[i])) continue;
      for (let k = 0; k < 3; k++) channels[k].push(image.rgba[i * 4 + k]);
    }
  }
  if (channels[0].length === 0) return null;
  const median = (values) => {
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  return { srgb: channels.map(median), pixels: channels[0].length };
}

/**
 * Outer boundary of the largest connected silhouette inside the column range, traced
 * on pixel corners (crack following), so the polygon encloses exactly the mask area.
 * Returns corner points in image pixels, counter-clockwise on screen (y down).
 */
export function traceOutline(mask, width, height, [c0, c1]) {
  const local = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = c0; x <= c1; x++) local[y * width + x] = mask[y * width + x];
  }
  const { label, sizes } = components(local, width, height, 1);
  let best = -1;
  for (let i = 0; i < sizes.length; i++) if (best < 0 || sizes[i].size > sizes[best].size) best = i;
  const inside = (x, y) =>
    x >= 0 && y >= 0 && x < width && y < height && label[y * width + x] === best;
  let start = -1;
  for (let i = 0; i < width * height && start < 0; i++) if (label[i] === best) start = i;
  const sx = start % width;
  const sy = (start - sx) / width;
  // Walk corners keeping the region on the left (screen coordinates, y down).
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const leftPixel = (x, y, d) => {
    // Pixel to the left of the directed corner edge (x, y) -> (x + dx, y + dy).
    if (d === 0) return [x, y - 1];
    if (d === 1) return [x, y];
    if (d === 2) return [x - 1, y];
    return [x - 1, y - 1];
  };
  const rightPixel = (x, y, d) => {
    if (d === 0) return [x, y];
    if (d === 1) return [x - 1, y];
    if (d === 2) return [x - 1, y - 1];
    return [x, y - 1];
  };
  // The top edge of the first pixel, walked right-to-left, has the region below = on its left.
  let x = sx + 1;
  let y = sy;
  let d = 2;
  const points = [];
  const limit = 4 * width * height;
  for (let step = 0; step < limit; step++) {
    points.push([x, y]);
    x += dirs[d][0];
    y += dirs[d][1];
    // Prefer turning left, then straight, then right, keeping region left / empty right.
    for (const turn of [3, 0, 1, 2]) {
      const nd = (d + turn) % 4;
      const [lx, ly] = leftPixel(x, y, nd);
      const [rx, ry] = rightPixel(x, y, nd);
      if (inside(lx, ly) && !inside(rx, ry)) {
        d = nd;
        break;
      }
    }
    if (x === sx + 1 && y === sy && d === 2) break;
  }
  const area = sizes[best].size;
  return { points, area };
}

/** Closed Douglas-Peucker in pixels. */
export function simplifyClosed(points, tolerance) {
  const n = points.length;
  const dist = (p, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  let far = 0;
  let farD = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Set([0, far]);
  const stack = [
    [0, far],
    [far, n],
  ];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    let worst = -1;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = dist(points[i], points[a % n], points[b % n]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep.add(index);
      stack.push([a, index], [index, b]);
    }
  }
  return [...keep].sort((p, q) => p - q).map((i) => points[i]);
}

/** Area of a closed polygon (absolute). */
export function polygonArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** sRGB 0..255 to linear 0..1. */
export function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Mask of the union of `{ rect, classes }` terms over the cleaned foreground. */
export function termMask(map, width, height, termList) {
  const out = new Uint8Array(width * height);
  for (const { rect, classes } of termList) {
    const want = new Set(classes.map((c) => CLASSES.indexOf(c)));
    const [x0, y0, x1, y1] = rect;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        if (map.fg[i] === 1 && want.has(map.cls[i])) out[i] = 1;
      }
    }
  }
  return out;
}

/** Morphological closing (square kernel of radius `r`): bridges gaps narrower than 2r. */
export function closeMask(mask, width, height, r) {
  if (r <= 0) return mask;
  const pass = (src, grow) => {
    const tmp = new Uint8Array(src.length);
    const out = new Uint8Array(src.length);
    const hit = (v) => (grow ? v === 1 : v === 0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let any = false;
        for (let k = -r; k <= r && !any; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < width) any = hit(src[y * width + xx]);
        }
        tmp[y * width + x] = grow ? (any ? 1 : 0) : any ? 0 : 1;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let any = false;
        for (let k = -r; k <= r && !any; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < height) any = hit(tmp[yy * width + x]);
        }
        out[y * width + x] = grow ? (any ? 1 : 0) : any ? 0 : 1;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}
