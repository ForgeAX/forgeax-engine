import { type Model, type Point2, recipes, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { cables, chamferRect, check, greebles, has, hose, hub, type Level, plate, ram, session, strut } from './kit.ts';

/**
 * Case C-410: an original ~3.5 m heavy bipedal mech (code name "Warden"), chunky faceted
 * armor slabs (orange paint over gunmetal) layered over an exposed dark frame. Y up,
 * facing +Z, ground at y = 0. The right-side limbs are built at +X and mirrored to -X
 * after export; the core parts are unique. Each group is one bake group: its `low` build is
 * the receiver, its `high` build the detail source baked onto it.
 */
export type GroupName = 'weapon' | 'torso' | 'pelvis' | 'head' | 'backpack' | 'pauldron-r' | 'pauldron-l' | 'upperarm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'foot';
export interface Group {
  readonly name: GroupName;
  /**
   * Texture set (2048 atlas) the group's UVs pack into; groups are balanced so the three sets
   * reach about the same texel density (about 395 px/m, within 5 %).
   */
  readonly set: 'set1' | 'set2' | 'set3';
  /** Built at +X and mirrored to -X (sharing the texels). */
  readonly mirrored: boolean;
  /** Forward hunch in degrees about the waist (x axis through WAIST), applied after the build. */
  readonly lean?: number;
  readonly build: (l: Level) => Model;
}

/** The upper body leans forward about this point: a heavy, hunched stance. */
export const WAIST: Tuple3 = [0, 2.12, 0];
const LEAN = 9;

const HIP: Tuple3 = [0.37, 1.95, 0];
const KNEE: Tuple3 = [0.44, 1.08, 0.1];
const ANKLE: Tuple3 = [0.47, 0.3, 0];
const SHOULDER: Tuple3 = [0.9, 2.86, 0.02];
const ELBOW: Tuple3 = [1.0, 2.28, 0.1];
const WRIST: Tuple3 = [1.02, 1.74, 0.3];

const sub = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Tuple3, b: Tuple3): Tuple3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mid = (a: Tuple3, b: Tuple3, t = 0.5): Tuple3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mirrorX = (pts: readonly Point2[]): Point2[] => pts.map(([x, y]) => [-x, y] as Point2).reverse();
/** Octagonal slab outline: w x h from y0 up, corner cuts c (top) and d (bottom). */
const oct = (w: number, h: number, c: number, d = c, y0 = -h): Point2[] => [[-w / 2 + d, y0], [w / 2 - d, y0], [w / 2, y0 + d], [w / 2, y0 + h - c], [w / 2 - c, y0 + h], [-w / 2 + c, y0 + h], [-w / 2, y0 + h - c], [-w / 2, y0 + d]];

// ------------------------------------------------------------------------------------ legs

function thigh(l: Level): Model {
  const m = session();
  hub(m, { radius: 0.15, width: 0.28, axis: 'x', at: HIP }, l);
  const up = sub(HIP, KNEE);
  strut(m, { size: [0.2, 0.74, 0.2], place: { n: [0, 0, 1], up, at: mid(HIP, KNEE, 0.52) }, ribs: 3 }, l);
  plate(m, {
    scale: 1.22,
    outline: oct(0.42, 0.68, 0.07, 0.09, -0.66),
    thick: 0.09,
    raised: { inset: 0.045, height: 0.014, material: 'accent' },
    vents: [{ rect: [-0.12, -0.56, 0.12, -0.42] }],
    glow: [[0.13, -0.38, 0.145, -0.16]],
    bolts: [[-0.17, -0.02], [0.17, -0.02], [-0.16, -0.6], [0.16, -0.6]],
    layers: [{ outline: oct(0.2, 0.2, 0.03, 0.03, -0.32), thick: 0.016, material: 'accent', chevrons: [{ rect: [-0.07, -0.2, 0.07, -0.16], stripes: 4 }], bolts: [[-0.07, -0.29], [0.07, -0.29]] }],
    place: { n: [0, -0.06, 1], up, at: [HIP[0] + 0.01, HIP[1] - 0.1, 0.1] },
  }, l);
  plate(m, {
    scale: 1.22,
    outline: oct(0.36, 0.62, 0.06, 0.08, -0.6),
    thick: 0.06,
    grilles: [{ rect: [0.02, -0.46, 0.13, -0.14], cols: 6, rows: 16 }],
    vents: [{ rect: [-0.13, -0.5, -0.02, -0.3], slats: 7 }],
    glow: [[-0.12, -0.24, -0.105, -0.08]],
    chevrons: [{ rect: [-0.13, -0.57, 0.13, -0.53], stripes: 7 }],
    place: { n: [1, 0, 0], up, at: [HIP[0] + 0.1, HIP[1] - 0.1, 0] },
  }, l);
  plate(m, {
    scale: 1.22,
    outline: oct(0.3, 0.5, 0.05),
    thick: 0.055, material: 'accent',
    vents: [{ rect: [-0.09, -0.36, 0.09, -0.18], slats: 7 }],
    place: { n: [-1, 0, 0.1], up, at: [HIP[0] - 0.1, HIP[1] - 0.18, 0] },
  }, l);
  plate(m, {
    scale: 1.22,
    outline: oct(0.36, 0.48, 0.06),
    thick: 0.09,
    grilles: [{ rect: [-0.12, -0.3, 0.12, -0.14], cols: 14, rows: 8 }],
    layers: [{ outline: oct(0.26, 0.1, 0.02, 0.02, -0.44), thick: 0.015, material: 'accent' }],
    place: { n: [0, 0, -1], up, at: [HIP[0], HIP[1] - 0.12, -0.1] },
  }, l);
  plate(m, {
    outline: oct(0.4, 0.22, 0.05, 0.03, -0.2),
    thick: 0.05, material: 'accent',
    vents: [{ rect: [-0.14, -0.16, 0.14, -0.06], slats: 4 }],
    place: { n: [0, 0.25, 1], up, at: [HIP[0] + 0.01, HIP[1] + 0.06, 0.2] },
  }, l);
  for (const dz of [-0.05, 0.05]) hose(m, { points: [[HIP[0] - 0.2, HIP[1] + 0.08, -0.06 + dz], [HIP[0] - 0.16, HIP[1] - 0.25, -0.18 + dz], [HIP[0] - 0.13, KNEE[1] + 0.35, -0.2 + dz], [KNEE[0] - 0.12, KNEE[1] + 0.06, -0.12 + dz]], radius: 0.022, rings: 3 }, l);
  cables(m, { points: [[HIP[0] + 0.165, HIP[1] - 0.18, 0.12], [HIP[0] + 0.168, HIP[1] - 0.4, 0.12], [HIP[0] + 0.165, HIP[1] - 0.62, 0.11]], radius: 0.007, n: 4, spread: [0, 0, 0.0145] }, l);
  return m;
}

function shin(l: Level): Model {
  const m = session();
  hub(m, { radius: 0.15, width: 0.32, axis: 'x', at: KNEE }, l);
  strut(m, { size: [0.18, 0.72, 0.18], place: { n: [0, 0, 1], up: sub(KNEE, ANKLE), at: mid(KNEE, ANKLE, 0.5) }, ribs: 3 }, l);
  plate(m, {
    scale: 1.12,
    outline: [[-0.16, -0.12], [0.16, -0.12], [0.19, 0.03], [0.1, 0.15], [-0.1, 0.15], [-0.19, 0.03]],
    thick: 0.07,
    raised: { inset: 0.035, height: 0.012, material: 'accent' },
    bolts: [[-0.13, -0.08], [0.13, -0.08], [0.0, 0.11]],
    layers: [{ outline: [[-0.07, -0.05], [0.07, -0.05], [0.05, 0.05], [-0.05, 0.05]], thick: 0.035, material: 'frame', glow: [[-0.04, -0.008, 0.04, 0.008]] }],
    place: { n: [0, 0.35, 1], at: add(KNEE, [0, 0.0, 0.14]) },
  }, l);
  plate(m, {
    scale: 1.12,
    outline: [[-0.15, -0.74], [0.15, -0.74], [0.2, -0.66], [0.22, -0.08], [0.15, 0.0], [-0.15, 0.0], [-0.22, -0.08], [-0.2, -0.66]],
    thick: 0.09,
    raised: { inset: 0.05, height: 0.016 },
    seams: [['y', -0.25]],
    vents: [{ rect: [-0.13, -0.21, -0.03, -0.08] }, { rect: [0.03, -0.21, 0.13, -0.08] }],
    glow: [[-0.012, -0.5, 0.012, -0.3]],
    bolts: [[-0.17, -0.7], [0.17, -0.7], [-0.18, -0.05], [0.18, -0.05]],
    chevrons: [{ rect: [-0.13, -0.66, 0.13, -0.6], stripes: 6 }],
    layers: [{ outline: oct(0.12, 0.12, 0.025, 0.025, -0.47), thick: 0.014, material: 'accent', bolts: [[0.0, -0.44]] }],
    place: { n: [0, 0.06, 1], at: [KNEE[0], KNEE[1] - 0.15, 0.11] },
  }, l);
  plate(m, {
    scale: 1.12,
    outline: [[-0.15, -0.58], [0.15, -0.58], [0.19, -0.44], [0.19, -0.06], [0.13, 0.0], [-0.13, 0.0], [-0.19, -0.06], [-0.19, -0.44]],
    thick: 0.14,
    grilles: [{ rect: [-0.13, -0.5, 0.13, -0.3], cols: 16, rows: 10 }],
    vents: [{ rect: [-0.13, -0.24, 0.13, -0.08], slats: 6 }],
    place: { n: [0, 0, -1], at: [KNEE[0], KNEE[1] - 0.2, -0.09] },
  }, l);
  for (const s of [1, -1]) {
    plate(m, {
    scale: 1.12,
      outline: oct(0.26, 0.56, 0.05),
      thick: 0.05, material: 'accent',
      vents: [{ rect: [-0.08, -0.34, 0.08, -0.1], slats: 8 }],
      ...(s > 0 ? { glow: [[-0.1, -0.46, -0.085, -0.38]] as const } : {}),
      place: { n: [s, 0, 0], at: [KNEE[0] + 0.11 * s, KNEE[1] - 0.16, 0] },
    }, l);
  }
  plate(m, {
    outline: oct(0.36, 0.2, 0.04, 0.05, -0.2),
    thick: 0.05, material: 'accent',
    rivets: true,
    chevrons: [{ rect: [-0.13, -0.17, 0.13, -0.12], stripes: 6 }],
    place: { n: [0, 0.15, 1], at: [KNEE[0], KNEE[1] - 0.14, 0.215] },
  }, l);
  for (const dx of [-0.07, 0.07]) ram(m, { from: [KNEE[0] + dx, KNEE[1] + 0.32, -0.15], to: [KNEE[0] + dx, KNEE[1] - 0.3, -0.2], bore: 0.055 }, l);
  for (const dx of [-0.13, 0.13]) hose(m, { points: [[KNEE[0] + dx, KNEE[1] + 0.05, -0.12], [KNEE[0] + dx * 1.2, KNEE[1] - 0.3, -0.25], [ANKLE[0] + dx, ANKLE[1] + 0.12, -0.16]], radius: 0.02, rings: 2 }, l);
  const top: Tuple3 = [ANKLE[0], ANKLE[1] + 0.3, -0.16];
  if (has(l, 'hydraulics')) {
    const s = recipes.coilSpring({ radius: 0.034, wire: 0.008, pitch: 0.024, turns: 9, segments: 24, wireSegments: 10, name: 'damper' });
    if (!s.ok) throw new Error(`spring ${s.error.code}`);
    const sm = s.value.model;
    check(sm, sm.translate(sel.all(), [top[0], ANKLE[1] + 0.05, top[2]]));
    check(m, m.append(sm, { tag: 'spring' }));
    check(m, m.cylinder({ radiusTop: 0.013, radiusBottom: 0.013, height: 0.3, radialSegments: 24, center: [top[0], ANKLE[1] + 0.16, top[2]], material: 'steel', tag: 'rod' }));
  } else {
    check(m, m.cylinder({ radiusTop: 0.042, radiusBottom: 0.042, height: 0.23, radialSegments: 8, center: [top[0], ANKLE[1] + 0.165, top[2]], material: 'steel', tag: 'spring' }));
  }
  return m;
}

function foot(l: Level): Model {
  const m = session();
  hub(m, { radius: 0.12, width: 0.3, axis: 'x', at: ANKLE, gear: false }, l);
  plate(m, {
    scale: 1.15,
    outline: [[0.32, -0.3], [-0.62, -0.3], [-0.64, -0.19], [-0.46, -0.08], [-0.14, -0.02], [0.15, -0.02], [0.31, -0.13]],
    thick: 0.46, chamfer: 0.035, material: 'accent',
    seams: [['x', -0.22], ['x', 0.06]],
    vents: [{ rect: [-0.16, -0.22, -0.02, -0.09], slats: 5 }, { rect: [0.1, -0.24, 0.22, -0.14], slats: 4 }],
    bolts: [[-0.42, -0.22], [0.24, -0.08], [-0.08, -0.26]],
    place: { n: [1, 0, 0], at: [ANKLE[0] - 0.23, ANKLE[1], 0.02] },
  }, l);
  plate(m, {
    scale: 1.15,
    outline: oct(0.38, 0.32, 0.05, 0.05, -0.16),
    thick: 0.05,
    raised: { inset: 0.035, height: 0.012, material: 'accent' },
    chevrons: [{ rect: [-0.12, -0.11, 0.12, -0.06], stripes: 5 }],
    bolts: [[-0.15, 0.12], [0.15, 0.12], [-0.15, -0.12], [0.15, -0.12]],
    boltSize: 'M10',
    place: { n: [0, 1, 0.5], up: [0, 0, -1], at: [ANKLE[0], ANKLE[1] - 0.15, 0.38] },
  }, l);
  for (const dx of [-0.11, 0.11]) {
    plate(m, {
    scale: 1.15,
      outline: oct(0.16, 0.12, 0.03, 0.02, -0.06),
      thick: 0.05,
      place: { n: [0, 0.25, 1], at: [ANKLE[0] + dx, ANKLE[1] - 0.24, 0.62] },
    }, l);
  }
  plate(m, {
    scale: 1.15,
    outline: oct(0.34, 0.16, 0.04, 0.02, -0.08),
    thick: 0.07,
    vents: [{ rect: [-0.1, -0.05, 0.1, 0.04], slats: 4, depth: 0.025 }],
    place: { n: [0, 0.3, -1], at: [ANKLE[0], ANKLE[1] - 0.15, -0.31] },
  }, l);
  return m;
}

// ------------------------------------------------------------------------------------ arms

/** Shoulder armor, built per side (not mirrored) so each side carries its own readable code. */
function pauldron(l: Level, side: 1 | -1): Model {
  const m = session();
  const X = (p: Tuple3): Tuple3 => [p[0] * side, p[1], p[2]];
  const O = (o: readonly Point2[]) => (side > 0 ? [...o] : mirrorX(o));
  const S: Tuple3 = X(SHOULDER);
  plate(m, {
    scale: 1.4,
    outline: O([[-0.28, -0.24], [0.24, -0.24], [0.31, -0.07], [0.29, 0.2], [-0.24, 0.24], [-0.31, 0.06]]),
    thick: 0.12,
    raised: { inset: 0.05, height: 0.014, material: 'accent' },
    vents: [{ rect: side > 0 ? [-0.2, -0.14, -0.05, 0.1] : [0.05, -0.14, 0.2, 0.1] }],
    grilles: [{ rect: side > 0 ? [0.02, -0.14, 0.18, 0.08] : [-0.18, -0.14, -0.02, 0.08], cols: 12, rows: 14 }],
    bolts: ([[0.25, -0.19], [0.24, 0.16], [-0.22, 0.19], [-0.23, -0.19]] as Point2[]).map(([x, y]) => [x * side, y] as Point2),
    place: { n: [0.3 * side, 1, 0], up: [0, 0, -1], at: [S[0] + 0.05 * side, S[1] + 0.15, 0] },
  }, l);
  plate(m, {
    scale: 1.4,
    outline: O([[-0.29, -0.3], [0.24, -0.3], [0.31, -0.18], [0.31, 0.13], [0.24, 0.2], [-0.26, 0.2], [-0.31, 0.08]]),
    thick: 0.12,
    raised: { inset: 0.05, height: 0.015 },
    seams: [['y', -0.16]],
    glow: [side > 0 ? [0.21, -0.12, 0.225, 0.08] : [-0.225, -0.12, -0.21, 0.08]],
    bolts: ([[-0.25, -0.26], [0.2, -0.26], [0.27, 0.15], [-0.23, 0.15]] as Point2[]).map(([x, y]) => [x * side, y] as Point2),
    stencils: [{ text: side > 0 ? 'T-27' : 'B-17', at: [-0.15, -0.02], height: 0.075 }],
    chevrons: [{ rect: [-0.18, -0.24, 0.18, -0.19], stripes: 8 }],
    layers: [{ outline: oct(0.16, 0.12, 0.025, 0.025, -0.14), thick: 0.016, material: 'accent', vents: [{ rect: [-0.05, -0.12, 0.05, -0.05], slats: 3, depth: 0.012 }] }],
    place: { n: [side, 0.15, 0], up: [0, 1, 0], at: [S[0] + 0.25 * side, S[1] - 0.05, 0] },
  }, l);
  // Inner block: ties the shell to the shoulder hub (no floating plates).
  strut(m, { size: [0.36, 0.16, 0.5], place: { n: [0, 0, 1], at: [S[0] + 0.04 * side, S[1] + 0.07, 0] } }, l);
  for (const s of [1, -1]) {
    plate(m, {
    scale: 1.4,
      outline: oct(0.3, 0.2, 0.04),
      thick: 0.055,
      vents: [{ rect: [-0.1, -0.15, 0.1, -0.06], slats: 4, depth: 0.025 }],
      place: { n: [0.35 * side, 0.25, s], at: [S[0] + 0.12 * side, S[1] + 0.13, 0.24 * s] },
    }, l);
  }
  return m;
}

function upperArm(l: Level): Model {
  const m = session();
  hub(m, { radius: 0.16, width: 0.26, axis: 'x', at: SHOULDER }, l);
  const up = sub(SHOULDER, ELBOW);
  strut(m, { size: [0.16, 0.52, 0.17], place: { n: [0, 0, 1], up, at: mid(SHOULDER, ELBOW, 0.55) }, ribs: 2 }, l);
  plate(m, {
    scale: 1.12,
    outline: oct(0.26, 0.42, 0.04),
    thick: 0.06,
    raised: { inset: 0.035, height: 0.012 },
    vents: [{ rect: [-0.07, -0.32, 0.07, -0.18], slats: 5 }],
    bolts: [[-0.09, -0.04], [0.09, -0.04]],
    boltSize: 'M10',
    place: { n: [1, 0.1, 0], up, at: add(mid(SHOULDER, ELBOW, 0.22), [0.09, 0, 0]) },
  }, l);
  plate(m, {
    scale: 1.12,
    outline: oct(0.22, 0.36, 0.035),
    thick: 0.05, material: 'accent',
    glow: [[-0.008, -0.3, 0.008, -0.12]],
    place: { n: [0, 0, 1], up, at: add(mid(SHOULDER, ELBOW, 0.25), [0, 0, 0.09]) },
  }, l);
  plate(m, {
    scale: 1.12,
    outline: oct(0.2, 0.34, 0.035),
    thick: 0.045,
    grilles: [{ rect: [-0.06, -0.28, 0.06, -0.08], cols: 7, rows: 12 }],
    place: { n: [0, 0, -1], up, at: add(mid(SHOULDER, ELBOW, 0.25), [0, 0, -0.09]) },
  }, l);
  for (const dx of [-0.03, 0.03]) hose(m, { points: [[0.45, 2.98, -0.12 + dx], [0.62, 2.88, -0.2 + dx], [SHOULDER[0] - 0.05, SHOULDER[1] - 0.22, -0.13 + dx], [ELBOW[0] - 0.06, ELBOW[1] + 0.1, -0.1 + dx]], radius: 0.018, rings: 2 }, l);
  return m;
}

function forearm(l: Level): Model {
  const m = session();
  hub(m, { radius: 0.13, width: 0.26, axis: 'x', at: ELBOW }, l);
  const up = sub(ELBOW, WRIST);
  strut(m, { size: [0.14, 0.52, 0.14], place: { n: [0, 0, 1], up, at: mid(ELBOW, WRIST, 0.5) }, ribs: 2 }, l);
  plate(m, {
    scale: 1.22,
    outline: [[-0.15, -0.62], [0.15, -0.62], [0.2, -0.52], [0.2, -0.09], [0.14, 0.0], [-0.14, 0.0], [-0.2, -0.09], [-0.2, -0.52]],
    thick: 0.09,
    raised: { inset: 0.045, height: 0.015 },
    vents: [{ rect: [-0.13, -0.27, 0.06, -0.13] }],
    glow: [[0.1, -0.44, 0.115, -0.14]],
    bolts: [[-0.15, -0.04], [0.15, -0.04], [-0.15, -0.58], [0.15, -0.58]],
    grilles: [{ rect: [-0.13, -0.46, 0.05, -0.36], cols: 16, rows: 7 }],
    chevrons: [{ rect: [-0.12, -0.57, 0.06, -0.5], stripes: 4 }],
    place: { n: [1, 0, 0.15], up, at: add(ELBOW, [0.09, -0.02, 0.02]) },
  }, l);
  plate(m, {
    scale: 1.22,
    outline: oct(0.24, 0.56, 0.04),
    thick: 0.06,
    raised: { inset: 0.035, height: 0.012, material: 'accent' },
    grilles: [{ rect: [-0.07, -0.42, 0.07, -0.18], cols: 8, rows: 14 }],
    place: { n: [0, 0.1, 1], up, at: add(ELBOW, [0.01, -0.03, 0.09]) },
  }, l);
  plate(m, {
    scale: 1.22,
    outline: oct(0.22, 0.5, 0.04),
    thick: 0.05,
    vents: [{ rect: [-0.07, -0.36, 0.07, -0.14], slats: 8 }],
    place: { n: [-1, 0, 0.1], up, at: add(ELBOW, [-0.08, -0.04, 0.02]) },
  }, l);
  ram(m, { from: add(ELBOW, [-0.02, 0.14, -0.1]), to: add(WRIST, [-0.02, 0.12, -0.06]), bore: 0.05 }, l);
  hose(m, { points: [add(ELBOW, [0.05, 0.08, -0.12]), add(mid(ELBOW, WRIST), [0.06, 0, -0.14]), add(WRIST, [0.03, 0.1, -0.07])], radius: 0.017, rings: 2 }, l);
  cables(m, { points: [add(ELBOW, [-0.105, -0.12, -0.04]), add(mid(ELBOW, WRIST), [-0.11, 0, -0.02]), add(WRIST, [-0.1, 0.14, 0.0])], radius: 0.006, n: 3, spread: [0, 0, 0.013] }, l);
  return m;
}

function hand(l: Level): Model {
  const m = session();
  const up = sub(ELBOW, WRIST);
  hub(m, { radius: 0.07, width: 0.18, axis: 'x', at: WRIST, gear: false }, l);
  plate(m, {
    outline: chamferRect(-0.1, -0.2, 0.1, 0.0, 0.03),
    thick: 0.11,
    seams: [['y', -0.1]],
    bolts: [[-0.065, -0.04], [0.065, -0.04]],
    boltSize: 'M8',
    place: { n: [1, 0, 0.1], up, at: add(WRIST, [-0.055, -0.05, 0]) },
  }, l);
  for (let i = 0; i < 4; i++) {
    const z = WRIST[2] - 0.075 + i * 0.05;
    const base: Tuple3 = [WRIST[0] + 0.01, WRIST[1] - 0.26, z];
    strut(m, { size: [0.05, 0.1, 0.042], place: { n: [0, 0, 1], up: [0.15, 1, 0], at: base }, ribs: 1 }, l);
    strut(m, { size: [0.045, 0.08, 0.038], place: { n: [0, 0, 1], up: [-0.4, 1, 0], at: add(base, [-0.022, -0.088, 0]) } }, l);
    strut(m, { size: [0.04, 0.06, 0.034], place: { n: [0, 0, 1], up: [-1, 0.6, 0], at: add(base, [-0.065, -0.135, 0]) } }, l);
  }
  strut(m, { size: [0.05, 0.1, 0.045], place: { n: [0, 0, 1], up: [-0.5, 1, 0.6], at: add(WRIST, [-0.06, -0.17, 0.1]) }, ribs: 1 }, l);
  return m;
}

/** Heavy weapon pod on the right forearm (unique): a slab body, three barrels and an ammo feed. */
function weapon(l: Level): Model {
  const m = session();
  const up = sub(ELBOW, WRIST);
  const fwd: Tuple3 = [-up[0], -up[1], -up[2]];
  const len = Math.hypot(...fwd);
  const d: Tuple3 = [fwd[0] / len, fwd[1] / len, fwd[2] / len];
  const at = (t: number, off: Tuple3): Tuple3 => [ELBOW[0] + d[0] * t + off[0], ELBOW[1] + d[1] * t + off[1], ELBOW[2] + d[2] * t + off[2]];
  plate(m, {
    outline: oct(0.26, 0.92, 0.05, 0.07, -0.86),
    thick: 0.2, material: 'accent',
    raised: { inset: 0.04, height: 0.014, material: 'armor' },
    vents: [{ rect: [-0.09, -0.3, 0.09, -0.12], slats: 7 }, { rect: [-0.09, -0.52, 0.09, -0.36], slats: 6 }],
    grilles: [{ rect: [-0.09, -0.78, 0.09, -0.6], cols: 10, rows: 9 }],
    chevrons: [{ rect: [-0.09, -0.1, 0.09, -0.05], stripes: 5 }],
    bolts: [[-0.1, -0.04], [0.1, -0.04], [-0.1, -0.82], [0.1, -0.82]],
    place: { n: [1, 0, 0], up, at: at(0.0, [0.27, 0.0, 0.0]) },
  }, l);
  plate(m, {
    outline: oct(0.22, 0.7, 0.04),
    thick: 0.06,
    vents: [{ rect: [-0.07, -0.55, 0.07, -0.2], slats: 12 }],
    glow: [[-0.007, -0.15, 0.007, -0.04]],
    place: { n: [0, 0.2, 1], up, at: at(0.1, [0.18, 0.0, 0.08]) },
  }, l);
  for (const [i, oz] of [-0.05, 0.0, 0.05].entries()) {
    const b = session();
    check(b, b.cylinder({ radiusTop: 0.024, radiusBottom: 0.024, height: 0.34, radialSegments: l.high ? 32 : 8, material: 'frame', tag: 'barrel' }));
    check(b, b.bevel(sel.edges.dihedral('>', 60), { width: 0.004, segments: l.high ? 2 : 1 }), 'barrel.chamfer');
    if (has(l, 'panels')) for (const y of [-0.1, 0.0, 0.1]) check(b, b.panelLine({ faces: sel.tag('barrel'), point: [0, y, 0], normal: [0, 1, 0] }, { width: 0.006, depth: 0.003, profile: 'u' }), 'barrel.ring');
    const e = eulerOfY(d);
    check(b, b.rotate(sel.all(), 'x', e[0]));
    check(b, b.rotate(sel.all(), 'y', e[1]));
    check(b, b.translate(sel.all(), at(0.98 + 0.03 * i, [0.18 + 0.0, 0.035 * (i - 1), oz])));
    check(m, m.append(b, { tag: 'barrel' }));
  }
  hose(m, { points: [at(0.15, [0.12, 0.12, -0.08]), at(0.05, [0.2, 0.2, -0.16]), at(-0.1, [0.15, 0.25, -0.12])], radius: 0.022, rings: 2, material: 'accent' }, l);
  return m;
}
/** Rotations (x then y, degrees) that turn +Y onto the unit direction d. */
function eulerOfY(d: Tuple3): [number, number] {
  return [(Math.acos(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI, (Math.atan2(d[0], d[2]) * 180) / Math.PI];
}

// ------------------------------------------------------------------------------------ core

function torso(l: Level): Model {
  const m = session();
  for (const [y, r] of [[2.2, 0.2], [2.31, 0.22], [2.42, 0.24]] as const) hub(m, { radius: r, width: 0.09, axis: 'y', at: [0, y, -0.03], gear: false }, l);
  strut(m, { size: [0.96, 0.6, 0.46], place: { n: [0, 0, 1], at: [0, 2.74, -0.12] } }, l);
  for (const s of [1, -1]) {
    const outline: Point2[] = [[0.0, -0.3], [0.42, -0.26], [0.53, -0.08], [0.51, 0.18], [0.36, 0.3], [0.0, 0.3]];
    plate(m, {
    scale: 1.2,
      outline: s > 0 ? outline : mirrorX(outline),
      thick: 0.09,
      raised: { inset: 0.05, height: 0.016 },
      seams: [['y', 0.03]],
      vents: [{ rect: s > 0 ? [0.12, -0.2, 0.3, -0.08] : [-0.3, -0.2, -0.12, -0.08] }],
      grilles: [{ rect: s > 0 ? [0.33, -0.2, 0.43, -0.06] : [-0.43, -0.2, -0.33, -0.06], cols: 6, rows: 9 }],
      glow: [s > 0 ? [0.08, 0.1, 0.095, 0.24] : [-0.095, 0.1, -0.08, 0.24]],
      bolts: (s > 0 ? [[0.05, 0.26], [0.43, 0.22], [0.05, -0.26], [0.42, -0.21]] : [[-0.05, 0.26], [-0.43, 0.22], [-0.05, -0.26], [-0.42, -0.21]]) as Point2[],
      ...(s > 0 ? { stencils: [{ text: 'T-27', at: [0.05, -0.058] as Point2, height: 0.065 }] } : { chevrons: [{ rect: [-0.42, 0.11, -0.13, 0.17] as const, stripes: 6 }] }),
      place: { n: [0.32 * s, 0.12, 1], at: [0.05 * s, 2.78, 0.24] },
    }, l);
  }
  plate(m, {
    scale: 1.2,
    outline: [[-0.09, -0.34], [0.09, -0.34], [0.11, 0.24], [0.0, 0.33], [-0.11, 0.24]],
    thick: 0.11, material: 'accent',
    glow: [[-0.01, -0.22, 0.01, 0.16]],
    grilles: [{ rect: [-0.075, -0.31, -0.02, -0.08], cols: 3, rows: 12 }, { rect: [0.02, -0.31, 0.075, -0.08], cols: 3, rows: 12 }],
    bolts: [[0.0, -0.3], [0.0, 0.25]],
    place: { n: [0, 0.1, 1], at: [0, 2.75, 0.29] },
  }, l);
  for (const s of [1, -1]) {
    plate(m, {
    scale: 1.12,
      outline: oct(0.5, 0.5, 0.07, 0.07, -0.27),
      thick: 0.06, material: 'accent',
      grilles: [{ rect: [-0.17, -0.2, 0.05, 0.08], cols: 10, rows: 14 }],
      vents: [{ rect: [0.09, -0.2, 0.2, 0.06], slats: 9 }],
      place: { n: [s, 0, 0], at: [0.5 * s, 2.72, -0.05] },
    }, l);
  }
  for (const [i, y] of [2.47, 2.35, 2.23].entries()) {
    plate(m, {
    scale: 1.12,
      outline: oct(0.5 - i * 0.04, 0.1, 0.03, 0.03, -0.05),
      thick: 0.05, material: i === 1 ? 'accent' : 'armor',
      rivets: i !== 1,
      place: { n: [0, -0.1 * i, 1], at: [0, y, 0.17 - 0.015 * i] },
    }, l);
  }
  for (const s of [1, -1]) {
    plate(m, {
    scale: 1.12,
      outline: chamferRect(-0.18, -0.06, 0.18, 0.07, 0.03),
      thick: 0.06,
      place: { n: [0.3 * s, 1, 0.5], up: [0, 0, -1], at: [0.3 * s, 3.03, 0.1] },
    }, l);
  }
  plate(m, {
    scale: 1.12,
    outline: oct(0.8, 0.56, 0.08, 0.08, -0.3),
    thick: 0.06,
    seams: [['x', 0.0], ['y', -0.05]],
    bolts: [[-0.34, 0.21], [0.34, 0.21], [-0.34, -0.24], [0.34, -0.24]],
    place: { n: [0, 0, -1], at: [0, 2.74, -0.35] },
  }, l);
  for (const s of [1, -1]) {
    plate(m, {
      outline: oct(0.38, 0.2, 0.05, 0.03, -0.1),
      thick: 0.06, material: 'accent',
      vents: [{ rect: [-0.13, -0.06, 0.13, 0.04], slats: 4, depth: 0.025 }],
      place: { n: [0.35 * s, 0.6, 1], at: [0.34 * s, 3.02, 0.24] },
    }, l);
  }
  for (const s of [1, -1]) hose(m, { points: [[0.16 * s, 3.04, 0.02], [0.3 * s, 3.06, -0.12], [0.5 * s, 3.0, -0.18]], radius: 0.022, rings: 1 }, l);
  cables(m, { points: [[-0.08, 3.0, 0.215], [-0.06, 2.85, 0.26], [-0.12, 2.6, 0.25]], radius: 0.007, n: 3, spread: [0.015, 0, 0] }, l);
  // Waist: hose bundles from the chest frame down past the spine rings to the pelvis.
  for (const [i, x] of [-0.2, -0.12, 0.12, 0.2].entries()) hose(m, { points: [[x, 2.5, 0.12 - 0.02 * i], [x * 1.25, 2.33, 0.2], [x * 1.1, 2.18, 0.17]], radius: 0.02, rings: 1, material: i % 3 === 0 ? 'accent' : 'rubber' }, l);
  for (const x of [-0.24, 0.24]) hose(m, { points: [[x, 2.48, -0.2], [x * 1.2, 2.32, -0.26], [x, 2.16, -0.2]], radius: 0.024, rings: 1 }, l);
  return m;
}

function head(l: Level): Model {
  const m = session();
  hub(m, { radius: 0.09, width: 0.12, axis: 'y', at: [0, 3.04, 0.1], gear: false }, l);
  plate(m, {
    outline: [[-0.14, -0.1], [0.14, -0.1], [0.17, 0.02], [0.15, 0.13], [0.07, 0.19], [-0.07, 0.19], [-0.15, 0.13], [-0.17, 0.02]],
    thick: 0.34, chamfer: 0.022,
    glow: [[-0.015, -0.06, 0.015, 0.11]],
    vents: [{ rect: [-0.13, -0.07, -0.04, 0.02], slats: 3, depth: 0.025 }, { rect: [0.04, -0.07, 0.13, 0.02], slats: 3, depth: 0.025 }],
    bolts: [[-0.11, 0.11], [0.11, 0.11]],
    boltSize: 'M8',
    scale: 0.85,
    place: { n: [0, 0, 1], at: [0, 3.16, -0.04] },
  }, l);
  plate(m, {
    outline: [[-0.035, -0.14], [0.035, -0.14], [0.025, 0.16], [-0.025, 0.16]],
    thick: 0.05, material: 'accent',
    scale: 0.85,
    place: { n: [0, 1, 0.15], up: [0, 0, -1], at: [0, 3.33, 0.11] },
  }, l);
  for (const s of [1, -1]) {
    plate(m, {
      outline: chamferRect(-0.13, -0.09, 0.13, 0.08, 0.025),
      thick: 0.04,
      grilles: [{ rect: [-0.08, -0.05, 0.04, 0.05], cols: 7, rows: 6 }],
      scale: 0.85,
      place: { n: [s, 0, 0.1], at: [0.145 * s, 3.18, 0.1] },
    }, l);
    strut(m, { size: [0.012, 0.26, 0.012], place: { n: [0, 0, 1], up: [-0.1 * s, 1, -0.2], at: [0.09 * s, 3.42, 0.0] } }, l);
  }
  return m;
}

function backpack(l: Level): Model {
  const m = session();
  plate(m, {
    scale: 1.1,
    outline: oct(0.66, 0.62, 0.08, 0.08, -0.32),
    thick: 0.22,
    raised: { inset: 0.05, height: 0.016 },
    seams: [['y', 0.0]],
    grilles: [{ rect: [-0.22, 0.05, 0.22, 0.2], cols: 30, rows: 8 }],
    vents: [{ rect: [-0.22, -0.24, -0.04, -0.06] }, { rect: [0.04, -0.24, 0.22, -0.06] }],
    bolts: [[-0.27, 0.24], [0.27, 0.24], [-0.27, -0.27], [0.27, -0.27]],
    stencils: [{ text: 'NO STEP', at: [-0.13, 0.215], height: 0.028 }],
    place: { n: [0, 0, -1], at: [0, 2.74, -0.39] },
  }, l);
  for (const s of [1, -1]) {
    plate(m, {
    scale: 1.1,
      outline: oct(0.16, 0.56, 0.03, 0.03, -0.28),
      thick: 0.14,
      vents: [{ rect: [-0.05, -0.2, 0.05, 0.12], slats: 12 }],
      glow: [[-0.006, 0.15, 0.006, 0.24]],
      place: { n: [0, 0, -1], at: [0.42 * s, 2.76, -0.42] },
    }, l);
    greebles(m, { rect: [-0.1, -0.24, 0.1, 0.24], z: 0, n: 6, seed: 7 + s, place: { n: [s, 0, 0], at: [0.5 * s, 2.76, -0.49] } }, l);
  }
  for (const s of [1, -1]) {
    const t = session();
    check(t, t.revolve({ points: [[0.0, -0.05], [0.06, -0.06], [0.095, -0.205], [0.11, -0.2], [0.07, -0.04], [0.06, 0.0], [0.0, 0.0]], segments: l.high ? 64 : 12, material: 'steel', tag: 'bell' }));
    if (has(l, 'panels')) for (const y of [-0.08, -0.14]) check(t, t.panelLine({ faces: sel.tag('bell'), point: [0, y, 0], normal: [0, 1, 0] }, { width: 0.006, depth: 0.003, profile: 'v' }), 'bell.ring');
    check(t, t.rotate(sel.all(), 'x', -25));
    check(t, t.translate(sel.all(), [0.18 * s, 2.44, -0.58]));
    check(m, m.append(t, { tag: 'thruster' }));
  }
  for (const s of [1, -1]) check(m, m.cylinder({ radiusTop: 0.08, radiusBottom: 0.08, height: 0.5, radialSegments: l.high ? 48 : 10, center: [0.25 * s, 2.72, -0.7], material: 'frame', tag: 'tank' }));
  check(m, m.bevel(sel.tag('tank').toEdges('contained').and(sel.edges.dihedral('>', 60)), { width: 0.014, segments: l.high ? 3 : 1 }), 'tank.bevel');
  if (has(l, 'panels')) for (const y of [2.56, 2.72, 2.88]) check(m, m.panelLine({ faces: sel.tag('tank'), point: [0, y, 0], normal: [0, 1, 0] }, { width: 0.012, depth: 0.004, profile: 'u' }), 'tank.band');
  greebles(m, { rect: [-0.2, -0.24, 0.2, 0.24], z: 0, n: 14, seed: 3, place: { n: [0, 0, -1], at: [0, 2.74, -0.626] } }, l);
  for (const s of [1, -1]) hose(m, { points: [[0.12 * s, 3.0, -0.36], [0.2 * s, 3.1, -0.5], [0.25 * s, 2.99, -0.66]], radius: 0.02, rings: 1, material: s > 0 ? 'accent' : 'rubber' }, l);
  for (const s of [1, -1]) hose(m, { points: [[0.33 * s, 2.47, -0.48], [0.28 * s, 2.33, -0.4], [0.16 * s, 2.36, -0.3]], radius: 0.018, rings: 1 }, l);
  return m;
}

function pelvis(l: Level): Model {
  const m = session();
  hub(m, { radius: 0.22, width: 0.14, axis: 'y', at: [0, 2.1, -0.03], gear: false }, l);
  strut(m, { size: [0.74, 0.16, 0.24], place: { n: [0, 0, 1], at: [0, 1.97, 0] }, ribs: 2 }, l);
  plate(m, {
    scale: 1.12,
    outline: [[-0.14, -0.2], [0.14, -0.2], [0.2, 0.0], [0.17, 0.09], [-0.17, 0.09], [-0.2, 0.0]],
    thick: 0.08,
    raised: { inset: 0.035, height: 0.013, material: 'accent' },
    bolts: [[-0.15, 0.05], [0.15, 0.05]],
    chevrons: [{ rect: [-0.11, -0.17, 0.11, -0.12], stripes: 5 }],
    layers: [{ outline: oct(0.12, 0.08, 0.02, 0.02, -0.06), thick: 0.035, material: 'frame', glow: [[-0.04, -0.03, 0.04, -0.018]] }],
    place: { n: [0, -0.25, 1], at: [0, 2.0, 0.15] },
  }, l);
  for (const s of [1, -1]) {
    plate(m, {
    scale: 1.12,
      outline: oct(0.34, 0.34, 0.05, 0.07, -0.29),
      thick: 0.06,
      seams: [['y', -0.12]],
      vents: [{ rect: [-0.1, -0.25, 0.1, -0.16], slats: 4 }],
      bolts: [[-0.13, 0.0], [0.13, 0.0]],
      boltSize: 'M10',
      place: { n: [s, -0.25, 0], at: [0.5 * s, 2.06, 0.0] },
    }, l);
  }
  plate(m, {
    scale: 1.12,
    outline: oct(0.6, 0.22, 0.04, 0.05, -0.15),
    thick: 0.06,
    grilles: [{ rect: [-0.2, -0.1, 0.2, 0.0], cols: 22, rows: 5 }],
    place: { n: [0, -0.2, -1], at: [0, 2.04, -0.16] },
  }, l);
  for (const s of [1, -1]) ram(m, { from: [0.13 * s, 2.12, 0.02], to: [0.29 * s, 1.86, 0.15], bore: 0.045 }, l);
  return m;
}

export const GROUPS: readonly Group[] = [
  { name: 'torso', set: 'set1', mirrored: false, lean: LEAN, build: torso },
  { name: 'pelvis', set: 'set3', mirrored: false, build: pelvis },
  { name: 'head', set: 'set1', mirrored: false, lean: LEAN + 4, build: head },
  { name: 'backpack', set: 'set2', mirrored: false, lean: LEAN, build: backpack },
  { name: 'weapon', set: 'set1', mirrored: false, lean: LEAN, build: weapon },
  { name: 'pauldron-r', set: 'set2', mirrored: false, lean: LEAN, build: (l) => pauldron(l, 1) },
  { name: 'pauldron-l', set: 'set2', mirrored: false, lean: LEAN, build: (l) => pauldron(l, -1) },
  { name: 'upperarm', set: 'set2', mirrored: true, lean: LEAN, build: upperArm },
  { name: 'forearm', set: 'set2', mirrored: true, lean: LEAN, build: forearm },
  { name: 'hand', set: 'set1', mirrored: true, lean: LEAN, build: hand },
  { name: 'thigh', set: 'set3', mirrored: true, build: thigh },
  { name: 'shin', set: 'set3', mirrored: true, build: shin },
  { name: 'foot', set: 'set3', mirrored: true, build: foot },
];
