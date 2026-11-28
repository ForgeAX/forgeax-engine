import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { box, cylinder } from '../../src/brep/build.ts';
import { measure } from '../../src/brep/measure.ts';
import {
  applyPattern,
  circularPattern,
  linearPattern,
  mirrorPair,
} from '../../src/brep/pattern.ts';
import { tessellate } from '../../src/brep/tessellate.ts';
import { transformShape } from '../../src/brep/transform.ts';
import type { Shape } from '../../src/brep/types.ts';
import { validate } from '../../src/brep/validate.ts';
import type { P3 } from '../../src/brep/vec.ts';
import { must } from '../brep-heal/damage.ts';
import { contactSheet, featureLines, type Image, renderScene, toPng } from '../brep-kit/index.ts';
import { meshSurface } from '../brep-kit/mesh-scene.ts';

const Z = { origin: [0, 0, 0] as P3, direction: [0, 0, 1] as P3 };

/** A through bore turned 0.37 rad about its own axis (its seam is then off the host's), moved to `at`. */
export function bore(radius: number, at: P3, height = 20): Shape {
  const c = Math.cos(0.37);
  const s = Math.sin(0.37);
  const rot: [P3, P3, P3] = [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
  return must(transformShape(must(cylinder({ radius, height })), { rot, t: at }));
}

export interface PatternCase {
  readonly name: string;
  readonly shape: Shape;
  readonly copies: number;
  readonly expectedVolume: number;
}

const flange = () => must(cylinder({ radius: 40, height: 8 }));
const flangeVolume = (bores: number, r: number) => Math.PI * (1600 - bores * r * r) * 8;

function boltCircle(n: number, r: number, at: number): PatternCase {
  const tools = must(circularPattern(bore(r, [at, 0, 0]), { axis: Z, count: n }));
  return {
    name: `flange, ${n} bores r${r} on r${at}`,
    shape: must(applyPattern(flange(), tools)),
    copies: n,
    expectedVolume: flangeVolume(n, r),
  };
}

function holeGrid(nx: number, ny: number, pitch: number, r: number): PatternCase {
  const tools: Shape[] = [];
  for (let j = 0; j < ny; j++) {
    const start = bore(r, [(-pitch * (nx - 1)) / 2, (-pitch * (ny - 1)) / 2 + j * pitch, 0]);
    tools.push(...must(linearPattern(start, { direction: [1, 0, 0], spacing: pitch, count: nx })));
  }
  const plate = must(box({ size: [100, 70, 8] }));
  return {
    name: `plate, ${nx} x ${ny} holes r${r} pitch ${pitch}`,
    shape: must(applyPattern(plate, tools)),
    copies: nx * ny,
    expectedVolume: 100 * 70 * 8 - nx * ny * Math.PI * r * r * 8,
  };
}

/** A flange with a bolt circle plus a centre bore pair that is the half turn of one tool. */
function pairedFlange(): PatternCase {
  const bolts = must(circularPattern(bore(3, [30, 0, 0]), { axis: Z, count: 6 }));
  const pair = must(mirrorPair(bore(7, [12, 0, 0]), Z));
  return {
    name: 'flange, 6 bolts + a half-turn pair r7',
    shape: must(applyPattern(flange(), [...bolts, ...pair])),
    copies: 8,
    expectedVolume: flangeVolume(6, 3) - 2 * Math.PI * 49 * 8,
  };
}

export const PATTERN_CASES: Readonly<Record<string, () => PatternCase>> = {
  bolt6: () => boltCircle(6, 3.5, 30),
  bolt12: () => boltCircle(12, 2.5, 33),
  grid3x4: () => holeGrid(3, 4, 20, 4),
  paired: pairedFlange,
};

const draw = (shape: Shape, size: number): Image =>
  renderScene(
    {
      tris: meshSurface(must(tessellate(shape, { angle: Math.PI / 32 })), { dim: 0.38 }),
      lines: featureLines(shape),
      markers: [],
    },
    'iso',
    { size },
  );

export interface PatternRow {
  readonly name: string;
  readonly copies: number;
  readonly faces: number;
  readonly volume: number;
  readonly volumeError: number;
  readonly valid: boolean;
}

export function renderPatterns(outDir: string, size = 360): PatternRow[] {
  mkdirSync(outDir, { recursive: true });
  const rows: PatternRow[] = [];
  const cells: { image: Image; caption: string }[] = [];
  for (const make of Object.values(PATTERN_CASES)) {
    const c = make();
    const volume = must(measure(c.shape)).volume;
    const row: PatternRow = {
      name: c.name,
      copies: c.copies,
      faces: c.shape.faces.length,
      volume,
      volumeError: Math.abs(volume - c.expectedVolume),
      valid: validate(c.shape).ok,
    };
    rows.push(row);
    cells.push({
      image: draw(c.shape, size),
      caption: `${c.name}: ${row.faces} faces, volume ${volume.toFixed(2)} (err ${row.volumeError.toExponential(1)})`,
    });
  }
  const sheet = contactSheet(cells, {
    columns: 2,
    cell: size,
    title: 'pattern tools: copies of one bore, chained booleans',
  });
  writeFileSync(join(outDir, 'pattern-sheet.png'), toPng(sheet));
  return rows;
}
