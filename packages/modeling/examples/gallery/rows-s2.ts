// S2b2 (#650): the NURBS sweep stub unioned with a placed planar plate (every plate face crosses only a NURBS side), and
// the plain stub as its baseline, each through the per-solid row (shaded, feature lines, four quad modes, mode sheet).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { booleanSolids } from '../../src/brep/boolean.ts';
import { box } from '../../src/brep/build.ts';
import { sweep } from '../../src/brep/sweep.ts';
import { transformShape } from '../../src/brep/transform.ts';
import type { Shape } from '../../src/brep/types.ts';
import {
  caption,
  finish,
  loadPng,
  must,
  OUT,
  record,
  registerPng,
  savePng,
  saveSheet,
} from './common.ts';
import { shapeImages } from './render-solid.ts';
import { type BestMode, solidRow } from './solid-row.ts';

const sq = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as const;
const identity = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;

function stub(): Shape {
  return must(
    sweep({
      profile: sq(0.25),
      path: {
        kind: 'circle',
        frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        radius: 4,
      },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    }),
  );
}

// Plate x 3.5..4.5, y 0.2..0.5, z -0.1..0.1, as in nurbs-boolean-union.unit.test.ts.
function plate(): Shape {
  return must(
    transformShape(must(box({ size: [1, 0.3, 0.2] })), { rot: identity as never, t: [4, 0.35, 0] }),
  );
}

const SIZE = 0.25;
const best: BestMode = {};
solidRow({ name: 'nurbs-stub', shape: stub(), size: SIZE }, best);
const union = must(booleanSolids(stub(), plate(), 'union'));
solidRow({ name: 'nurbs-stub-union-plate', shape: union, size: SIZE }, best);

// The plate is small against the stub in iso; the top view shows its footprint and the trimmed NURBS wall faces.
const top = shapeImages(union, 'top');
caption(top.shaded, ['nurbs-stub-union-plate 16 faces', 'shaded top']);
caption(top.features, [
  'nurbs-stub-union-plate 16 faces',
  'feature lines top (convex/concave/boundary)',
]);
savePng('s2/nurbs-stub-union-plate-shaded-top.png', top.shaded);
savePng('s2/nurbs-stub-union-plate-features-top.png', top.features);
record({ row: 's2b2-top', solid: 'nurbs-stub-union-plate', faces: union.faces.length });
saveSheet(
  'sheets/nurbs-stub-union-plate-top.png',
  [
    { image: top.shaded, caption: 'S2b2 union, shaded top' },
    { image: top.features, caption: 'S2b2 union, feature lines top' },
  ],
  { columns: 2, cell: 520, title: 'S2b2 (#650): NURBS stub union planar plate, top views' },
);

// The separate SSI lane can provide published comparison renders through SSI_S2_DIR.
const SSI_DIR = process.env.SSI_S2_DIR;
if (SSI_DIR !== undefined && SSI_DIR.length > 0) {
  const ssiNames = [
    'shaded-iso',
    'features-iso',
    'iso-iso',
    'shaded-top',
    'features-top',
    'iso-top',
    'shaded-front',
    'features-front',
    'iso-front',
  ].map((n) => `s2-union-${n}.png`);
  ssiNames.push('s2-ssi-ends-iso.png');
  const ssiSummary = JSON.parse(readFileSync(join(SSI_DIR, 'summary.json'), 'utf8')) as {
    volume: number;
    analyticVolume: number;
    volumeError: number;
  };
  mkdirSync(join(OUT, 's2/ssi-preview'), { recursive: true });
  for (const n of ssiNames) {
    copyFileSync(join(SSI_DIR, n), join(OUT, 's2/ssi-preview', n));
    registerPng(`s2/ssi-preview/${n}`);
  }
  record({
    row: 's2b2-ssi-preview',
    solid: 'nurbs-stub-union-plate',
    label: 'preview',
    source: 'viz-out/nurbs-boolean-s2 (ssi lane)',
    volume: ssiSummary.volume,
    analyticVolume: ssiSummary.analyticVolume,
    volumeError: ssiSummary.volumeError,
    pngs: ssiNames.length,
  });
  const cap = (n: string): string => n.replace(/^s2-/, '').replace('.png', '').replace(/-/g, ' ');
  saveSheet(
    'sheets/nurbs-boolean-s2-ssi-preview.png',
    ssiNames.map((n) => ({ image: loadPng(`s2/ssi-preview/${n}`), caption: cap(n) })),
    {
      columns: 4,
      cell: 360,
      title: `NURBS boolean S2b2 union (preview, ssi lane): volume error ${ssiSummary.volumeError.toExponential(1)}; orange = SSI branch ends`,
    },
  );
}
finish('rows-s2');
