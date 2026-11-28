// Rows 3 and 5: quad iso layout of planar holed faces and circular outer loops at current trunk, plus the
// plate-with-hole reference against the merged holed faces (through-slot top, bracket end state).
import { boxWithThroughHole } from '../../src/brep/boolean-hole.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { SheetCell } from '../brep-kit/sheet.ts';
import { PATTERN_CASES } from '../brep-pattern/render.ts';
import { buildBracket } from '../planar-boolean/bracket.ts';
import {
  caption,
  finish,
  metricLine,
  must,
  QUAD_MODES,
  type QuadMode,
  record,
  refusalImage,
  runQuad,
  savePng,
  saveSheet,
} from './common.ts';
import { networkImages, shapeImages } from './render-solid.ts';
import { slotBlock } from './solids.ts';

const pattern = (key: string): Shape => (PATTERN_CASES[key] as () => { shape: Shape })().shape;

interface Case {
  readonly name: string;
  readonly shape: Shape;
  readonly sizes: readonly number[];
  readonly compareSize: number;
}

const cases: Case[] = [
  { name: 'plate-grid3x4', shape: pattern('grid3x4'), sizes: [5, 3, 2.2, 1.5], compareSize: 3 },
  { name: 'flange-bolt6', shape: pattern('bolt6'), sizes: [1, 0.8, 0.5], compareSize: 0.8 },
  { name: 'flange-bolt12', shape: pattern('bolt12'), sizes: [1, 0.8, 0.5], compareSize: 0.8 },
];

for (const c of cases) {
  const { shaded } = shapeImages(c.shape);
  caption(shaded, [c.name, 'shaded iso']);
  savePng(`iso/${c.name}-shaded-iso.png`, shaded);
  const sizeCells: SheetCell[] = [{ image: shaded, caption: `${c.name}: shaded iso` }];
  for (const size of c.sizes) {
    const run = runQuad(c.shape, 'iso', size);
    record({ row: 'iso-layout', solid: c.name, ...run.row });
    if (run.result === undefined) {
      sizeCells.push({
        image: refusalImage(['REFUSED', String(run.row.reason)]),
        caption: `iso size ${size}: REFUSED ${String(run.row.reason)} (face ${String(run.row.face)})`,
      });
      continue;
    }
    const net = networkImages(run.result);
    for (const view of ['top', 'iso'] as const) {
      const image = net[view];
      if (image === undefined) continue;
      caption(image, [`${c.name} iso size ${size} ${view}`, metricLine(run.row)]);
      savePng(`iso/${c.name}-iso-${size}-network-${view}.png`, image);
      if (view === 'top')
        sizeCells.push({ image, caption: `iso size ${size}: ${metricLine(run.row)}` });
    }
  }
  saveSheet(`sheets/${c.name}-iso-sizes.png`, sizeCells, {
    columns: 3,
    cell: 460,
    title: `${c.name}: iso layout across element sizes (minSJ in captions)`,
  });
  const modeCells: SheetCell[] = [];
  for (const mode of QUAD_MODES) {
    const run = runQuad(c.shape, mode, c.compareSize);
    record({ row: 'mode-compare', solid: c.name, ...run.row });
    const image = run.result === undefined ? undefined : networkImages(run.result, ['top']).top;
    if (image === undefined) {
      modeCells.push({
        image: refusalImage(['REFUSED', String(run.row.reason)]),
        caption: `${mode} size ${c.compareSize}: REFUSED ${String(run.row.reason)}`,
      });
      continue;
    }
    caption(image, [`${c.name} ${mode} size ${c.compareSize} top`, metricLine(run.row)]);
    savePng(`iso/${c.name}-${mode}-${c.compareSize}-network-top.png`, image);
    modeCells.push({ image, caption: `${mode} size ${c.compareSize}: ${metricLine(run.row)}` });
  }
  saveSheet(`sheets/${c.name}-modes.png`, modeCells, {
    columns: 2,
    cell: 520,
    title: `${c.name}: quad modes at one element size (${c.compareSize})`,
  });
}

// Row 3: the holed faces left by the coplanar merge against the earlier plate-with-hole example.
const plateRef = must(boxWithThroughHole({ size: [3, 3, 1], radius: 0.75, label: 'plate' }));
const bracketEnd = buildBracket().at(-1)?.shape;
const holed: { name: string; shape: Shape; size: number; mode: QuadMode }[] = [
  { name: 'plate-with-hole (earlier example)', shape: plateRef, size: 0.25, mode: 'iso' },
  { name: 'through-slot top (merged)', shape: slotBlock(), size: 0.4, mode: 'iso' },
  { name: 'through-slot top (merged)', shape: slotBlock(), size: 0.4, mode: 'quad-dominant' },
  ...(bracketEnd === undefined
    ? []
    : [
        { name: 'bracket end state (merged)', shape: bracketEnd, size: 0.8, mode: 'iso' as const },
        { name: 'bracket end state (merged)', shape: bracketEnd, size: 0.4, mode: 'iso' as const },
        {
          name: 'bracket end state (merged)',
          shape: bracketEnd,
          size: 0.4,
          mode: 'quad-dominant' as const,
        },
      ]),
];
const holedCells: SheetCell[] = [];
for (const h of holed) {
  const run = runQuad(h.shape, h.mode, h.size);
  record({ row: 'holed-face', solid: h.name, ...run.row });
  const image = run.result === undefined ? undefined : networkImages(run.result, ['top']).top;
  if (image === undefined) {
    holedCells.push({
      image: refusalImage(['REFUSED', String(run.row.reason)]),
      caption: `${h.name} ${h.mode} ${h.size}: REFUSED ${String(run.row.reason)}`,
    });
    continue;
  }
  caption(image, [`${h.name} ${h.mode} size ${h.size}`, metricLine(run.row)]);
  const slug = `${h.name.replace(/[^a-zA-Z0-9]+/g, '-')}-${h.mode}-${h.size}`;
  savePng(`holed/${slug}-top.png`, image);
  holedCells.push({ image, caption: `${h.name} ${h.mode} ${h.size}: ${metricLine(run.row)}` });
}
saveSheet('sheets/holed-faces.png', holedCells, {
  columns: 3,
  cell: 460,
  title: 'holed faces: earlier plate-with-hole vs faces produced by the coplanar merge',
});
finish('rows-iso');
