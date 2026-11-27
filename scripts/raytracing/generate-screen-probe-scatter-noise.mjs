import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// Wolfe et al., Spatiotemporal Blue Noise Masks, EGSR 2022, sections 3.1 and 4.1.
// Wronski et al., Improved Stochastic Texture Filtering Through Sample Reuse,
// HPG 2025, section 4.4: concatenate two independently ranked scalar masks.
const side = 128,
  layers = 64;
const sideMask = side - 1,
  layerMask = layers - 1,
  plane = side * side;
const size = plane * layers;
const output =
  process.argv[2] ??
  new URL(
    '../../packages/render/src/raytracing/screen-probe-scatter-noise-data.ts',
    import.meta.url,
  );

class Heap {
  constructor(size, index, energy, order) {
    this.slots = new Int32Array(size);
    this.count = 0;
    this.index = index;
    this.energy = energy;
    this.order = order;
  }
  key(point) {
    return this.order * this.energy[point];
  }
  first() {
    return this.slots[0];
  }
  up(slot, point) {
    const key = this.key(point);
    while (slot > 0) {
      const parent = (slot - 1) >> 2;
      const current = this.slots[parent];
      if (key >= this.key(current)) break;
      this.slots[slot] = current;
      this.index[current] = slot;
      slot = parent;
    }
    this.slots[slot] = point;
    this.index[point] = slot;
  }
  down(slot, point) {
    const key = this.key(point);
    let first = slot * 4 + 1;
    while (first < this.count) {
      const end = Math.min(first + 4, this.count);
      let child = first;
      let childKey = this.key(this.slots[first]);
      for (let i = first + 1; i < end; i++) {
        const next = this.key(this.slots[i]);
        if (next < childKey) {
          child = i;
          childKey = next;
        }
      }
      if (key <= childKey) break;
      const current = this.slots[child];
      this.slots[slot] = current;
      this.index[current] = slot;
      slot = child;
      first = slot * 4 + 1;
    }
    this.slots[slot] = point;
    this.index[point] = slot;
  }
  push(point) {
    this.up(this.count++, point);
  }
  remove(point) {
    const slot = this.index[point];
    const last = this.slots[--this.count];
    if (slot === this.count) return;
    if (this.key(last) < this.key(point)) this.up(slot, last);
    else this.down(slot, last);
  }
}

const spatial = [],
  temporal = [];
const sigma = 1.9,
  radius = 7;
const weight = (d) => Math.round(2 ** 20 * Math.exp(-d / (2 * sigma * sigma)));
for (let y = -radius; y <= radius; y++) {
  for (let x = -radius; x <= radius; x++) {
    const d = x * x + y * y;
    if (d > 0 && d <= radius * radius) spatial.push([x, y, weight(d)]);
  }
}
for (let t = -radius; t <= radius; t++) {
  if (t !== 0) temporal.push([t, weight(t * t)]);
}

function rankMask(seed, channel, rgba) {
  const energy = new Int32Array(size);
  const index = new Int32Array(size);
  const active = new Uint8Array(size);
  const order = Float64Array.from({ length: size }, (_, i) => i);
  const rank = new Int32Array(size).fill(-1);
  const voids = new Heap(size, index, energy, 1);
  const clusters = new Heap(size, index, energy, -1);
  let state = seed;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const change = (point, delta) => {
    energy[point] += delta;
    const set = active[point] ? clusters : voids;
    if (delta * set.order > 0) set.down(index[point], point);
    else set.up(index[point], point);
  };
  const toggle = (point) => {
    const add = active[point] === 0;
    const current = add ? voids : clusters;
    const next = add ? clusters : voids;
    current.remove(point);
    active[point] = +add;
    next.push(point);
    const sign = add ? 1 : -1;
    const x = point & sideMask;
    const y = (point >> 7) & sideMask;
    const t = point >> 14;
    const layer = t * plane;
    const pixel = point & (plane - 1);
    for (const [dx, dy, w] of spatial) {
      change(layer + ((y + dy) & sideMask) * side + ((x + dx) & sideMask), w * sign);
    }
    for (const [dt, w] of temporal) {
      change(((t + dt) & layerMask) * plane + pixel, w * sign);
    }
  };
  const initialCount = Math.floor(size * 0.1);
  for (let i = 0; i < size; i++) voids.push(i);
  for (let i = 0; i < initialCount; i++) {
    const j = i + (random() % (size - i));
    [order[i], order[j]] = [order[j], order[i]];
    toggle(order[i]);
  }
  let iterations = 0;
  for (;;) {
    const peak = clusters.first();
    toggle(peak);
    const gap = voids.first();
    if (energy[gap] >= energy[peak]) {
      toggle(peak);
      break;
    }
    toggle(gap);
    if (++iterations > size * 8) throw Error('Initial distribution did not settle');
  }
  const seedPattern = active.slice();
  console.log(JSON.stringify({ channel, step: 'seed-relaxed', iterations }));
  for (let i = initialCount - 1; i >= 0; i--) {
    const peak = clusters.first();
    rank[peak] = i;
    toggle(peak);
  }
  for (let i = 0; i < size; i++) if (seedPattern[i]) toggle(i);
  for (let i = initialCount; i < size / 2; i++) {
    const gap = voids.first();
    rank[gap] = i;
    toggle(gap);
  }
  console.log(JSON.stringify({ channel, step: 'lower-half-ranked' }));
  // The complement has energy constant minus current energy: its tightest
  // cluster is the largest remaining void in the original binary pattern.
  for (let i = size / 2; i < size; i++) {
    const gap = voids.first();
    rank[gap] = i;
    toggle(gap);
  }
  const seen = new Uint8Array(size);
  for (let point = 0; point < size; point++) {
    const r = rank[point];
    if (r < 0 || seen[r]++) throw Error('Mask is not a permutation of ranks');
    rgba[point * 2 + channel] = Math.floor((r * 256) / size);
  }
  console.log(JSON.stringify({ channel, step: 'complete' }));
}

const seeds = [0x1b873593, 0x85ebca6b];
const texels = Buffer.alloc(size * 2);
for (const [channel, seed] of seeds.entries()) rankMask(seed, channel, texels);
// UE offsets the ray-direction phase by the mask's half-cycle. Only
// these eight frequently sampled slices need to be shipped to the renderer.
const layerBytes = plane * 2;
const firstLayer = layerMask >> 1;
const table = texels.subarray(firstLayer * layerBytes, (firstLayer + 8) * layerBytes);
const digest = createHash('sha256').update(table).digest('hex');
const segments = table.toString('base64').match(/.{1,96}/g);
writeFileSync(
  output,
  [
    '// Generated by scripts/raytracing/generate-screen-probe-scatter-noise.mjs.',
    '// RG8 source layers 31..38, ordered vertically in an ordinary 2D texture.',
    `// SHA-256 of the decoded bytes: ${digest}`,
    'export const SCREEN_PROBE_SCATTER_NOISE_BASE64 = `',
    ...segments,
    '`;',
    '',
  ].join('\n'),
);
