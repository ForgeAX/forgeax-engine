// Timber recipes at their defaults, drawn with the brep-kit software rasterizer: flat-shaded
// faces, crease and boundary edges, one contact sheet. The recipes build with Y up; the kit
// draws Z up, so a model point (x, y, z) is shown at (x, -z, y).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Result } from '@forgeax/engine-types';
import { type ModelingError } from '../../src/errors.ts';
import type { EditMesh } from '../../src/mesh.ts';
import { EDGE_SHARP } from '../../src/mesh.ts';
import {
  dougong,
  type DougongPuzuo,
  juzheRoof,
  type JuzheKind,
  type LatticePattern,
  latticePattern,
  type RecipePart,
  tileRows,
  type TimberJointKind,
  timberJoint,
} from '../../src/recipes/index.ts';
import { JUZHE_RATIO, juzhePurlins } from '../../src/recipes/juzhe-roof.ts';
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
const BLOCK: RGB = [214, 188, 146];
const ARM: RGB = [160, 150, 128];
const XIE: RGB = [186, 164, 130];
const ROOF: RGB = [150, 158, 170];
const TILE: RGB = [190, 120, 92];
const PANEL: RGB = [206, 196, 176];
/** Dihedral threshold (degrees) for drawing a crease line between two faces. */
const CREASE_DEG = 5;
const POST_WIDTH = 0.1;

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Model point to the kit's Z-up frame, then an optional world offset. */
function upright(p: readonly number[], shift: P3): P3 {
  return [(p[0] ?? 0) + shift[0], -(p[2] ?? 0) + shift[1], (p[1] ?? 0) + shift[2]];
}

interface Piece {
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
    n = [n[0] + (p[1] - q[1]) * (p[2] + q[2]), n[1] + (p[2] - q[2]) * (p[0] + q[0]), n[2] + (p[0] - q[0]) * (p[1] + q[1])];
  }
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Lines on creases above CREASE_DEG and on edges that have only one face in this piece. */
function edgeLines(poly: PolyMesh): SceneLine[] {
  const normals = poly.faces.map((loop) => unitNormal(poly.positions, loop));
  const seen = new Map<string, { a: number; b: number; faces: number[] }>();
  poly.faces.forEach((loop, f) =>
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = seen.get(key);
      if (entry === undefined) seen.set(key, { a, b, faces: [f] });
      else entry.faces.push(f);
    }),
  );
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
  readonly scene: Scene;
}

interface KitRow {
  readonly file: string;
  readonly faces: number;
  readonly closed: boolean;
  readonly valid: boolean;
}

const ISO: ViewSpec = 'iso';
const FRONT: ViewSpec = 'front';
const SIDE: ViewSpec = 'side';
/** Close-ups of the roof tiles: a low eave view and a view down onto the first fold. */
const EAVE: ViewSpec = { name: 'eave', azimuth: 30, elevation: 15 };
const FOLD: ViewSpec = { name: 'fold', azimuth: 60, elevation: 35 };

function joint(kind: TimberJointKind, apart: boolean) {
  const part = must(timberJoint({ postWidth: POST_WIDTH, kind }));
  const mesh = part.model.editMesh;
  const beam = (label: string) => label.startsWith('timber-joint-beam');
  // The beam leaves the mortise along -X, so it is pulled out past the tenon's reach and a margin.
  const pull = apart ? -(part.dimensions.tenonReach as number) - 0.2 * POST_WIDTH : 0;
  const shift: P3 = [pull, 0, 0];
  return {
    part,
    pieces: [
      pieceOf(mesh, WOOD_POST, (label) => !beam(label)),
      pieceOf(mesh, WOOD_BEAM, beam, shift),
    ],
  };
}

function dougongParts(puzuo: DougongPuzuo) {
  const part = must(dougong({ puzuo, name: `dougong-${puzuo}` }));
  const mesh = part.model.editMesh;
  const prefix = `dougong-${puzuo}-`;
  const key = (label: string) => label.slice(prefix.length);
  const isXie = (label: string) => key(label).startsWith('xie');
  const isBlock = (label: string) => !isXie(label) && key(label).includes('dou');
  return {
    part,
    pieces: [
      pieceOf(mesh, XIE, isXie),
      pieceOf(mesh, BLOCK, (label) => isBlock(label)),
      pieceOf(mesh, ARM, (label) => !isXie(label) && !isBlock(label)),
    ],
  };
}

function juzheParts(kind: JuzheKind) {
  const name = `juzhe-roof-${kind}`;
  const part = must(juzheRoof({ kind, name }));
  return { part, pieces: [pieceOf(part.model.editMesh, ROOF)] };
}

function tileParts() {
  const run = 0.9;
  const ridge = JUZHE_RATIO.pavilion * run;
  const purlins = juzhePurlins(ridge, run, 3);
  const part = must(tileRows({ purlins, name: 'tile-rows' }));
  return { part, pieces: [pieceOf(part.model.editMesh, TILE)] };
}

function latticeParts(pattern: LatticePattern, seed?: number) {
  const part = must(
    latticePattern(seed === undefined ? { pattern, name: `lattice-${pattern}` } : { pattern, seed, name: `lattice-${pattern}` }),
  );
  return { part, pieces: [pieceOf(part.model.editMesh, PANEL)] };
}

interface Built {
  readonly key: string;
  readonly recipe: RecipePart;
  readonly pieces: readonly Piece[];
  readonly pictures: readonly Picture[];
}

/** Every part with its views; the file name is the key of the picture. */
function buildAll(): Built[] {
  const built: Built[] = [];
  const add = (
    key: string,
    made: { part: RecipePart; pieces: readonly Piece[] },
    views: readonly { file: string; caption: string; view: ViewSpec }[],
  ) => {
    const pictures = views.map((v) => ({
      ...v,
      scene: sceneOf(made.pieces),
    }));
    built.push({ key, recipe: made.part, pieces: made.pieces, pictures });
  };

  for (const kind of ['through', 'blind'] as const) {
    // A blind pocket opens on the -X face, which the default iso view (from +X) hides.
    const back = { file: `timber-joint-${kind}-back.png`, caption: `timber joint ${kind}, back`, view: 'iso-back' as const };
    add(`timber-joint-${kind}`, joint(kind, true), [
      { file: `timber-joint-${kind}.png`, caption: `timber joint ${kind}, apart`, view: ISO },
      back,
    ]);
    add(`timber-joint-${kind}-assembled`, joint(kind, false), [
      { file: `timber-joint-${kind}-assembled.png`, caption: `timber joint ${kind}, assembled`, view: ISO },
    ]);
  }
  for (const puzuo of [4, 5] as const) {
    add(`dougong-${puzuo}`, dougongParts(puzuo), [
      { file: `dougong-${puzuo}.png`, caption: `dougong ${puzuo} puzuo, three-quarter`, view: ISO },
      { file: `dougong-${puzuo}-side.png`, caption: `dougong ${puzuo} puzuo, side`, view: SIDE },
    ]);
  }
  add('juzhe-roof', juzheParts('pavilion'), [
    { file: 'juzhe-roof.png', caption: 'juzhe roof pavilion, profile', view: FRONT },
    { file: 'juzhe-roof-iso.png', caption: 'juzhe roof pavilion, three-quarter', view: ISO },
  ]);
  add('juzhe-roof-hall', juzheParts('hall'), [
    { file: 'juzhe-roof-hall.png', caption: 'juzhe roof hall, profile', view: FRONT },
  ]);
  add('tile-rows', tileParts(), [
    { file: 'roof-tiles-iso.png', caption: 'roof tiles, pavilion three-quarter', view: ISO },
    { file: 'roof-tiles-eave.png', caption: 'roof tiles, eave close-up', view: EAVE },
    { file: 'roof-tiles-fold.png', caption: 'roof tiles, fold mitre close-up', view: FOLD },
    { file: 'roof-profile.png', caption: 'roof tiles, cross-section profile', view: FRONT },
  ]);
  for (const pattern of ['bubujin', 'guibeijin', 'huiwen'] as const) {
    add(`lattice-${pattern}`, latticeParts(pattern), [
      { file: `lattice-${pattern}.png`, caption: `lattice ${pattern}, front`, view: FRONT },
    ]);
  }
  add('lattice-binglie', latticeParts('binglie', 7), [
    { file: 'lattice-binglie.png', caption: 'lattice binglie seed 7, front', view: FRONT },
  ]);
  return built;
}

export interface TimberKitResult {
  readonly rows: readonly KitRow[];
  readonly files: readonly string[];
}

/**
 * Builds every timber recipe at its defaults, checks each closed and valid, and writes one PNG per
 * picture plus a contact sheet into `outDir`. `size` is the picture edge in pixels.
 */
export function renderTimberKit(outDir: string, size = 720): TimberKitResult {
  mkdirSync(outDir, { recursive: true });
  const rows: KitRow[] = [];
  const files: string[] = [];
  const cells: SheetCell[] = [];
  for (const b of buildAll()) {
    const report = b.recipe.model.validate({ contacts: b.recipe.contacts ?? [] });
    rows.push({
      file: b.key,
      faces: b.recipe.model.editMesh.faces().length,
      closed: report.closed,
      valid: report.pass,
    });
    for (const picture of b.pictures) {
      const image: Image = renderScene(picture.scene, picture.view, {
        size,
        background: BACKGROUND,
      });
      const path = join(outDir, picture.file);
      writeFileSync(path, toPng(image));
      files.push(path);
      cells.push({ image, caption: picture.caption });
    }
  }
  const sheet = join(outDir, 'timber-kit-sheet.png');
  writeFileSync(
    sheet,
    toPng(
      contactSheet(cells, {
        columns: 4,
        cell: Math.round(size / 2),
        title: 'timber kit: recipes at defaults and variants (Y up, shown Z up)',
      }),
    ),
  );
  files.push(sheet);
  return { rows, files };
}
