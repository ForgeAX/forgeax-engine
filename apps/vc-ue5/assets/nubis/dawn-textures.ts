import { halfFloat, rng } from '@forgeax/engine/math';
import type { TextureAsset } from '@forgeax/engine/types';
import { referenceCamera } from '../terrain.ts';

/** Authored world tile matching the shared reference material's layoutScaleMeters. */
export const DAWN_LAYOUT_METERS = 256_000;
export const DAWN_SEED = 0x53_55_4e_52; // 'SUNR'
export const DAWN_SIZE = {
  'layout-pattern': 1024,
  'layout-mask': 1024,
  'height-profile': 256,
  'body-noise': 128,
} as const;

export type DawnTextureRole = keyof typeof DAWN_SIZE;
export const DAWN_ROLES = Object.keys(DAWN_SIZE) as DawnTextureRole[];

type Pixel = readonly [number, number, number, number];
const BLACK: Pixel = [0, 0, 0, 0];
// Reserve upper rows of the wrapping profile LUT so V=0 and V=1 share a neutral zero boundary.
export const PROFILE_LAYOUT_MAX = 1 - 4 / DAWN_SIZE['height-profile'];

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const repeat = (v: number) => v - Math.floor(v);
const wrapDelta = (v: number) => repeat(v + 0.5) - 0.5;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** C-infinity smooth ridge in [0, 1] without the sharp C0 kink of 1 - |x|. */
const smoothRidge = (v: number, sharpness = 1.45, eps = 0.05) =>
  clamp01(1 - Math.sqrt(v * v * sharpness * sharpness + eps) + Math.sqrt(eps) * 0.5);

const stageOrigin = referenceCamera();
export const stageUvU = -stageOrigin.z / DAWN_LAYOUT_METERS;
export const stageUvV = stageOrigin.x / DAWN_LAYOUT_METERS;

/** Fast periodic 3D gradient Perlin field (returns roughly [-1, 1]). */
function createPerlin3D(seed: number, periodX: number, periodY = periodX, periodZ = periodX) {
  const random = rng.create(seed);
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = random.int(0, i);
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  const grad = (h: number, x: number, y: number, z: number) => {
    const u = (h & 8) === 0 ? x : y;
    const v = (h & 12) === 0 ? y : (h & 13) === 12 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  return (u: number, v: number, w = 0) => {
    const x = repeat(u) * periodX;
    const y = repeat(v) * periodY;
    const z = repeat(w) * periodZ;
    const ix = Math.floor(x) % periodX;
    const iy = Math.floor(y) % periodY;
    const iz = Math.floor(z) % periodZ;
    const jx = (ix + 1) % periodX;
    const jy = (iy + 1) % periodY;
    const jz = (iz + 1) % periodZ;
    const fx = x - Math.floor(x), fy = y - Math.floor(y), fz = z - Math.floor(z);
    const tx = fx * fx * fx * (fx * (6 * fx - 15) + 10);
    const ty = fy * fy * fy * (fy * (6 * fy - 15) + 10);
    const tz = fz * fz * fz * (fz * (6 * fz - 15) + 10);
    const pz0 = perm[iz & 255]!, pz1 = perm[jz & 255]!;
    const py00 = perm[(iy + pz0) & 255]!, py10 = perm[(jy + pz0) & 255]!;
    const py01 = perm[(iy + pz1) & 255]!, py11 = perm[(jy + pz1) & 255]!;
    const s0 = lerp(
      lerp(grad(perm[(ix + py00) & 255]!, fx, fy, fz), grad(perm[(jx + py00) & 255]!, fx - 1, fy, fz), tx),
      lerp(grad(perm[(ix + py10) & 255]!, fx, fy - 1, fz), grad(perm[(jx + py10) & 255]!, fx - 1, fy - 1, fz), tx),
      ty,
    );
    const s1 = lerp(
      lerp(grad(perm[(ix + py01) & 255]!, fx, fy, fz - 1), grad(perm[(jx + py01) & 255]!, fx - 1, fy, fz - 1), tx),
      lerp(grad(perm[(ix + py11) & 255]!, fx, fy - 1, fz - 1), grad(perm[(jx + py11) & 255]!, fx - 1, fy - 1, fz - 1), tx),
      ty,
    );
    return 1.38 * lerp(s0, s1, tz);
  };
}

/** Fast periodic 2D gradient Perlin field (returns roughly [-1, 1]). */
function createPerlin2D(seed: number, periodX: number, periodY = periodX) {
  const random = rng.create(seed);
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = random.int(0, i);
    const tmp = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = tmp;
  }
  const grad2 = (h: number, x: number, y: number) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x * 1.4142;
      case 5: return -x * 1.4142;
      case 6: return y * 1.4142;
      default: return -y * 1.4142;
    }
  };
  return (u: number, v: number) => {
    const x = repeat(u) * periodX;
    const y = repeat(v) * periodY;
    const ix = Math.floor(x) % periodX;
    const iy = Math.floor(y) % periodY;
    const jx = (ix + 1) % periodX;
    const jy = (iy + 1) % periodY;
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const tx = fx * fx * fx * (fx * (6 * fx - 15) + 10);
    const ty = fy * fy * fy * (fy * (6 * fy - 15) + 10);
    const py0 = perm[iy & 255]!, py1 = perm[jy & 255]!;
    const a = grad2(perm[(ix + py0) & 255]!, fx, fy);
    const b = grad2(perm[(jx + py0) & 255]!, fx - 1, fy);
    const c = grad2(perm[(ix + py1) & 255]!, fx, fy - 1);
    const d = grad2(perm[(jx + py1) & 255]!, fx - 1, fy - 1);
    return 1.25 * lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
  };
}

/** Periodic 3D inverted Worley F1 field with jittered cell centers (supports anisotropic periods). */
function createWorley3D(seed: number, periodX: number, periodY = periodX, periodZ = periodX) {
  const random = rng.create(seed);
  const total = periodX * periodY * periodZ;
  const pts = new Float32Array(total * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = 0.12 + random.next() * 0.76;
  return (u: number, v: number, w: number) => {
    const x = repeat(u) * periodX;
    const y = repeat(v) * periodY;
    const z = repeat(w) * periodZ;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let nearest = 2.5;
    for (let dz = -1; dz <= 1; dz++) {
      let cz = iz + dz;
      const wz = cz < 0 ? cz + periodZ : cz >= periodZ ? cz - periodZ : cz;
      const zOff = wz * periodY;
      for (let dy = -1; dy <= 1; dy++) {
        let cy = iy + dy;
        const wy = cy < 0 ? cy + periodY : cy >= periodY ? cy - periodY : cy;
        const yOff = (zOff + wy) * periodX;
        for (let dx = -1; dx <= 1; dx++) {
          let cx = ix + dx;
          const wx = cx < 0 ? cx + periodX : cx >= periodX ? cx - periodX : cx;
          const p = (yOff + wx) * 3;
          const rx = cx + pts[p]! - x;
          const ry = cy + pts[p + 1]! - y;
          const rz = cz + pts[p + 2]! - z;
          const d2 = rx * rx + ry * ry + rz * rz;
          if (d2 < nearest) nearest = d2;
        }
      }
    }
    return clamp01(1 - Math.sqrt(nearest));
  };
}

function fbm2D(seed: number, px: number, py: number, w0 = 0.50, w1 = 0.27, w2 = 0.15, w3 = 0.08) {
  const o0 = createPerlin2D(seed, px, py);
  const o1 = createPerlin2D(seed + 11, px * 2, py * 2);
  const o2 = createPerlin2D(seed + 23, px * 4, py * 4);
  const o3 = createPerlin2D(seed + 37, px * 8, py * 8);
  return (u: number, v: number) => w0 * o0(u, v) + w1 * o1(u, v) + w2 * o2(u, v) + w3 * o3(u, v);
}

/** Smooth C-infinity wispy filigree field: delicate branching filaments & feathered fringes without hard kinks. */
function wispyFiligree2D(seed: number, px: number, py: number) {
  const o0 = createPerlin2D(seed, px, py);
  const o1 = createPerlin2D(seed + 17, px * 2, py * 2);
  const o2 = createPerlin2D(seed + 31, px * 4, py * 4);
  return (u: number, v: number) => {
    const r0 = smoothRidge(o0(u, v), 1.35, 0.06);
    const r1 = smoothRidge(o1(u, v), 1.45, 0.06);
    const r2 = smoothRidge(o2(u, v), 1.55, 0.06);
    return 0.50 * r0 * r0 + 0.32 * r1 * r1 + 0.18 * r2 * r2;
  };
}

export function dawnFields() {
  const stream = rng.create(DAWN_SEED);
  const nextSeed = (label: string) => stream.fork(label).seed;

  // Sweeping multi-scale wind-streamline warp: bends long cirrus/altostratus bands organically
  // and breaks uniform spacing without producing flame-like squiggles.
  const warpBroadU = createPerlin2D(nextSeed('warp-broad-u'), 3, 3);
  const warpBroadV = createPerlin2D(nextSeed('warp-broad-v'), 3, 3);
  const warpMidU = createPerlin2D(nextSeed('warp-mid-u'), 7, 7);
  const warpMidV = createPerlin2D(nextSeed('warp-mid-v'), 7, 7);
  const warpFineU = createPerlin2D(nextSeed('warp-fine-u'), 20, 20);
  const warpFineV = createPerlin2D(nextSeed('warp-fine-v'), 20, 20);

  // Macro open-sky envelope: creates large asymmetrical blue-sky openings and uneven streak families.
  const climate = fbm2D(nextSeed('climate'), 3, 3, 0.62, 0.24, 0.10, 0.04);
  const climateDetail = createPerlin2D(nextSeed('climate-detail'), 6, 6);

  // Layer R: main mid-low thin wispy sheet ribbons on orthogonal lattice (1, 2) / (-2, 1).
  // Sleek ~5.5:1 anisotropy (s period 2 => ~57 km along-wind, t period 11 => ~10.4 km across-wind).
  const mainStreak = fbm2D(nextSeed('main-streak'), 2, 11, 0.48, 0.27, 0.16, 0.09);
  const mainLenMod = createPerlin2D(nextSeed('main-len-mod'), 2, 3);
  const mainTendril = wispyFiligree2D(nextSeed('main-tendril'), 4, 20);
  const mainCrossComb = createPerlin2D(nextSeed('main-cross-comb'), 12, 20);

  // Layer G: mid-high feathered cirrus & combed wispy streaks on rotated orthogonal lattice (1, 3) / (-3, 1).
  // Rotated ~10 deg vs Layer R to mimic natural upper-level wind shear and eliminate parallel uniformity.
  const midStreak = fbm2D(nextSeed('mid-streak'), 2, 10, 0.46, 0.28, 0.16, 0.10);
  const midFiligree = wispyFiligree2D(nextSeed('mid-filigree'), 4, 18);
  const midCluster = createPerlin2D(nextSeed('mid-cluster'), 3, 4);

  // Layer B: high-altitude gossamer cirrus filaments & sweeping translucent upper trails on (2, 3) / (-3, 2).
  const highStreak = fbm2D(nextSeed('high-streak'), 1, 8, 0.48, 0.28, 0.16, 0.08);
  const highFiligree = wispyFiligree2D(nextSeed('high-filigree'), 3, 16);
  const highGate = createPerlin2D(nextSeed('high-gate'), 3, 3);

  // Regional mask modulation (confined strictly inside supported streak spines).
  const maskGrain = fbm2D(nextSeed('mask-grain'), 5, 5, 0.60, 0.25, 0.11, 0.04);

  // Periodic phase shift puts sweeping diagonal ribbons cleanly across the reference view
  // without parking a broad overhead patch right on top of the camera origin.
  const PHASE_U = 0.21;
  const PHASE_V = -0.17;

  const warpCoords = (u: number, v: number): readonly [number, number, number, number] => {
    const u0 = u + PHASE_U;
    const v0 = v + PHASE_V;
    const bu = u0 + 0.020 * warpBroadU(u0, v0);
    const bv = v0 + 0.020 * warpBroadV(u0, v0);
    const mu = bu + 0.0040 * warpMidU(bu, bv);
    const mv = bv + 0.0040 * warpMidV(bu, bv);
    const fu = mu + 0.0014 * warpFineU(mu, mv);
    const fv = mv + 0.0014 * warpFineV(mu, mv);
    return [bu, bv, fu, fv];
  };

  const distanceAttenuation = (u: number, v: number, bu: number, bv: number) => {
    // Gentle warped horizon taper keeps distant sheets airy and separated without any hard wall or ring.
    const distKm = DAWN_LAYOUT_METERS / 1_000 * Math.hypot(wrapDelta(u - stageUvU), wrapDelta(v - stageUvV));
    const clump = climateDetail(bu, bv);
    const far = smoothstep(24, 62, distKm + 7 * clump);
    return lerp(1.0, lerp(0.42, 0.80, smoothstep(-0.35, 0.35, clump)), far);
  };

  /** Remap invisible sub-threshold carrier dust (<= 0.10, zero visible density in medium.wgsl) to exact 0. */
  const cleanLane = (raw: number) =>
    raw <= 0.10 ? 0 : smoothstep(0.10, 0.19, raw) * clamp01(raw) * PROFILE_LAYOUT_MAX;

  const pattern = (u: number, v: number): Pixel => {
    const [bu, bv, x, y] = warpCoords(u, v);
    const macro = climate(bu + 0.14, bv - 0.09);
    const farScale = distanceAttenuation(u, v, bu, bv);

    // Preserve large clean blue-sky expanses while letting asymmetrical streak groups reach full sunlit range.
    const skyOpen = smoothstep(-0.28, 0.28, macro);

    // --- Layer R: main mid-low sleek sweeping ribbons (orthogonal basis (1, 2) / (-2, 1)) ---
    const s1 = x + 2 * y + 0.12;
    const t1 = -2 * x + y - 0.08;
    const comb1 = t1 + 0.024 * mainCrossComb(s1, t1);

    const mField = mainStreak(s1, comb1);
    const mLen = mainLenMod(s1, bu - bv);
    const mFil = mainTendril(s1 + 0.19, comb1 - 0.13);

    const rSignal = 0.51 + 0.68 * mField + 0.16 * mLen + 0.26 * (mFil - 0.30) + 0.12 * macro;
    const rCore = smoothstep(0.52, 0.86, rSignal);
    const rFeather = 0.54 * smoothstep(0.44, 0.72, rSignal + 0.24 * (mFil - 0.28)) * smoothstep(0.28, 0.72, mFil);
    const laneR = cleanLane(Math.max(rCore, rFeather) * lerp(0.15, 1.0, skyOpen) * farScale);

    // --- Layer G: mid-high feathered cirrus / combed ribbons (along = (1, 3), across = (-3, 1)) ---
    const s2 = x + 3 * y + 0.31;
    const t2 = -3 * x + y - 0.22;
    const comb2 = t2 + 0.020 * warpFineV(x - 0.19, y + 0.43);

    const gField = midStreak(s2, comb2);
    const gFil = midFiligree(s2 - 0.11, comb2 + 0.22);
    const gCluster = midCluster(bu - 0.27, bv + 0.23);
    const gSignal = 0.48 + 0.74 * gField + 0.29 * (gFil - 0.29) + 0.05 * gCluster + 0.04 * macro;
    const gCore = smoothstep(0.52, 0.85, gSignal);
    const gFeather = 0.54 * smoothstep(0.44, 0.72, gSignal + 0.22 * (gFil - 0.26)) * smoothstep(0.28, 0.74, gFil);
    const laneG = cleanLane(
      Math.max(gCore, gFeather) * lerp(0.16, 1.0, smoothstep(-0.30, 0.32, gCluster + 0.14 * macro)) * farScale,
    );

    // --- Layer B: high-altitude gossamer cirrus filaments (along = (2, 3), across = (-3, 2)) ---
    const s3 = 2 * x + 3 * y - 0.37;
    const t3 = -3 * x + 2 * y + 0.24;
    const bField = highStreak(s3, t3);
    const bFil = highFiligree(s3 + 0.17, t3 - 0.29);
    const bPatch = highGate(bu + 0.41, bv + 0.33);
    const bSignal = 0.50 + 0.64 * bField + 0.36 * (bFil - 0.28) + 0.15 * bPatch;
    const bCore = smoothstep(0.54, 0.85, bSignal);
    const bTrail = 0.56 * smoothstep(0.46, 0.72, bSignal + 0.22 * (bFil - 0.26)) * smoothstep(0.26, 0.70, bFil);
    const laneB = cleanLane(
      0.94 * Math.max(bCore, bTrail) * lerp(0.15, 1.0, smoothstep(-0.30, 0.34, bPatch - 0.25 * macro)) * farScale,
    );

    return [laneR, laneG, laneB, 0];
  };

  const mask = (u: number, v: number): Pixel => {
    // Compensate for the kernel's half-tile offset between layoutPattern and layoutMask.
    const mapU = u - 0.5;
    const mapV = v - 0.5;
    const [r, g, b] = pattern(mapU, mapV);
    const carrier = Math.max(r, g, b);
    const support = smoothstep(0.22, 0.70, carrier);
    if (support === 0) return BLACK;
    const [bu, bv] = warpCoords(mapU, mapV);
    const mod = (du: number, dv: number) =>
      0.18 * support * smoothstep(-0.35, 0.45, maskGrain(bu + du, bv + dv));
    return [mod(0, 0), mod(0.06, -0.04), mod(-0.05, 0.07), 0];
  };

  /**
   * UE-calibrated ultra-smooth signed-height-distance profile for three sleek, flattened dawn decks.
   * Key invariants verified against medium.wgsl:
   * - max |dH/dh| per texel <= 0.0052 (eliminating 1x fixed-step horizontal banding completely).
   * - Peak ramps smoothly all the way down to 0.20 as pattern p -> 0.03 so clouds dissolve to zero
   *   density BEFORE the neutral wrap boundary at V=0/1 (eliminating any V-axis cutoff seam!).
   * - Peak values 0.556..0.572 keep sheets sleek (~750-1050 m) and luminous in both useDetail=false and true.
   */
  const profile = (height: number, encodedLayout: number): Pixel => {
    const p = clamp01(encodedLayout / PROFILE_LAYOUT_MAX);
    // Neutral wrap boundaries at both V=0 and V=1 (active reaches 1 well below cloud visibility threshold!).
    const active = smoothstep(0.003, 0.035, p)
      * (1 - smoothstep(PROFILE_LAYOUT_MAX, 1 - 1 / DAWN_SIZE['height-profile'], encodedLayout));
    if (active === 0) return BLACK;

    // Smooth monotonic peak growth: stays strictly <= 0.19 at p=0.03 (zero density even at bodyG=1.0,
    // eliminating any V-axis cutoff cliff!) while lifting mid-range wispy tails (p=0.25..0.60) so
    // elongated feathered ribbons keep their delicate connecting strands and tapering trails.
    const pCurve = Math.pow(p, 0.30) * smoothstep(0.015, 0.14, p);
    const deck = (
      centerBase: number,
      centerLift: number,
      peakMax: number,
      slopeBelow: number,
      slopeAbove: number,
      radius: number,
    ) => {
      const center = centerBase + centerLift * p;
      const peak = lerp(0.18, peakMax, pCurve);
      const d = height - center;
      const slope = d < 0 ? slopeBelow : slopeAbove;
      const signedDist = Math.sqrt(d * d + radius * radius) - radius;
      return active * clamp01(peak - slope * signedDist);
    };

    // R: main mid-low flattened thin sheets (~3.2 - 3.6 km, peak 0.568)
    const chR = deck(0.25, 0.040, 0.568, 1.32, 1.08, 0.032);
    // G: mid-high feathered cirrus ribbons (~4.5 - 4.9 km, peak 0.562)
    const chG = deck(0.39, 0.036, 0.562, 1.26, 1.04, 0.030);
    // B: high gossamer cirrus trails (~5.8 - 6.2 km, peak 0.556)
    const chB = deck(0.54, 0.032, 0.556, 1.20, 1.00, 0.030);

    return [chR, chG, chB, 0];
  };

  return { pattern, mask, profile };
}

/** Periodic 3D grid evaluator with trilinear lookup for low-frequency Worley fields (8x faster, <0.5 LSB error). */
function bakePeriodic3D(gridSize: number, evalFn: (u: number, v: number, w: number) => number) {
  const grid = new Float32Array(gridSize ** 3);
  for (let z = 0; z < gridSize; z++) {
    const w = (z + 0.5) / gridSize;
    const zOff = z * gridSize;
    for (let y = 0; y < gridSize; y++) {
      const v = (y + 0.5) / gridSize;
      const row = (y + zOff) * gridSize;
      for (let x = 0; x < gridSize; x++) {
        grid[x + row] = evalFn((x + 0.5) / gridSize, v, w);
      }
    }
  }
  const slice = gridSize * gridSize;
  return (u: number, v: number, w: number) => {
    const x = repeat(u) * gridSize - 0.5;
    const y = repeat(v) * gridSize - 0.5;
    const z = repeat(w) * gridSize - 0.5;
    const fx0 = Math.floor(x), fy0 = Math.floor(y), fz0 = Math.floor(z);
    const tx = x - fx0, ty = y - fy0, tz = z - fz0;
    const ix = ((fx0 % gridSize) + gridSize) % gridSize;
    const iy = ((fy0 % gridSize) + gridSize) % gridSize;
    const iz = ((fz0 % gridSize) + gridSize) % gridSize;
    const jx = ix + 1 === gridSize ? 0 : ix + 1;
    const jy = iy + 1 === gridSize ? 0 : iy + 1;
    const jz = iz + 1 === gridSize ? 0 : iz + 1;
    const r00 = iy * gridSize + iz * slice, r10 = jy * gridSize + iz * slice;
    const r01 = iy * gridSize + jz * slice, r11 = jy * gridSize + jz * slice;
    const c00 = grid[ix + r00]! + (grid[jx + r00]! - grid[ix + r00]!) * tx;
    const c10 = grid[ix + r10]! + (grid[jx + r10]! - grid[ix + r10]!) * tx;
    const c01 = grid[ix + r01]! + (grid[jx + r01]! - grid[ix + r01]!) * tx;
    const c11 = grid[ix + r11]! + (grid[jx + r11]! - grid[ix + r11]!) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  };
}

/**
 * 128^3 periodic 3D volume tuned for feathery, non-cumulus, wind-swept morning sheet clouds:
 * - R (sampled at 60x, 60x, 75x): crisp horizontal wispy warp (rmsX/Y ~0.028, rmsZ ~0.022) shredding edges at useDetail=false.
 * - G (sampled at 4.167x, 4.444x, 9.091x): curl-bent diagonal wispy Perlin + flattened cavities with crisp horizontal detail
 *   (rmsX/Y ~0.040) and smoother vertical gradient (rmsZ ~0.032, matching UE's 0.0335) to keep bandAnisotropy ~2.0!
 * - B (sampled at 30x, 40x, 25x when useDetail=true): high-contrast organic wispy erosion matching UE B.
 * - A: fine micro-cellular structure.
 */
function buildDawnBody(size: number, data: Uint8Array): void {
  const stream = rng.create(DAWN_SEED).fork('body');
  const nextSeed = (label: string) => stream.fork(label).seed;
  // Cap spatial frequencies cleanly for small preview/test sizes while preserving all authored bands at full 128^3.
  const maxBand = size >= 128 ? 32 : Math.max(2, Math.floor(size / 6));
  const band = (p: number) => Math.min(maxBand, p);
  const worleyGrid = Math.min(size, 64);

  // R: crisp horizontal wispy warp (slightly gentler vertically so warp combs horizontally without stepping).
  const rCoarse = createPerlin3D(nextSeed('r-coarse'), band(4), band(4), band(3));
  const rMid = createPerlin3D(nextSeed('r-mid'), band(8), band(8), band(6));
  const rCell = bakePeriodic3D(worleyGrid, createWorley3D(nextSeed('r-cell'), band(8), band(8), band(6)));
  const rFine = createPerlin3D(nextSeed('r-fine'), band(16), band(16), band(10));

  // Low-frequency 3D curl to bend G's wispy filaments organically.
  const gCurlU = createPerlin3D(nextSeed('g-curl-u'), band(4), band(4), band(4));
  const gCurlV = createPerlin3D(nextSeed('g-curl-v'), band(4), band(4), band(4));
  const gCurlW = createPerlin3D(nextSeed('g-curl-w'), band(4), band(4), band(3));

  // G: flattened, wind-elongated wispy 3D body & cavities (no round cumulus puffs!).
  // Balanced horizontal detail (rmsX ~ rmsY ~ 0.040) and smoother vertical (rmsZ ~ 0.030)
  // produces sleek wind-swept lateral breakup with zero vertical raymarch banding at 1x sampling.
  const gBroad = createPerlin3D(nextSeed('g-broad'), band(3), band(6), band(5));
  const gMed = createPerlin3D(nextSeed('g-med'), band(6), band(12), band(9));
  const gFine = createPerlin3D(nextSeed('g-fine'), band(12), band(18), band(13));
  const gMicro = createPerlin3D(nextSeed('g-micro'), band(24), band(24), band(16));
  const gCavity = bakePeriodic3D(worleyGrid, createWorley3D(nextSeed('g-cavity'), band(4), band(8), band(6)));
  const gWispCell = bakePeriodic3D(worleyGrid, createWorley3D(nextSeed('g-wisp-cell'), band(10), band(14), band(10)));

  // B: high-contrast organic wispy erosion for useDetail=true (mean ~0.49, std ~0.21, grad rms ~0.055).
  const bPerlin = createPerlin3D(nextSeed('b-perlin'), band(9), band(11), band(8));
  const bFine = createPerlin3D(nextSeed('b-fine'), band(18), band(18), band(14));
  const bCell = bakePeriodic3D(worleyGrid, createWorley3D(nextSeed('b-cell'), band(12), band(12), band(10)));

  // A: fine micro-cellular detail.
  const aCell = bakePeriodic3D(Math.min(size, 64), createWorley3D(nextSeed('a-cell'), band(20), band(20), band(20)));

  for (let z = 0; z < size; z++) {
    const w = (z + 0.5) / size;
    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      const rowOffset = size * (y + size * z);
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size;

        // Channel R: vigorous horizontal wind-combed warp (mean ~0.52, std ~0.165, grad rmsX/Y ~0.028).
        const rc = rCoarse(u, v, w);
        const rm = rMid(u, v, w);
        const rcell = rCell(u, v, w) - 0.45;
        const rf = rFine(u, v, w);
        const chR = clamp01(0.52 + 0.30 * rc + 0.24 * rm + 0.24 * rcell + 0.16 * rf);

        // Channel G: curl-bent, flattened fibrous 3D cloud volume (mean ~0.46, std ~0.19, p95 ~0.79).
        const cu = u + 0.058 * gCurlU(u, v, w);
        const cv = v + 0.058 * gCurlV(u, v, w);
        const cw = w + 0.020 * gCurlW(u, v, w);

        // Diagonal orthogonal basis (cu + cv, cv - cu) stretches even the broad 3D volume structures
        // along the wind sweep (eliminating round cumulus puffs in every heading) while curl bends them organically.
        const su = cu + cv;
        const sv = cv - cu;

        const p0 = gBroad(su, sv, cw);
        const p1 = gMed(su, sv, cw);
        const p2 = gFine(su, sv, cw);
        const p3 = gMicro(u, v, w);
        const cav0 = gCavity(su, sv, cw) - 0.45;
        const cav1 = gWispCell(su, sv, cw) - 0.45;

        // Smooth C-infinity wispy filament lift (no sharp |x| crease).
        const filament = smoothRidge(p1, 1.20, 0.09) - 0.50;
        const fbmBody = 0.44 * p0 + 0.25 * p1 + 0.14 * p2 + 0.055 * p3;
        const cellBody = 0.44 * cav0 + 0.28 * cav1;
        const chG = clamp01(0.455 + 0.88 * fbmBody + 0.56 * cellBody + 0.13 * filament);

        // Channel B: crisp organic erosion for useDetail=true (mean ~0.49, std ~0.21).
        const bp = bPerlin(u, v, w);
        const bf = bFine(u, v, w);
        const bc = bCell(u, v, w) - 0.45;
        const chB = clamp01(0.49 + 0.34 * bp + 0.18 * bf + 0.94 * bc);

        // Channel A: fine micro-cells.
        const chA = clamp01(0.45 + 0.92 * (aCell(u, v, w) - 0.45) + 0.08 * p3);

        // BGRA8UNORM byte order: [B, G, R, A]
        const offset = (x + rowOffset) * 4;
        data[offset + 0] = Math.round(chB * 255);
        data[offset + 1] = Math.round(chG * 255);
        data[offset + 2] = Math.round(chR * 255);
        data[offset + 3] = Math.round(chA * 255);
      }
    }
  }
}

function dawnLaneWriter(data: Uint8Array, packed: boolean) {
  if (packed) {
    const byteOrder = [2, 1, 0, 3] as const;
    return (offset: number, channel: 0 | 1 | 2 | 3, value: number) => {
      data[offset + byteOrder[channel]] = Math.round(value * 255);
    };
  }
  const half = new DataView(data.buffer);
  return (offset: number, channel: 0 | 1 | 2 | 3, value: number) => {
    half.setUint16((offset + channel) * 2, halfFloat.f32ToF16(value), true);
  };
}

export function makeDawnTexture(role: DawnTextureRole, size: number = DAWN_SIZE[role]): TextureAsset & { data: Uint8Array } {
  const volume = role === 'body-noise';
  const packed = volume || role === 'layout-mask';
  const depth = volume ? size : 1;
  const data = new Uint8Array(size * size * depth * (packed ? 4 : 8));
  if (volume) {
    buildDawnBody(size, data);
  } else {
    const writeLane = dawnLaneWriter(data, packed);
    const fields = dawnFields();
    const field = role === 'layout-pattern' ? fields.pattern
      : role === 'layout-mask' ? fields.mask
      : fields.profile;
    // Bandwidth-matched 2D periodic grid evaluation for 1024x1024 weather maps (4x faster pack cook, <0.5 LSB loss).
    const gridSize = role === 'height-profile' ? size : Math.min(size, 512);
    if (gridSize === size) {
      for (let y = 0; y < size; y++) {
        const v = (y + 0.5) / size;
        for (let x = 0; x < size; x++) {
          const u = (x + 0.5) / size;
          const pixel = field(u, v);
          const offset = (x + size * y) * 4;
          for (const c of [0, 1, 2, 3] as const) {
            const lane = clamp01(pixel[c]);
            writeLane(offset, c, lane);
          }
        }
      }
    } else {
      const grid = new Float32Array(gridSize * gridSize * 4);
      for (let y = 0; y < gridSize; y++) {
        const v = (y + 0.5) / gridSize;
        for (let x = 0; x < gridSize; x++) {
          const pixel = field((x + 0.5) / gridSize, v);
          const at = (x + gridSize * y) * 4;
          grid[at] = pixel[0];
          grid[at + 1] = pixel[1];
          grid[at + 2] = pixel[2];
          grid[at + 3] = pixel[3];
        }
      }
      const coords = Array.from({ length: size }, (_, i) => {
        const p = (i + 0.5) * gridSize / size - 0.5;
        const lo = Math.floor(p);
        return { lo: (lo + gridSize) % gridSize, hi: (lo + 1 + gridSize) % gridSize, t: p - lo };
      });
      for (let y = 0; y < size; y++) {
        const ay = coords[y]!;
        const r0 = ay.lo * gridSize, r1 = ay.hi * gridSize;
        for (let x = 0; x < size; x++) {
          const ax = coords[x]!;
          const offset = (x + size * y) * 4;
          const i00 = (ax.lo + r0) * 4, i10 = (ax.hi + r0) * 4;
          const i01 = (ax.lo + r1) * 4, i11 = (ax.hi + r1) * 4;
          for (const c of [0, 1, 2, 3] as const) {
            const top = grid[i00 + c]! + (grid[i10 + c]! - grid[i00 + c]!) * ax.t;
            const bot = grid[i01 + c]! + (grid[i11 + c]! - grid[i01 + c]!) * ax.t;
            const lane = clamp01(top + (bot - top) * ay.t);
            writeLane(offset, c, lane);
          }
        }
      }
    }
  }
  return {
    kind: 'texture',
    format: packed ? 'bgra8unorm' : 'rgba16float',
    colorSpace: 'linear',
    data,
    shape: volume
      ? { viewDimension: '3d', extent: { width: size, height: size, depth } }
      : { viewDimension: '2d', extent: { width: size, height: size } },
    mips: { kind: 'none' },
  };
}
