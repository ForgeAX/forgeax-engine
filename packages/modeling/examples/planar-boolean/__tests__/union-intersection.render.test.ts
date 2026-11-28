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

const output = vizOutputDir('planar-boolean-2');

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function block(size: [number, number, number], origin: [number, number, number]): Shape {
  return must(box({ size, frame: makeFrame(origin, [0, 0, 1], [1, 0, 0]), tol: 1e-8 }));
}

it('renders the crossed-box union and intersection feature families', {
  timeout: 240000,
}, () => {
  const { head, tree } = gitProvenance();
  const examples = [
    {
      name: 'stepped-L-bracket',
      operands: [block([4, 1, 1], [0, 0, 0]), block([1, 2, 1.3], [1.45, 1, 0.17])] as const,
    },
    {
      name: 'T-shaped-block',
      operands: [block([4, 1, 1], [0, 0, 0]), block([1, 2, 1.3], [0.13, 1.2, 0.17])] as const,
    },
  ] as const;
  mkdirSync(output, { recursive: true });
  const results = examples.flatMap(({ name, operands }) =>
    (['union', 'intersect'] as const).map((op) => ({
      name: `${name}-${op}`,
      shape: must(booleanSolids(operands[0], operands[1], op)),
    })),
  );
  const pngPaths: string[] = [];
  for (const { name, shape } of results) {
    const rendered = must(
      renderShape(shape, {
        outDir: output,
        name: `${name}-`,
        views: ['iso'],
        modes: ['shaded', 'features'],
        kinds: ['convex', 'concave', 'boundary'],
        size: 1024,
        label: true,
        legend: 'none',
        silhouette: true,
      }),
    );
    for (const view of rendered.views) {
      if (view.path === undefined) throw new Error(`missing output path for ${name}`);
      pngPaths.push(view.path);
    }
  }
  const pngSha256 = Object.fromEntries(
    pngPaths.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
  const summary = {
    provenance: {
      head,
      tree,
      utc: new Date().toISOString(),
      command: 'vitest run examples/planar-boolean/__tests__/union-intersection.render.test.ts',
      exit: 0,
    },
    features: results.map(({ name, shape }) => ({
      name,
      faces: shape.faces.length,
      volume: must(measure(shape)).volume,
      renderPaths: pngPaths.filter((path) => path.includes(`${name}-`)),
    })),
    pngSha256,
  };
  writeFileSync(`${output}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    `${output}/provenance.txt`,
    `${[
      `head ${head}`,
      `tree ${tree}`,
      `utc ${summary.provenance.utc}`,
      `command ${summary.provenance.command}`,
      'exit 0',
      ...Object.entries(pngSha256).map(([path, digest]) => `sha256 ${digest} ${path}`),
    ].join('\n')}\n`,
  );
});
