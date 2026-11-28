// Rows 1-3 and 6: planar boolean solids through the quad meshers (iso, quad-dominant, blossom-row, split-3) at one
// equal element size per solid, the merged side of the before/after merge sheets, and the bracket hero overlay.
import { measure } from '../../src/brep/measure.ts';
import type { Image } from '../brep-kit/image.ts';
import { renderScene } from '../brep-kit/raster.ts';
import type { SheetCell } from '../brep-kit/sheet.ts';
import {
  caption,
  finish,
  loadRaw,
  metricLine,
  must,
  type QuadMode,
  record,
  refusalImage,
  runQuad,
  savePng,
  saveSheet,
} from './common.ts';
import { overlayImage, overlayLegend, overlayScene } from './overlay.ts';
import { networkImages, shapeImages } from './render-solid.ts';
import { type BestMode, solidRow } from './solid-row.ts';
import { modeSolids, slotBlock, tUnion } from './solids.ts';

const solids = modeSolids();
const bestMode: BestMode = {};

for (const solid of solids) solidRow(solid, bestMode);

// Row 2, merged side: side-by-side with the fragmented renders from before-merge.ts.
for (const [name, shape, fragFaces] of [
  ['through-slot', slotBlock(), 32],
  ['T-union', tUnion(), 42],
] as const) {
  const faces = shape.faces.length;
  record({
    row: 'merge-compare',
    solid: name,
    variant: 'merged',
    faces,
    fragmentedFaces: fragFaces,
    volume: must(measure(shape)).volume,
  });
  const { shaded, features } = shapeImages(shape);
  caption(shaded, [`${name} MERGED ${faces} faces`, 'shaded iso']);
  caption(features, [`${name} MERGED ${faces} faces`, 'feature lines iso']);
  const cells: SheetCell[] = [
    {
      image: loadRaw(`${name}-fragmented-shaded`),
      caption: `fragmented ${fragFaces} faces: shaded`,
    },
    { image: shaded, caption: `merged ${faces} faces: shaded` },
    {
      image: loadRaw(`${name}-fragmented-features`),
      caption: `fragmented ${fragFaces} faces: feature lines`,
    },
    { image: features, caption: `merged ${faces} faces: feature lines` },
  ];
  // Mesh edges drawn over the shaded part, same mesher and size on both sides (iso, then quad-dominant).
  for (const mode of ['iso', 'quad-dominant'] as const) {
    const run = runQuad(shape, mode, 0.4);
    const frag = loadRaw(`${name}-fragmented-overlay-${mode}`);
    cells.push({ image: frag, caption: `fragmented ${fragFaces} faces: ${mode} mesh edges` });
    if (run.result === undefined) {
      cells.push({
        image: refusalImage(['REFUSED', String(run.row.reason)]),
        caption: `merged ${faces} faces: ${mode} REFUSED ${String(run.row.reason)}`,
      });
      continue;
    }
    const over = overlayImage(shape, run.result.mesh, 'iso', 640);
    caption(over, [`${name} MERGED ${mode} size 0.4`, metricLine(run.row)]);
    cells.push({
      image: over,
      caption: `merged ${faces} faces: ${mode} mesh edges, ${metricLine(run.row)}`,
    });
  }
  saveSheet(`merge/${name}-before-after.png`, cells, {
    columns: 2,
    cell: 560,
    title: `${name}: coplanar merge, ${fragFaces} -> ${faces} faces`,
  });
  // The same shape meshed at the same size: fragmented network vs merged network (iso).
  const netCells: SheetCell[] = [];
  for (const mode of ['iso', 'quad-dominant'] as const) {
    const run = runQuad(shape, mode, 0.4);
    record({ row: 'merge-compare-quad', solid: name, variant: 'merged', faces, ...run.row });
    netCells.push({
      image: loadRaw(`${name}-fragmented-net-${mode}`),
      caption: `fragmented ${fragFaces} faces, ${mode}`,
    });
    if (run.result === undefined) {
      netCells.push({
        image: refusalImage(['REFUSED', String(run.row.reason)]),
        caption: `merged ${faces} faces, ${mode}: REFUSED ${String(run.row.reason)}`,
      });
      continue;
    }
    const net = networkImages(run.result, ['iso']).iso as Image;
    caption(net, [`${name} MERGED ${mode} size 0.4`, metricLine(run.row)]);
    netCells.push({
      image: net,
      caption: `merged ${faces} faces, ${mode}: ${metricLine(run.row)}`,
    });
  }
  saveSheet(`merge/${name}-quad-before-after.png`, netCells, {
    columns: 2,
    cell: 560,
    title: `${name}: quad network, fragmented vs merged`,
  });
}

// Row 6 hero: bracket end state, B-rep feature lines over the quad network.
const bracket = solids.find((s) => s.name === 'bracket-pocket');
// The hero uses the finer 0.4 size (iso mode) so the network is dense enough to read; it falls back to the equal-size pick.
const HERO_SIZE = 0.4;
const fine = bracket === undefined ? undefined : runQuad(bracket.shape, 'iso', HERO_SIZE);
const heroPick =
  fine?.result !== undefined ? { mode: 'iso' as QuadMode, run: fine } : bestMode['bracket-pocket'];
const heroSize = fine?.result !== undefined ? HERO_SIZE : bracket?.size;
if (bracket !== undefined && heroPick?.run.result !== undefined) {
  const scene = overlayScene(bracket.shape, heroPick.run.result.mesh);
  const heroCells: SheetCell[] = [];
  for (const view of ['iso', 'top'] as const) {
    const image = renderScene(scene, view, { size: 1024 });
    caption(image, [
      `bracket end state: B-rep feature lines over the quad network`,
      `mode ${heroPick.mode}, size ${heroSize}: ${metricLine(heroPick.run.row)}`,
    ]);
    overlayLegend(image, 2);
    savePng(`hero/bracket-hero-${view}.png`, image);
    heroCells.push({ image, caption: `${view}, network mode ${heroPick.mode}` });
  }
  record({ row: 'hero', solid: 'bracket-pocket', mode: heroPick.mode, ...heroPick.run.row });
} else
  record({
    row: 'hero',
    solid: 'bracket-pocket',
    status: 'not produced',
    reason: 'no quad mode succeeded',
  });

// Mesh edges over the shaded part for every solid of rows 1 and 6 (first mode that succeeded; refusals stay cells).
const overlayCells: SheetCell[] = [];
for (const solid of solids) {
  const pick = bestMode[solid.name];
  if (pick?.run.result === undefined) {
    overlayCells.push({
      image: refusalImage(['REFUSED', 'no quad mode succeeded']),
      caption: `${solid.name}: no mode succeeded`,
    });
    continue;
  }
  const image = overlayImage(solid.shape, pick.run.result.mesh, 'iso', 640);
  caption(image, [`${solid.name} ${pick.mode} size ${solid.size}`, metricLine(pick.run.row)]);
  savePng(`overlay/${solid.name}-${pick.mode}-overlay-iso.png`, image);
  overlayCells.push({ image, caption: `${solid.name} ${pick.mode}: ${metricLine(pick.run.row)}` });
}
saveSheet('sheets/overlay-mesh-edges.png', overlayCells, {
  columns: 3,
  cell: 460,
  title: 'mesh edges over shaded part + feature lines (iso), first successful mode per solid',
});

finish('rows-modes');
