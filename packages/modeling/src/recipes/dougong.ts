import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from '../arrays';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import type { DesignedContact } from '../interference';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import { CAI_DEPTH_FEN, CAI_WIDTH_FEN, caiFen, XIE_WIDTH_FEN } from './caifen';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export type DougongPuzuo = 4 | 5;
/**
 * juansha (the curled arm end) of a member end. `fashi` is the Yingzao Fashi construction: the
 * 16-fen run under the arm tip and the 9-fen rise at the tip, each divided into four equal parts,
 * with the joins between
 * corresponding points enveloping a parabola. `parabola` is the convex curve drop (1 - sqrt(u /
 * run))^2 with a shallower run and rise.
 */
export type DougongCurl = 'fashi' | 'parabola';

export interface DougongOptions extends RecipeNaming {
  /** Bracket count, 4 or 5 (default 5): four is one jixinzao (the stepped double-chao jump style) jump, five is two. */
  readonly puzuo?: DougongPuzuo;
  /** Cai grade 1 to 8 that supplies the fen length (default 6). */
  readonly grade?: number;
  /** juansha envelope of each member end (default `fashi`). */
  readonly curl?: DougongCurl;
  /** Facets of the parabola curl at each member end (default 4). Ignored by `fashi`. */
  readonly curlFacets?: number;
  /** Horizontal run of the parabola curl, in fen (default 8). Ignored by `fashi`. */
  readonly curlRunFen?: number;
  /** Rise of the parabola curl at the member end, in fen (default 4). Ignored by `fashi`. */
  readonly curlDropFen?: number;
  /** Member depth in fen (default 10, the mouth width; a deeper member cannot seat in the slot). */
  readonly armThicknessFen?: number;
}

export const DOUGONG_RANGES = {
  puzuo: [4, 5],
  curlFacets: [2, 8],
  curlRunFen: [2, 12],
  curlDropFen: [1, 10],
  armThicknessFen: [6, 14],
} as const satisfies Record<string, Range>;

const DEFAULT_PUZUO: DougongPuzuo = 5;
const DEFAULT_GRADE = 6;
const DEFAULT_CURL: DougongCurl = 'fashi';
const DEFAULT_PARABOLA: Curl = { facets: 4, run: 8, drop: 4 };

/** ludou (the cap block on the column) footprint and height (verified, vol. 4). */
export const LU_DOU = { width: 32, depth: 32, height: 20 } as const;
/** san dou (the small block): 14 across the member, 16 along it, 10 high (design choice inside the brief's range). */
export const SMALL_DOU = { width: 14, depth: 16, height: 10 } as const;
/** jiaohu dou (the cross-block on a jump) on every huagong (the arm running through the axis) jump centre: 18 across the member, 16 along it, 10 high. */
export const JIAOHU_DOU = { width: 18, depth: 16, height: 10 } as const;
/** qixin dou (the centre block of the top gong) on the top linggong (the top wall member) centre: 16 by 16, 10 high. */
export const QIXIN_DOU = { width: 16, depth: 16, height: 10 } as const;
/** jixinzao jump: each tier steps outward by 30 fen (verified, vol. 4). */
export const JUMP_FEN = 30;
/** Mouth width: a cai fills it (verified, vol. 4). */
const MOUTH_FEN = CAI_DEPTH_FEN;
/** huagong arm tip past the centre of its outermost jiaohu dou, in fen; each tier reaches one jump further. */
const HUA_TIP_BEYOND_FEN = 6;
/** nidaogong (the wall member at the axis) half-length (62 long), tier 1 at the axis. */
const NI_DAO_HALF_FEN = 31;
/** mangong (the long arm) half-length (92 long, verified, vol. 4), tier 2 at the axis. */
const MAN_GONG_HALF_FEN = 46;
/** guazi gong (the wall member over a jump) half-length (62 long), a wall member over a jiaohu dou when another tier sits above it. */
const GUA_ZI_HALF_FEN = 31;
/** linggong half-length (72 long), the top wall member over each jiaohu dou. */
const LING_GONG_HALF_FEN = 36;
/** zucai (cai plus xie) tier pitch: a cai plus the xie (the layer over the cai) above it (verified, vol. 4). */
const ZU_CAI_FEN = CAI_WIDTH_FEN + XIE_WIDTH_FEN;
/** A san dou is centred this far inside each end of its member, so it is flush with the end. */
const SAN_DOU_INSET_FEN = SMALL_DOU.depth / 2;
/** Shortest wall member, which bounds a parabola curl run (half its length). */
const SHORTEST_CURLED_FEN = 2 * GUA_ZI_HALF_FEN;
/** er (the top band of a dou) : ping (the middle band of a dou) : qi (the leaning foot band) share of a dou's height, the er on top (brief, round 3). */
export const DOU_RATIO = [4, 2, 4] as const;
/**
 * Inset of the qi at its four section heights, as fractions of QI_INSET_FEN: foot, one third,
 * two thirds and the top, where it meets the ping at full extent. Three straight bands join them,
 * so the foot is pulled in and each band meets the next at a hard crease (design choice).
 */
export const QI_INSET_FRACTIONS = [1, 0.45, 0.13, 0] as const;
/** Maximum qi inset at the foot, in fen (design choice). */
const QI_INSET_FEN = 2;
/** Crease threshold for the qi bands, in degrees: they meet at 5 to 9 degrees, not a 30-degree edge. */
const DOU_CREASE_DEG = 5;
/** Contact band for a mouth fit: the member sits in the slot with no clearance (meters). */
const MOUTH_FIT_GAP = 1e-6;
/** Fashi juansha: run under the arm tip and rise at the tip, each divided into FASHI_PARTS parts. */
const FASHI_RUN_FEN = 16;
const FASHI_RISE_FEN = 9;
const FASHI_PARTS = 4;
/** Centre top linggong (puzuo 5 only) half-length, in fen: long enough to reach the san dous at 38 fen. */
const CENTRE_LING_GONG_HALF_FEN = 40;
/** Shuatou tips reach this far beyond the outer top linggong centre, in fen (brief: 25 fen). */
const SHUATOU_TIP_BEYOND_FEN = 25;
/**
 * Mazha-tou leaf of a shuatou nose, a design estimate (knowledge/timber-members.md round 6). Read from
 * the tip inward: the top of the leaf is the nose height; each row is one tread (run) and the riser
 * that drops from it. The rows descend from MAZHA_TOU_NOSE_FEN to the floor at the run end.
 */
const MAZHA_TOU_NOSE_FEN = 12;
const MAZHA_TOU_STEPS: readonly (readonly [run: number, drop: number])[] = [
  [8, 4],
  [8, 4],
];

export interface Curl {
  readonly facets: number;
  readonly run: number;
  readonly drop: number;
}

export interface DouProfile {
  /** er (top), ping (middle) and qi (foot) heights in fen. */
  readonly ear: number;
  readonly flat: number;
  readonly qi: number;
  /** Loft sections from the foot up: height and half-extents in fen. */
  readonly sections: readonly { readonly y: number; readonly hx: number; readonly hz: number }[];
}

/**
 * Bands and loft sections of a dou in fen. The qi is the foot band: its half-extents pull in by
 * QI_INSET_FEN * QI_INSET_FRACTIONS, so it narrows toward the foot. The ping and er are vertical.
 */
export function douProfile(
  widthFen: number,
  depthFen: number,
  heightFen: number,
  ratio: readonly [number, number, number] = DOU_RATIO,
): DouProfile {
  const unit = heightFen / (ratio[0] + ratio[1] + ratio[2]);
  const ear = unit * ratio[0];
  const flat = unit * ratio[1];
  const qi = unit * ratio[2];
  const hx = widthFen / 2;
  const hz = depthFen / 2;
  const qiSection = (y: number, fraction: number) => ({
    y,
    hx: hx - QI_INSET_FEN * fraction,
    hz: hz - QI_INSET_FEN * fraction,
  });
  const [foot, third, twoThirds, top] = QI_INSET_FRACTIONS;
  return {
    ear,
    flat,
    qi,
    sections: [
      qiSection(0, foot),
      qiSection(qi / 3, third),
      qiSection((2 * qi) / 3, twoThirds),
      qiSection(qi, top),
      { y: qi + flat, hx, hz },
      { y: heightFen, hx, hz },
    ],
  };
}

/**
 * juansha outline of a member in its side plane, from x = 0 (inner end) to x = length (outer tip),
 * bottom edge first. A curled end rises from the member bottom to the curl's tip height.
 */
export function armOutline(
  length: number,
  height: number,
  curl: Curl | 'fashi' | 'mazha-tou' | 'none',
  ends: { readonly start: boolean; readonly end: boolean },
): Point2[] {
  const out: Point2[] = [];
  if (ends.start && curl !== 'none') for (const p of endProfileOf(curl)) out.push(p);
  else out.push([0, 0]);
  if (ends.end && curl !== 'none') {
    const profile = endProfileOf(curl);
    for (let i = profile.length - 1; i >= 0; i--) {
      const [u, v] = profile[i] as Point2;
      out.push([length - u, v]);
    }
  } else out.push([length, 0]);
  out.push([length, height], [0, height]);
  return out;
}

/** End profile sampled from the tip (u = 0) inward, by kind. */
function endProfileOf(curl: Curl | 'fashi' | 'mazha-tou'): Point2[] {
  if (curl === 'mazha-tou') return mazhaTouProfile();
  return curlProfile(curl);
}

/** Sampled curl points from the tip (u = 0) inward; v is the height above the member bottom. */
function curlProfile(curl: Curl | 'fashi'): Point2[] {
  if (curl === 'fashi') return fashiEnvelope();
  return parabolaPoints(curl);
}

/**
 * Mazha-tou (the stepped leaf of a shuatou nose), from the tip (u = 0) inward to the run end. The
 * profile is the MAZHA_TOU_STEPS table: starting at the nose height, each step runs its tread then
 * drops its riser; the leaf ends on the floor at the last tread's far edge.
 */
export function mazhaTouProfile(): Point2[] {
  const out: Point2[] = [[0, MAZHA_TOU_NOSE_FEN]];
  let u = 0;
  let v = MAZHA_TOU_NOSE_FEN;
  for (const [run, drop] of MAZHA_TOU_STEPS) {
    out.push([u, v - drop]);
    u += run;
    out.push([u, v - drop]);
    v -= drop;
  }
  out.push([u, 0]);
  return out;
}

/**
 * The fashi envelope, from the tip (u = 0, v = rise) to the run end (u = run, v = 0). Join i runs
 * from horizontal point i (u = run i / n, counted from the corner under the tip) to vertical point
 * i (v = rise (n - i) / n, counted down from the tip). Every join satisfies u / run + v / rise = 1,
 * and its tangency with the envelope is (run s^2, rise (1 - s)^2) with s = i / n. The vertices are
 * those tangency points, so the polyline lies on the parabola sqrt(u / run) + sqrt(v / rise) = 1.
 * Chord lengths are not equal.
 */
export function fashiEnvelope(): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i <= FASHI_PARTS; i++) {
    const s = i / FASHI_PARTS;
    out.push([FASHI_RUN_FEN * s * s, FASHI_RISE_FEN * (1 - s) * (1 - s)]);
  }
  return out;
}

function parabolaPoints(curl: Curl): Point2[] {
  const { facets: n, run, drop } = curl;
  const out: Point2[] = [];
  for (let i = 0; i <= n; i++) {
    const u = (run * i) / n;
    const s = Math.sqrt(u / run);
    out.push([u, drop * (1 - s) * (1 - s)]);
  }
  return out;
}

/** A bracket member: one continuous timber, along X (`x`, a huagong) or along Z (`z`, a wall member). */
export type BracketRole = 'huagong' | 'nidaogong' | 'manggong' | 'guazi' | 'linggong' | 'shuatou';
/** juansha: the fashi curl at each end. mazha-tou: the stepped leaf cut of a shuatou nose at each end. */
export type BracketEnds = 'juansha' | 'mazha-tou';
export interface BracketMember {
  readonly key: string;
  readonly role: BracketRole;
  readonly axis: 'x' | 'z';
  /** 1 sits on the ludou; each tier above rests in the dou mouths of the tier below. */
  readonly tier: number;
  /** z of an x member (0: the huagong run through the axis); x of a z member. */
  readonly across: number;
  /** Extent along the member's axis, in fen. */
  readonly from: number;
  readonly to: number;
  /** Profile of both ends: a juansha curl for gongs, a mazha-tou leaf for a shuatou nose. */
  readonly ends: BracketEnds;
  /** No wall member sits above it: the top tier of the set. */
  readonly top: boolean;
}
export interface BracketDou {
  readonly key: string;
  readonly kind: 'ludou' | 'jiaohu' | 'san' | 'qixin';
  /** x and z centre in fen. */
  readonly at: readonly [number, number];
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** Tier of the member it sits on; 0 for the ludou on the ground. */
  readonly tier: number;
  readonly sitsOn: string | null;
}
export interface BracketMouth {
  readonly axis: 'x' | 'z';
  /** Member held in this mouth from the tier above, or null when the mouth is declared empty. */
  readonly holds: string | null;
}
export interface BracketCrossing {
  /** The x member and the z member that halve at (at, 0). */
  readonly x: string;
  readonly z: string;
  readonly at: number;
  readonly tier: number;
}

const reachOf = (tier: number): number => JUMP_FEN * tier + HUA_TIP_BEYOND_FEN;
/** Outer shuatou tip from the axis: past the outermost top-tier linggong centre by SHUATOU_TIP_BEYOND_FEN. */
const shuatouTipOf = (steps: number): number => JUMP_FEN * steps + SHUATOU_TIP_BEYOND_FEN;

/**
 * Continuous members of a set, in fen. Tier 1 holds the nidaogong (wall member at the axis) and the
 * huagong pair, which is one timber through the axis. Each jixinzao jump adds a huagong tier and a wall
 * member over the jump centre (guazi gong below the top, linggong at the top). The mangong sits at the axis on tier 2.
 */
export function bracketMembers(puzuo: DougongPuzuo): BracketMember[] {
  const steps = puzuo - 3;
  const top = steps + 1;
  const out: BracketMember[] = [];
  const push = (m: Omit<BracketMember, 'top'>): void => {
    out.push({ ...m, top: m.tier === top });
  };
  push({
    key: 'nidaogong-1',
    role: 'nidaogong',
    axis: 'z',
    tier: 1,
    across: 0,
    from: -NI_DAO_HALF_FEN,
    to: NI_DAO_HALF_FEN,
    ends: 'juansha',
  });
  for (let t = 1; t <= steps; t++) {
    push({
      key: `huagong-${t}`,
      role: 'huagong',
      axis: 'x',
      tier: t,
      across: 0,
      from: -reachOf(t),
      to: reachOf(t),
      ends: 'juansha',
    });
  }
  push({
    key: 'manggong-2',
    role: 'manggong',
    axis: 'z',
    tier: 2,
    across: 0,
    from: -MAN_GONG_HALF_FEN,
    to: MAN_GONG_HALF_FEN,
    ends: 'juansha',
  });
  for (let k = 1; k <= steps; k++) {
    for (const sign of [1, -1]) {
      const tier = k + 1;
      const isTop = tier === top;
      const half = isTop ? LING_GONG_HALF_FEN : GUA_ZI_HALF_FEN;
      push({
        key: `${isTop ? 'linggong' : 'guazi'}-${tier}-${sign > 0 ? 'x+' : 'x-'}`,
        role: isTop ? 'linggong' : 'guazi',
        axis: 'z',
        tier,
        across: sign * JUMP_FEN * k,
        from: -half,
        to: half,
        ends: 'juansha',
      });
    }
  }
  // Puzuo 5 only: the top-tier centre wall member, over the axis. Its ends reach the mangong's san
  // dous (at 38 fen), so it rests on them.
  if (steps >= 2) {
    push({
      key: `linggong-${top}-c`,
      role: 'linggong',
      axis: 'z',
      tier: top,
      across: 0,
      from: -CENTRE_LING_GONG_HALF_FEN,
      to: CENTRE_LING_GONG_HALF_FEN,
      ends: 'juansha',
    });
  }
  // Shuatou: the top-tier nose through the centre, tips SHUATOU_TIP_BEYOND_FEN past the outer
  // top linggong centre. It crosses the linggong at the axis of each top-tier jump, and sits in
  // the jiaohu mouths of the tier below.
  push({
    key: 'shuatou',
    role: 'shuatou',
    axis: 'x',
    tier: top,
    across: 0,
    from: -shuatouTipOf(steps),
    to: shuatouTipOf(steps),
    ends: 'mazha-tou',
  });
  return out;
}

/**
 * Dous of a set, in fen: the ludou on the ground; a jiaohu dou on each huagong jump centre; a san dou at
 * both ends of every wall member; a qixin dou on each top linggong centre.
 */
export function bracketDous(puzuo: DougongPuzuo, members: readonly BracketMember[]): BracketDou[] {
  const steps = puzuo - 3;
  const out: BracketDou[] = [
    {
      key: 'ludou',
      kind: 'ludou',
      at: [0, 0],
      width: LU_DOU.width,
      depth: LU_DOU.depth,
      height: LU_DOU.height,
      tier: 0,
      sitsOn: null,
    },
  ];
  for (let t = 1; t <= steps; t++) {
    for (const sign of [1, -1]) {
      out.push({
        key: `jiaohu-${t}-${sign > 0 ? 'x+' : 'x-'}`,
        kind: 'jiaohu',
        at: [sign * JUMP_FEN * t, 0],
        width: JIAOHU_DOU.width,
        depth: JIAOHU_DOU.depth,
        height: JIAOHU_DOU.height,
        tier: t,
        sitsOn: `huagong-${t}`,
      });
    }
  }
  for (const m of members) {
    if (m.axis !== 'z') continue;
    for (const z of [m.to - SAN_DOU_INSET_FEN, m.from + SAN_DOU_INSET_FEN]) {
      out.push({
        key: `san-dou-${m.key}-${z > 0 ? 'hi' : 'lo'}`,
        kind: 'san',
        at: [m.across, z],
        width: SMALL_DOU.width,
        depth: SMALL_DOU.depth,
        height: SMALL_DOU.height,
        tier: m.tier,
        sitsOn: m.key,
      });
    }
    if (m.role === 'linggong' && m.top) {
      // The qixin sits on the shuatou where it halves over the linggong: the shuatou keeps the
      // upper half at that crossing, so the linggong top there is notched below the seat.
      out.push({
        key: `qixin-dou-${m.key}`,
        kind: 'qixin',
        at: [m.across, 0],
        width: QIXIN_DOU.width,
        depth: QIXIN_DOU.depth,
        height: QIXIN_DOU.height,
        tier: m.tier,
        sitsOn: 'shuatou',
      });
    }
  }
  return out;
}

/**
 * Mouths of a dou and the member each holds from the tier above. A san dou has a single z mouth
 * (it closes a wall member's end); the other dous have an x and a z mouth.
 */
export function mouthsOf(
  dou: Pick<BracketDou, 'kind' | 'at' | 'width' | 'depth' | 'tier'>,
  members: readonly BracketMember[],
): BracketMouth[] {
  const above = dou.tier + 1;
  const axes: readonly ('x' | 'z')[] = dou.kind === 'san' ? ['z'] : ['x', 'z'];
  return axes.map((axis) => {
    const hit = members.find((m) => {
      if (m.tier !== above || m.axis !== axis) return false;
      if (axis === 'x') {
        return Math.abs(dou.at[1]) < dou.depth / 2 && m.from <= dou.at[0] && dou.at[0] <= m.to;
      }
      return (
        Math.abs(m.across - dou.at[0]) < dou.width / 2 && m.from <= dou.at[1] && dou.at[1] <= m.to
      );
    });
    return { axis, holds: hit?.key ?? null };
  });
}

/** Halved crossings: every x member and z member of one tier that overlap in plan. */
export function crossingsOf(members: readonly BracketMember[]): BracketCrossing[] {
  const out: BracketCrossing[] = [];
  for (const x of members) {
    if (x.axis !== 'x') continue;
    for (const z of members) {
      if (z.axis !== 'z' || z.tier !== x.tier) continue;
      if (z.from <= 0 && 0 <= z.to && x.from <= z.across && z.across <= x.to) {
        out.push({ x: x.key, z: z.key, at: z.across, tier: x.tier });
      }
    }
  }
  return out;
}

export type SupportVerdict = 'ground' | 'two-mouths' | 'mouth-and-crossing' | 'unsupported';

export interface SupportRow {
  readonly key: string;
  readonly tier: number;
  /** Dous whose mouth holds this member. */
  readonly mouths: readonly string[];
  /** Members halved with this one. */
  readonly crossings: readonly string[];
  readonly verdict: SupportVerdict;
}

/**
 * Support rule for every member: a member above tier 1 rests in two dou mouths, or in one mouth
 * plus a halved crossing with a member that rests in two mouths. Anything else is unsupported; no
 * member is exempt.
 */
export function supportReport(
  members: readonly BracketMember[],
  dous: readonly BracketDou[],
): SupportRow[] {
  const held = dous.flatMap((d) =>
    mouthsOf(d, members)
      .filter((mo) => mo.holds !== null)
      .map((mo) => ({ dou: d.key, holds: mo.holds as string })),
  );
  const crosses = crossingsOf(members);
  return members.map((m) => {
    const mouths = held.filter((h) => h.holds === m.key).map((h) => h.dou);
    const crossings = crosses.flatMap((c) => (c.x === m.key ? [c.z] : c.z === m.key ? [c.x] : []));
    const partnerRests = crossings.some((p) => held.filter((h) => h.holds === p).length >= 2);
    let verdict: SupportVerdict;
    if (m.tier === 1) verdict = mouths.includes('ludou') ? 'ground' : 'unsupported';
    else if (mouths.length >= 2) verdict = 'two-mouths';
    else if (mouths.length === 1 && partnerRests) verdict = 'mouth-and-crossing';
    else verdict = 'unsupported';
    return { key: m.key, tier: m.tier, mouths, crossings, verdict };
  });
}

/** Tier 1 bottom of the bracket, in fen: the ludou mouth floor (ear band of the lu dou). */
const LU_EAR_FEN = (LU_DOU.height * DOU_RATIO[0]) / (DOU_RATIO[0] + DOU_RATIO[1] + DOU_RATIO[2]);
/** Member bottom of tier t, in fen: tier 1 sits in the ludou mouth; each tier adds one zucai pitch. */
export const memberBottomOf = (tier: number): number =>
  LU_DOU.height - LU_EAR_FEN + (tier - 1) * ZU_CAI_FEN;

/**
 * jixinzao (double-chao) bracket set on a ludou, built from one table of continuous members and dous.
 * Each huagong is one timber through the axis; each wall member is one timber along the wall. Where
 * a huagong crosses a wall member the two are halved: the huagong keeps its upper half and the wall
 * member its lower half, so the pair fills the same volume as the two full bars with no overlap.
 * Dous hold the next tier's members in their mouths. The support rule (see `supportReport`) and
 * the mouths are derived from the same table the geometry is built from.
 */
export function dougong(options: DougongOptions = {}): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'dougong';
  const puzuo = options.puzuo ?? DEFAULT_PUZUO;
  const grade = options.grade ?? DEFAULT_GRADE;
  const curlKind: DougongCurl = options.curl ?? DEFAULT_CURL;
  const parabola: Curl = {
    facets: options.curlFacets ?? DEFAULT_PARABOLA.facets,
    run: options.curlRunFen ?? DEFAULT_PARABOLA.run,
    drop: options.curlDropFen ?? DEFAULT_PARABOLA.drop,
  };
  const armThickness = options.armThicknessFen ?? MOUTH_FEN;
  if (curlKind !== 'fashi' && curlKind !== 'parabola') {
    return err(
      modelingError(
        'model-invalid-argument',
        'a juansha curl of fashi or parabola',
        { curl: curlKind },
        'choose fashi, the Yingzao Fashi envelope, or parabola',
      ),
    );
  }
  const checked = checkAll([
    () => inRange('puzuo', puzuo, DOUGONG_RANGES.puzuo, true),
    () => inRange('curlFacets', parabola.facets, DOUGONG_RANGES.curlFacets, true),
    () => inRange('curlRunFen', parabola.run, DOUGONG_RANGES.curlRunFen),
    () => inRange('curlDropFen', parabola.drop, DOUGONG_RANGES.curlDropFen),
    () => inRange('armThicknessFen', armThickness, DOUGONG_RANGES.armThicknessFen),
  ]);
  if (!checked.ok) return checked;
  if (
    curlKind === 'parabola' &&
    (parabola.run >= SHORTEST_CURLED_FEN / 2 || parabola.drop >= CAI_WIDTH_FEN)
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the juansha curve must fit inside the shortest wall member: run below half its length, drop below the cai width',
        { curlRunFen: parabola.run, curlDropFen: parabola.drop },
        'shorten curlRunFen or curlDropFen',
      ),
    );
  }
  const cai = caiFen(grade);
  if (!cai.ok) return cai;
  const fen = cai.value.fen;
  const F = (v: number): number => v * fen;
  const steps = puzuo - 3;
  const curl: Curl | 'fashi' = curlKind === 'fashi' ? 'fashi' : parabola;
  const id = (key: string): string => `${name}-${key}`;
  const half = armThickness / 2;

  const members = bracketMembers(puzuo);
  const dous = bracketDous(puzuo, members);
  const crosses = crossingsOf(members);
  const top = steps + 1;

  const placed: { part: Model; at: Tuple3 }[] = [];
  const anchors: Record<string, Tuple3> = {};
  const put = (key: string, part: Model, at: Tuple3): void => {
    placed.push({ part, at });
    anchors[key] = at;
  };
  /**
   * Top face of a tier's members, in meters: the same sum their top vertices get (member height
   * moved by the tier bottom), so a dou placed here sits on the member to the last bit. Converting
   * the fen sum instead lands one rounding step above it on some tiers, and the seat reads apart.
   */
  const memberTop = (tier: number): number => F(CAI_WIDTH_FEN) + F(memberBottomOf(tier));

  /** A dou with its loft and the grooves of the mouths that hold a member. */
  const douPart = (
    key: string,
    width: number,
    depth: number,
    height: number,
    grooves: { readonly x: boolean; readonly z: boolean },
  ): Result<Model, ModelingError> => {
    const profile = douProfile(width, depth, height);
    const quad = (hx: number, y: number, hz: number): Tuple3[] => [
      [F(-hx), F(y), F(-hz)],
      [F(hx), F(y), F(-hz)],
      [F(hx), F(y), F(hz)],
      [F(-hx), F(y), F(hz)],
    ];
    const m = model();
    m.loft({
      profiles: profile.sections.map(({ y, hx, hz }) => quad(hx, y, hz)),
      label: id(key),
    });
    if (m.poisoned !== undefined) return err(m.poisoned);
    if (m.count(sel.edges.dihedral('>', DOU_CREASE_DEG)) > 0) {
      m.markSharp(sel.edges.dihedral('>', DOU_CREASE_DEG));
    }
    const slotBottom = height - profile.ear;
    const centreY = F(slotBottom + (profile.ear + 2) / 2);
    const slotHeight = F(profile.ear + 2);
    if (grooves.x) {
      const slot = model();
      slot.box({ size: [F(width + 2), slotHeight, F(MOUTH_FEN)], center: [0, centreY, 0] });
      m.difference(slot, { label: id(key) });
    }
    if (grooves.z) {
      const slot = model();
      slot.box({ size: [F(MOUTH_FEN), slotHeight, F(depth + 2)], center: [0, centreY, 0] });
      m.difference(slot, { label: id(key) });
    }
    if (m.poisoned !== undefined) return err(m.poisoned);
    return ok(m);
  };

  /**
   * A member along its axis, built in its own frame and then placed. A z member is turned onto
   * the wall. Each crossing notches the x member from below and the z member from above, so the
   * halves meet at the middle of the member height.
   */
  const memberPart = (member: BracketMember): Result<Model, ModelingError> => {
    const y0 = memberBottomOf(member.tier);
    const length = member.to - member.from;
    const m = model();
    m.extrudePolygon({
      points: armOutline(length, CAI_WIDTH_FEN, member.ends === 'mazha-tou' ? 'mazha-tou' : curl, {
        start: true,
        end: true,
      }).map(([x, y]) => [F(x), F(y)] as Point2),
      depth: F(armThickness),
      label: id(member.key),
    });
    if (m.poisoned !== undefined) return err(m.poisoned);
    m.translate(sel.all(), [0, 0, -F(armThickness) / 2]);
    if (member.axis === 'z') m.rotate(sel.all(), 'y', -90);
    const origin: Tuple3 =
      member.axis === 'x' ? [F(member.from), F(y0), 0] : [F(member.across), F(y0), F(member.from)];
    m.translate(sel.all(), origin);
    if (m.poisoned !== undefined) return err(m.poisoned);
    const notch = (
      x0: number,
      x1: number,
      lo: number,
      hi: number,
      z0: number,
      z1: number,
    ): Model => {
      const n = model();
      n.box({
        size: [F(x1 - x0), F(hi - lo), F(z1 - z0)],
        center: [F((x0 + x1) / 2), F((lo + hi) / 2), F((z0 + z1) / 2)],
        label: id(member.key),
      });
      return n;
    };
    for (const c of crosses) {
      if (member.axis === 'x' && c.x === member.key) {
        m.difference(
          notch(c.at - half, c.at + half, y0 - 1, y0 + CAI_WIDTH_FEN / 2, -half - 1, half + 1),
          { label: id(member.key) },
        );
      }
      if (member.axis === 'z' && c.z === member.key) {
        m.difference(
          notch(
            member.across - half - 1,
            member.across + half + 1,
            y0 + CAI_WIDTH_FEN / 2,
            y0 + CAI_WIDTH_FEN + 1,
            -half,
            half,
          ),
          { label: id(member.key) },
        );
      }
      if (m.poisoned !== undefined) return err(m.poisoned);
    }
    return ok(m);
  };

  const contacts: DesignedContact[] = [];
  const seat = (a: string, b: string): DesignedContact => ({ parts: [id(a), id(b)], kind: 'seat' });
  const fit = (a: string, b: string): DesignedContact => ({
    parts: [id(a), id(b)],
    kind: 'fit',
    gap: [0, MOUTH_FIT_GAP],
  });

  for (const d of dous) {
    const mouths = mouthsOf(d, members);
    const grooves = {
      x: mouths.some((mo) => mo.axis === 'x' && mo.holds !== null),
      z: mouths.some((mo) => mo.axis === 'z' && mo.holds !== null),
    };
    const built = douPart(d.key, d.width, d.depth, d.height, grooves);
    if (!built.ok) return built;
    put(d.key, built.value, [F(d.at[0]), d.tier === 0 ? 0 : memberTop(d.tier), F(d.at[1])]);
    if (d.sitsOn !== null) contacts.push(seat(d.key, d.sitsOn));
    for (const mo of mouths) if (mo.holds !== null) contacts.push(fit(d.key, mo.holds));
  }

  for (const m of members) {
    const built = memberPart(m);
    if (!built.ok) return built;
    put(m.key, built.value, [0, 0, 0]);
    anchors[m.key] = [
      F(m.axis === 'x' ? (m.from + m.to) / 2 : m.across),
      F(memberBottomOf(m.tier) + CAI_WIDTH_FEN / 2),
      F(m.axis === 'x' ? 0 : (m.from + m.to) / 2),
    ];
  }
  for (const c of crosses) contacts.push(seat(c.x, c.z));

  const topTop = memberBottomOf(top) + CAI_WIDTH_FEN;
  const height = maxOf([
    topTop + QIXIN_DOU.height,
    ...dous.map((d) => (d.tier === 0 ? 0 : memberBottomOf(d.tier) + CAI_WIDTH_FEN) + d.height),
  ]);
  anchors.top = [0, F(height), 0];

  const m = model();
  for (const { part, at } of placed) {
    if (part.poisoned !== undefined) return err(part.poisoned);
    m.append(part, { translate: at, tag: name });
  }
  if (m.poisoned !== undefined) return err(m.poisoned);

  const mouthTotal = dous.flatMap((d) => mouthsOf(d, members));
  const finished = finishPart(m, name, anchors, {
    fen,
    grade: cai.value.grade,
    puzuo,
    steps,
    jumpFen: JUMP_FEN,
    stackHeight: F(height),
    projection: F(shuatouTipOf(steps)),
    mangongLength: F(2 * MAN_GONG_HALF_FEN),
    armThickness: F(armThickness),
    mouth: F(MOUTH_FEN),
    memberCount: members.length,
    luDouCount: 1,
    jiaohuDouCount: dous.filter((d) => d.kind === 'jiaohu').length,
    sanDouCount: dous.filter((d) => d.kind === 'san').length,
    qixinDouCount: dous.filter((d) => d.kind === 'qixin').length,
    halvedCrossingCount: crosses.length,
    emptyMouthCount: mouthTotal.filter((mo) => mo.holds === null).length,
  });
  if (!finished.ok) return finished;
  return ok({ ...finished.value, contacts });
}
