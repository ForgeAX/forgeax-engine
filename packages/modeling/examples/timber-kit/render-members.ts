// Member-level timber pictures: one dou block, one gong arm, the four- and five-puzuo bracket sets in
// three-quarter and front views, and the through and blind mortise-and-tenon joints apart and
// assembled. The recipes build with Y up; the kit draws Z up, so a model point (x, y, z) is shown
// at (x, -z, y). Shares the piece and edge helpers of render.ts without editing it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Result } from '@forgeax/engine-types';
import type { ModelingError } from '../../src/errors.ts';
import type { EditMesh } from '../../src/mesh.ts';
import { EDGE_SHARP } from '../../src/mesh.ts';
import {
  type BracketDou,
  type BracketMember,
  bracketDous,
  bracketMembers,
  crossingsOf,
  type DougongPuzuo,
  mouthsOf,
  supportReport,
} from '../../src/recipes/dougong.ts';
import {
  caiFen,
  dougong,
  type RecipePart,
  type TimberJointKind,
  timberJoint,
} from '../../src/recipes/index.ts';
import type { ViewSpec } from '../brep-kit/camera.ts';
import { type RGB, toPng } from '../brep-kit/image.ts';
import { contactSheet, type Image, type SheetCell } from '../brep-kit/index.ts';
import { meshSurface, type PolyMesh } from '../brep-kit/mesh-scene.ts';
import { renderScene } from '../brep-kit/raster.ts';
import type { P3, Scene, SceneLine, SceneTri } from '../brep-kit/scene.ts';

const BACKGROUND: RGB = [236, 238, 242];
const EDGE: RGB = [30, 34, 42];
const WOOD_POST: RGB = [182, 150, 112];
const WOOD_BEAM: RGB = [206, 170, 124];
const PEG: RGB = [120, 84, 52];
const BLOCK: RGB = [214, 188, 146];
const ARM: RGB = [160, 150, 128];
/** Dihedral threshold (degrees) for drawing a crease line between two faces. */
const CREASE_DEG = 5;
const POST_WIDTH = 0.1;
/** Renderer default fit (brep-kit raster). The fit uses the projected box of the whole model. */
const DEFAULT_FILL = 0.86;
/** Bracket sets are flat, so their projected box leaves most of the square empty; fill it wider. */
const SET_FILL = 1.2;
const ISO: ViewSpec = 'iso';
const FRONT: ViewSpec = 'front';
const SIDE: ViewSpec = 'side';

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Model point to the kit's Z-up frame, then an optional world offset. */
function upright(p: readonly number[], shift: P3): P3 {
  return [(p[0] ?? 0) + shift[0], -(p[2] ?? 0) + shift[1], (p[1] ?? 0) + shift[2]];
}

export interface Piece {
  readonly poly: PolyMesh;
  readonly color: RGB;
}

/** Faces of `mesh` whose label passes `keep`, moved into the kit frame and shifted by `shift`. */
function pieceOf(
  mesh: EditMesh,
  color: RGB,
  keep: (label: string) => boolean = () => true,
  shift: P3 = [0, 0, 0],
): Piece {
  const index = new Map<number, number>();
  const positions: P3[] = [];
  const indexOf = (v: number): number => {
    let i = index.get(v);
    if (i === undefined) {
      i = positions.length;
      index.set(v, i);
      positions.push(upright(mesh.position(v), shift));
    }
    return i;
  };
  const faces: number[][] = [];
  for (const f of mesh.faces()) {
    const label = mesh.labelNames[mesh.fLabel[f] as number] ?? '';
    if (keep(label)) faces.push(mesh.faceVertices(f).map(indexOf));
  }
  const sharp: [number, number][] = [];
  for (const e of mesh.edges()) {
    if (((mesh.eFlags[e] as number) & EDGE_SHARP) === 0) continue;
    const [a, b] = mesh.edgeVertices(e);
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined) sharp.push([ia, ib]);
  }
  return { poly: { positions, faces, sharp }, color };
}

function unitNormal(positions: readonly P3[], loop: readonly number[]): P3 {
  // Newell's method: robust for any simple planar polygon.
  let n: P3 = [0, 0, 0];
  for (let i = 0; i < loop.length; i++) {
    const p = positions[loop[i] as number] as P3;
    const q = positions[loop[(i + 1) % loop.length] as number] as P3;
    n = [
      n[0] + (p[1] - q[1]) * (p[2] + q[2]),
      n[1] + (p[2] - q[2]) * (p[0] + q[0]),
      n[2] + (p[0] - q[0]) * (p[1] + q[1]),
    ];
  }
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Lines on creases above CREASE_DEG and on edges that have only one face in this piece. */
function edgeLines(poly: PolyMesh): SceneLine[] {
  const normals = poly.faces.map((loop) => unitNormal(poly.positions, loop));
  const seen = new Map<string, { a: number; b: number; faces: number[] }>();
  for (const [f, loop] of poly.faces.entries()) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = seen.get(key);
      if (entry === undefined) seen.set(key, { a, b, faces: [f] });
      else entry.faces.push(f);
    }
  }
  const out: SceneLine[] = [];
  for (const { a, b, faces } of seen.values()) {
    const [f0, f1] = faces;
    let draw = faces.length === 1;
    if (f0 !== undefined && f1 !== undefined) {
      const n0 = normals[f0] as P3;
      const n1 = normals[f1] as P3;
      const cos = Math.min(1, Math.max(-1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
      draw = (Math.acos(cos) * 180) / Math.PI > CREASE_DEG;
    }
    if (draw)
      out.push({
        points: [poly.positions[a] as P3, poly.positions[b] as P3],
        color: EDGE,
        width: 1.4,
      });
  }
  return out;
}

function sceneOf(pieces: readonly Piece[]): Scene {
  return {
    tris: pieces.flatMap(({ poly, color }): SceneTri[] => meshSurface(poly, { color })),
    lines: pieces.flatMap(({ poly }) => edgeLines(poly)),
    markers: [],
  };
}

interface Picture {
  readonly file: string;
  readonly caption: string;
  readonly view: ViewSpec;
  readonly fill?: number;
  readonly scene: Scene;
}

interface Built {
  readonly key: string;
  readonly recipe: RecipePart;
  readonly pictures: readonly Picture[];
}

/** Member key of a face label: the label minus its `<name>-` prefix. */
function keyOf(name: string): (label: string) => string {
  const prefix = `${name}-`;
  return (label) => label.slice(prefix.length);
}

/** One dou block: the lu dou alone, from the bracket set's first tier. */
function douBlockParts() {
  const name = 'dou-block';
  const part = must(dougong({ puzuo: 4, name }));
  const mesh = part.model.editMesh;
  const key = keyOf(name);
  return {
    part,
    pieces: [pieceOf(mesh, BLOCK, (label) => key(label) === 'ludou')],
  };
}

/** One gong arm: the huagong of the first tier (one timber through the axis), drawn alone. */
function gongArmParts() {
  const name = 'gong-arm';
  const part = must(dougong({ puzuo: 4, name }));
  const mesh = part.model.editMesh;
  const key = keyOf(name);
  return { part, pieces: [pieceOf(mesh, ARM, (label) => key(label) === 'huagong-1')] };
}

/** Tier of every member and dou key of a set, from the round-5 tables (ludou is tier 0). */
export function tierOfKeys(puzuo: DougongPuzuo): Map<string, number> {
  const members = bracketMembers(puzuo);
  const out = new Map<string, number>();
  for (const m of members) out.set(m.key, m.tier);
  for (const d of bracketDous(puzuo, members)) out.set(d.key, d.tier);
  return out;
}

/** Dou keys of a set, from the round-5 table: every dou block (ludou, jiaohu, san, qixin). */
function douKeys(puzuo: DougongPuzuo): Set<string> {
  return new Set(bracketDous(puzuo, bracketMembers(puzuo)).map((d) => d.key));
}

/** Exploded set: each tier moves up as one rigid group, this many cai heights per tier. */
const EXPLODE_TIER_CAI = 2;

/** Vertical (kit Z) extent of a piece list, in meters. */
export function zExtentOf(pieces: readonly Piece[]): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const { poly } of pieces) {
    for (const p of poly.positions) {
      lo = Math.min(lo, p[2]);
      hi = Math.max(hi, p[2]);
    }
  }
  return hi - lo;
}

/**
 * Bracket set pieces. Assembled: dous and arms in two colours. Exploded: every tier (its dous and arms
 * together) is lifted as one rigid group, so neighbouring tiers separate by two cai heights and
 * members of one tier stay together.
 */
export function dougongParts(puzuo: DougongPuzuo, exploded = false) {
  const name = `dougong-${puzuo}`;
  const part = must(dougong({ puzuo, name }));
  const mesh = part.model.editMesh;
  const key = keyOf(name);
  const blocks = douKeys(puzuo);
  const isBlock = (label: string) => blocks.has(key(label));
  const isArm = (label: string) => !isBlock(label);
  if (!exploded) {
    return {
      part,
      pieces: [pieceOf(mesh, BLOCK, isBlock), pieceOf(mesh, ARM, isArm)],
    };
  }
  const tiers = tierOfKeys(puzuo);
  const pieces: Piece[] = [];
  for (const tier of new Set(tiers.values())) {
    const shift: P3 = [0, 0, explodeShiftOf(tier)];
    const inTier = (label: string) => tiers.get(key(label)) === tier;
    pieces.push(
      pieceOf(mesh, BLOCK, (label) => isBlock(label) && inTier(label), shift),
      pieceOf(mesh, ARM, (label) => isArm(label) && inTier(label), shift),
    );
  }
  return { part, pieces: pieces.filter((p) => p.poly.faces.length > 0) };
}

/** Exploded lift (kit Z, meters) of a tier: every dou and arm of that tier moves by this amount. */
export function explodeShiftOf(tier: number): number {
  return tier * must(caiFen(6)).width * EXPLODE_TIER_CAI;
}


/** The joint, its beam pulled out along -X when apart, and its peg drawn in its own colour. */
function jointParts(kind: TimberJointKind, apart: boolean) {
  const part = must(timberJoint({ postWidth: POST_WIDTH, kind, name: `timber-joint-${kind}` }));
  const mesh = part.model.editMesh;
  const prefix = `timber-joint-${kind}-`;
  const key = (label: string) => label.slice(prefix.length);
  const isBeam = (label: string) => key(label).startsWith('beam');
  const isPeg = (label: string) => key(label) === 'beam-peg';
  // The beam leaves the mortise along -X, so it is pulled out past the tenon's reach and a margin.
  const pull = apart ? -(part.dimensions.tenonReach as number) - 0.2 * POST_WIDTH : 0;
  const shift: P3 = [pull, 0, 0];
  return {
    part,
    pieces: [
      pieceOf(mesh, WOOD_POST, (label) => !isBeam(label) && !isPeg(label)),
      pieceOf(mesh, WOOD_BEAM, (label) => isBeam(label) && !isPeg(label), shift),
      pieceOf(mesh, PEG, isPeg, shift),
    ],
  };
}

/**
 * Load-path listing of a bracket set, read from the round-5 tables: one row per member with its
 * support verdict, the dous whose mouths hold it, and the members it is halved with; then one row per
 * dou with what it sits on and what each of its mouths holds. The picture shows the geometry.
 */
function loadPathRows(puzuo: DougongPuzuo): string[] {
  const members: readonly BracketMember[] = bracketMembers(puzuo);
  const dous: readonly BracketDou[] = bracketDous(puzuo, members);
  const memberRows = supportReport(members, dous).map(
    (row) =>
      `member ${row.key} tier ${row.tier}: ${row.verdict}; mouths [${row.mouths.join(', ') || 'none'}]; halved with [${row.crossings.join(', ') || 'none'}]`,
  );
  const douRows = dous.map((d) => {
    const mouths = mouthsOf(d, members).map((mo) => `${mo.axis}=${mo.holds ?? 'empty'}`);
    return `dou ${d.key} (${d.kind}) tier ${d.tier} sits on ${d.sitsOn ?? 'ground'}; mouths ${mouths.join(', ') || 'none'}`;
  });
  const halved = crossingsOf(members).length;
  return [
    `dougong-${puzuo} load path: ${members.length} members, ${dous.length} dous, ${halved} halved crossings`,
    ...memberRows,
    ...douRows,
  ];
}

function buildAll(): Built[] {
  const built: Built[] = [];
  const add = (
    key: string,
    made: { part: RecipePart; pieces: readonly Piece[] },
    views: readonly {
      file: string;
      caption: string;
      view: ViewSpec;
      fill?: number;
    }[],
  ) => {
    const pictures = views.map((v) => ({
      ...v,
      scene: sceneOf(made.pieces),
    }));
    built.push({ key, recipe: made.part, pictures });
  };

  add('dougong-4 (dou-block picture)', douBlockParts(), [
    { file: 'dou-block.png', caption: 'lu dou, three-quarter', view: ISO },
    { file: 'dou-profile.png', caption: 'lu dou, side profile (4:2:4 bands)', view: SIDE },
  ]);
  add('dougong-4 (gong-arm picture)', gongArmParts(), [
    { file: 'gong-arm.png', caption: 'huagong arm with curled tip', view: ISO },
  ]);
  add('dougong-4', dougongParts(4), [
    {
      file: 'dougong-4-iso.png',
      caption: 'dougong four puzuo, three-quarter',
      view: ISO,
      fill: SET_FILL,
    },
    { file: 'dougong-4.png', caption: 'dougong four puzuo, front', view: FRONT },
    { file: 'dougong-4-side.png', caption: 'dougong four puzuo, side', view: SIDE },
  ]);
  add('dougong-5 (load path)', dougongParts(5), [
    {
      file: 'dougong-5-load-path.png',
      caption: 'dougong five puzuo, front; load path in dougong-5-load-path.txt',
      view: FRONT,
      fill: SET_FILL,
    },
  ]);
  add('dougong-5', dougongParts(5), [
    {
      file: 'dougong-5-iso.png',
      caption: 'dougong five puzuo, three-quarter',
      view: ISO,
      fill: SET_FILL,
    },
    { file: 'dougong-5-front.png', caption: 'dougong five puzuo, front', view: FRONT },
    { file: 'dougong-5-side.png', caption: 'dougong five puzuo, side', view: SIDE },
  ]);
  add('dougong-5 (exploded)', dougongParts(5, true), [
    {
      file: 'dougong-5-exploded.png',
      caption: 'dougong five puzuo, tiers apart (2 cai per tier)',
      view: ISO,
      fill: SET_FILL,
    },
  ]);
  add('dougong-4 (exploded)', dougongParts(4, true), [
    {
      file: 'dougong-4-exploded.png',
      caption: 'dougong four puzuo, tiers apart (2 cai per tier)',
      view: ISO,
      fill: SET_FILL,
    },
  ]);
  for (const kind of ['through', 'blind'] as const) {
    add(`timber-joint-${kind}`, jointParts(kind, true), [
      { file: `joint-${kind}-exploded.png`, caption: `${kind} joint, beam pulled out`, view: ISO },
      { file: `joint-${kind}-side.png`, caption: `${kind} joint, side`, view: SIDE },
    ]);
    add(`timber-joint-${kind}-assembled`, jointParts(kind, false), [
      { file: `joint-${kind}-assembled.png`, caption: `${kind} joint, assembled`, view: ISO },
    ]);
  }
  return built;
}

export interface MemberKitRow {
  readonly key: string;
  readonly faces: number;
  readonly closed: boolean;
  readonly valid: boolean;
  readonly confirmedCrossings: number;
}

export interface MemberKitResult {
  readonly rows: readonly MemberKitRow[];
  readonly files: readonly string[];
  /** Share of the picture edge spanned by drawn (non-background) pixels, per picture. */
  readonly coverage: readonly {
    readonly file: string;
    readonly width: number;
    readonly height: number;
  }[];
}

/** Bounding box of pixels that differ from the background, as fractions of the picture edges. */
function coverageOf(image: Image, background: RGB): { width: number; height: number } {
  let x0 = image.width;
  let x1 = -1;
  let y0 = image.height;
  let y1 = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (
        image.rgba[i] === background[0] &&
        image.rgba[i + 1] === background[1] &&
        image.rgba[i + 2] === background[2]
      ) {
        continue;
      }
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return { width: 0, height: 0 };
  return { width: (x1 - x0 + 1) / image.width, height: (y1 - y0 + 1) / image.height };
}

function confirmed(issues: readonly { code: string; detail?: unknown }[]): number {
  return issues.filter(
    (i) =>
      i.code === 'self-intersection' &&
      (i.detail as { certainty?: string } | undefined)?.certainty === 'confirmed',
  ).length;
}

/**
 * Builds the member pictures, checks each closed, and writes one PNG per picture plus a contact
 * sheet into `outDir`. `size` is the picture edge in pixels.
 */
export function renderTimberMembers(outDir: string, size = 768): MemberKitResult {
  mkdirSync(outDir, { recursive: true });
  const rows: MemberKitRow[] = [];
  const files: string[] = [];
  const coverage: { file: string; width: number; height: number }[] = [];
  const cells: SheetCell[] = [];
  for (const b of buildAll()) {
    const report = b.recipe.model.validate({ contacts: b.recipe.contacts ?? [] });
    rows.push({
      key: b.key,
      faces: b.recipe.model.editMesh.faces().length,
      closed: report.closed,
      valid: report.pass,
      confirmedCrossings: confirmed(report.issues),
    });
    for (const picture of b.pictures) {
      const image: Image = renderScene(picture.scene, picture.view, {
        size,
        background: BACKGROUND,
        fill: picture.fill ?? DEFAULT_FILL,
      });
      const path = join(outDir, picture.file);
      writeFileSync(path, toPng(image));
      files.push(path);
      if (picture.file === 'dougong-5-load-path.png') {
        const listing = join(outDir, 'dougong-5-load-path.txt');
        writeFileSync(listing, `${loadPathRows(5).join('\n')}\n`);
        files.push(listing);
      }
      coverage.push({ file: picture.file, ...coverageOf(image, BACKGROUND) });
      cells.push({ image, caption: picture.caption });
    }
  }
  const sheet = join(outDir, 'timber-members-sheet.png');
  writeFileSync(
    sheet,
    toPng(
      contactSheet(cells, {
        columns: 4,
        cell: Math.round(size / 2),
        title: 'timber members: dou, arm, dougong and mortise-and-tenon joints (Y up, shown Z up)',
      }),
    ),
  );
  files.push(sheet);
  return { rows, files, coverage };
}
