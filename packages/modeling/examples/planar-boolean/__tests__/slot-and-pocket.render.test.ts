import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Result } from '@forgeax/engine-types';
import { it } from 'vitest';
import { booleanSolids } from '../../../src/brep/boolean.ts';
import { box } from '../../../src/brep/build.ts';
import { measure } from '../../../src/brep/measure.ts';
import { makeFrame } from '../../../src/brep/surfaces.ts';
import type { Shape } from '../../../src/brep/types.ts';
import type { ModelingError } from '../../../src/errors.ts';
import { renderShape } from '../../brep-kit/index.ts';
import { gitProvenance, vizOutputDir } from '../../test-output.ts';

const output = vizOutputDir('planar-boolean');

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function block(size: [number, number, number], origin: [number, number, number]): Shape {
  return must(box({ size, frame: makeFrame(origin, [0, 0, 1]), tol: 1e-8 }));
}

it('renders the planar boolean slot and pocket with shaded and feature-line views', {
  timeout: 240000,
}, () => {
  const { head, tree } = gitProvenance();
  const host = block([4, 4, 4], [0, 0, 0]);
  const slot = must(booleanSolids(host, block([0.6, 1.4, 6], [0, 0, 0]), 'difference'));
  const pocket = must(booleanSolids(host, block([1.2, 1.2, 1.4], [0, 0, 1.4]), 'difference'));
  mkdirSync(output, { recursive: true });
  const renders = [
    ['through-slot', slot],
    ['blind-pocket', pocket],
  ] as const;
  for (const [name, shape] of renders) {
    const rendered = must(
      renderShape(shape, {
        outDir: output,
        name: `${name}-`,
        views: ['iso'],
        modes: ['shaded', 'features'],
        size: 768,
        label: true,
        legend: 'none',
        silhouette: true,
      }),
    );
    for (const view of rendered.views) {
      if (view.path === undefined) throw new Error(`missing output path for ${name}`);
    }
  }
  const features = renders.map(([name, shape]) => ({
    name,
    faces: shape.faces.length,
    volume: must(measure(shape)).volume,
    renderPaths: [`${output}/${name}-shaded-iso.png`, `${output}/${name}-features-iso.png`],
  }));
  const pngDigests = Object.fromEntries(
    features.flatMap(({ renderPaths }) =>
      renderPaths.map((path) => [
        path,
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]),
    ),
  );
  const summary = {
    provenance: {
      head,
      tree,
      utc: new Date().toISOString(),
      command: 'vitest run examples/planar-boolean/__tests__/slot-and-pocket.render.test.ts',
      exit: 0,
    },
    features,
    pngSha256: pngDigests,
  };
  writeFileSync(`${output}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const receipt = [
    `head ${head}`,
    `tree ${tree}`,
    `utc ${summary.provenance.utc}`,
    `command ${summary.provenance.command}`,
    'exit 0',
    ...Object.entries(pngDigests).map(([path, digest]) => `sha256 ${digest} ${path}`),
  ];
  writeFileSync(`${output}/provenance.txt`, `${receipt.join('\n')}\n`);
});
