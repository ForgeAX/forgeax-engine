// Renders E2 solids with brep-kit: all-12-edge filleted box, bottle shell, cup shell, chamfered cylinder.
// Run from the repo root: `npx tsx examples/brep-offset-solids/solids.ts <outDir>`.

import { revolve } from '../../src/brep/build.ts';
import { draftedPrism } from '../../src/brep/draft.ts';
import { pipeElbow } from '../../src/brep/elbow.ts';
import { filletBox } from '../../src/brep/fillet-box.ts';
import { filletCylinder } from '../../src/brep/fillet-cylinder.ts';
import { filletPrism } from '../../src/brep/fillet-prism.ts';
import { housing } from '../../src/brep/housing.ts';
import { revolveShell } from '../../src/brep/shell.ts';
import { tub } from '../../src/brep/tub.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P2 } from '../../src/brep/vec.ts';
import { contactSheet, renderShape, type SheetCell } from '../brep-kit/index.ts';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const BOTTLE: P2[] = [
  [0, 0],
  [1, 0],
  [1, 1.5],
  [0.5, 2],
  [0.5, 2.6],
];

export function buildSolids(): { name: string; shape: Shape }[] {
  const chamfered = must(
    revolve({
      profile: [
        [0, -1],
        [0.8, -1],
        [1, -0.8],
        [1, 0.8],
        [0.8, 1],
        [0, 1],
      ],
      label: 'chamfer-cylinder',
    }),
  );
  const bottle = must(revolveShell({ profile: BOTTLE, thickness: 0.12, label: 'bottle-shell' }));
  const cup = must(
    revolveShell({
      profile: [
        [0, 0],
        [1, 0],
        [1, 2],
      ],
      thickness: 0.1,
      label: 'cup-shell',
    }),
  );
  const box = must(filletBox({ size: [2, 3, 4], radius: 0.4, label: 'filleted-box' }));
  const rect: P2[] = [
    [0, 0],
    [2, 0],
    [2, 3],
    [0, 3],
  ];
  const hex: P2[] = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [1.2 * Math.cos(a), 1.2 * Math.sin(a)] as P2;
  });
  const rectRef = must(
    draftedPrism({ profile: rect, height: 3, angle: 0, label: 'draft-rect-ref' }),
  );
  const rectDrafted = must(
    draftedPrism({ profile: rect, height: 3, angle: 0.2, label: 'draft-rect' }),
  );
  const hexDrafted = must(
    draftedPrism({ profile: hex, height: 2, angle: 0.25, label: 'draft-hex' }),
  );
  const elbow = must(
    pipeElbow({ bend: 1.5, outer: 0.5, inner: 0.35, leg: 1.2, label: 'pipe-elbow' }),
  );
  const roundedCylinder = must(
    filletCylinder({ radius: 1, height: 2, fillet: 0.3, label: 'filleted-cylinder' }),
  );
  const bracket = must(
    filletPrism({
      profile: [
        [0, 0],
        [3, 0],
        [3, 1],
        [1, 1],
        [1, 3],
        [0, 3],
      ],
      height: 1.5,
      radii: [0, 0, 0.3, 0, 0.5, 0],
      label: 'filleted-bracket',
    }),
  );
  const tray = must(
    tub({
      outer: [0, 0, 4, 3],
      height: 2.5,
      walls: [0.5, 0.3, 0.5, 0.3],
      floor: 0.4,
      label: 'tub',
    }),
  );
  const housed = must(
    housing({
      size: [4, 2, 1],
      bossX: 1,
      bossRadius: 0.3,
      bossHeight: 3,
      boreRadius: 0.2,
      label: 'housing',
    }),
  );
  return [
    { name: 'housing', shape: housed },
    { name: 'tub', shape: tray },
    { name: 'filleted-bracket', shape: bracket },
    { name: 'filleted-cylinder', shape: roundedCylinder },
    { name: 'pipe-elbow', shape: elbow },
    { name: 'draft-rect-ref', shape: rectRef },
    { name: 'draft-rect', shape: rectDrafted },
    { name: 'draft-hex', shape: hexDrafted },
    { name: 'filleted-box', shape: box },
    { name: 'bottle-shell', shape: bottle },
    { name: 'cup-shell', shape: cup },
    { name: 'chamfer-cylinder', shape: chamfered },
  ];
}

export function renderSolids(outDir: string): string {
  const cells: SheetCell[] = [];
  for (const { name, shape } of buildSolids()) {
    const r = must(
      renderShape(shape, {
        outDir,
        name: `${name}-`,
        modes: ['shaded', 'features', 'iso'],
        size: 640,
        silhouette: false,
      }),
    );
    for (const v of r.views) cells.push({ image: v.image, caption: `${name} ${v.mode} ${v.view}` });
  }
  contactSheet(cells, { columns: 6, path: `${outDir}/sheet.png` });
  return `${outDir}/sheet.png`;
}

if (process.argv[2] !== undefined) renderSolids(process.argv[2]);
