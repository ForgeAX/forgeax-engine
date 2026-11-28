import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { loft } from '../../../src/brep/loft.ts';
import { makeFrame } from '../../../src/brep/surfaces.ts';
import { sweep } from '../../../src/brep/sweep.ts';
import { renderShape } from '../../brep-kit/render.ts';
import { vizOutputDir } from '../../test-output.ts';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(here, 'renders-nurbs-boolean-s1');
const vizDir = vizOutputDir('nurbs-boolean/s1');
mkdirSync(outDir, { recursive: true });
mkdirSync(vizDir, { recursive: true });

const sq = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as const;
const pathFrame = {
  o: [0, 0, 0] as [number, number, number],
  x: [1, 0, 0] as [number, number, number],
  y: [0, 1, 0] as [number, number, number],
  z: [0, 0, 1] as [number, number, number],
};

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

it('renders the S1 sweep stub and loft flange, shaded and feature-line', {
  timeout: 240000,
}, () => {
  const stub = must(
    sweep({
      profile: sq(0.25),
      path: { kind: 'circle', frame: pathFrame, radius: 4 },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    }),
  );
  const flange = must(
    loft({
      sections: [
        { profile: sq(0.4), frame: makeFrame([0, 0, 0], [0, 0, 1]) },
        { profile: sq(0.4), frame: makeFrame([0, 0, 2], [0, 0, 1]) },
      ],
      mode: 'smooth',
    }),
  );
  for (const [name, shape] of [
    ['s1-sweep-stub', stub],
    ['s1-loft-flange', flange],
  ] as const) {
    must(
      renderShape(shape, {
        modes: ['shaded', 'features'],
        views: ['iso', 'top'],
        outDir,
        name: `${name}-`,
      }) as never,
    );
    must(
      renderShape(shape, {
        modes: ['shaded', 'features'],
        views: ['iso', 'top'],
        outDir: vizDir,
        name: `${name}-`,
      }) as never,
    );
  }
});
