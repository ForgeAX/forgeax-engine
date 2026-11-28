import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Result } from '@forgeax/engine-types';
import { it } from 'vitest';
import { booleanSolids } from '../../../src/brep/boolean.ts';
import { measure } from '../../../src/brep/measure.ts';
import type { Shape } from '../../../src/brep/types.ts';
import type { ModelingError } from '../../../src/errors.ts';
import { renderShape } from '../../brep-kit/index.ts';
import { gitProvenance, REPO_ROOT, vizOutputDir } from '../../test-output.ts';
import { block, buildBracket, HOLED_BRACKET_STEPS } from '../bracket.ts';

const PLATE = block([6, 4, 2], [0, 0, 0]);
const POCKET = block([1, 1, 1], [0, 0, 1]);

const output = vizOutputDir('planar-boolean-4');

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Face counts of the same booleans before the coplanar merge, measured on commit 97363ade. */
const UNMERGED_FACES = { slot: 32, pocket: 46, 'T-union': 42, 'stepped-L-union': 42 } as const;

it('renders the chained bracket with a pocket in the middle and the holed-operand results', {
  timeout: 240000,
}, () => {
  const { head, tree } = gitProvenance();
  mkdirSync(output, { recursive: true });

  const host = block([4, 4, 4], [0, 0, 0]);
  const bar = block([4, 1, 1], [0, 0, 0]);
  const stages = buildBracket(HOLED_BRACKET_STEPS);
  const final = stages[stages.length - 1];
  if (final === undefined) throw new Error('empty bracket chain');
  const pocketStage = stages.find((stage) => stage.name === 'pocket');
  if (pocketStage === undefined) throw new Error('bracket chain has no pocket stage');
  const pocketed = must(booleanSolids(PLATE, POCKET, 'difference'));
  const results: { name: string; shape: Shape; views: ('iso' | 'iso-back' | 'bottom')[] }[] = [
    { name: 'bracket', shape: final.shape, views: ['iso', 'iso-back'] },
    { name: 'bracket-pocket-step', shape: pocketStage.shape, views: ['iso-back'] },
    {
      name: 'pocketed-plate-bar-union',
      shape: must(booleanSolids(pocketed, block([4, 0.4, 0.8], [0, 0, 1.2]), 'union')),
      views: ['iso'],
    },
    {
      name: 'block-minus-pocketed-plate',
      shape: must(booleanSolids(block([3, 3, 3], [0, 0, 1.2]), pocketed, 'difference')),
      views: ['iso-back', 'bottom'],
    },
    {
      name: 'slot',
      shape: must(booleanSolids(host, block([0.6, 1.4, 6], [0, 0, 0]), 'difference')),
      views: ['iso'],
    },
    {
      name: 'T-union',
      shape: must(booleanSolids(bar, block([1, 2, 1.3], [0.13, 1.2, 0.17]), 'union')),
      views: ['iso'],
    },
    {
      name: 'stepped-L-union',
      shape: must(booleanSolids(bar, block([1, 2, 1.3], [1.45, 1, 0.17]), 'union')),
      views: ['iso'],
    },
  ];
  const pngPaths: string[] = [];
  for (const { name, shape, views } of results) {
    const rendered = must(
      renderShape(shape, {
        outDir: output,
        name: `${name}-`,
        views,
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
  const stress = JSON.parse(
    readFileSync(`${REPO_ROOT}/examples/brep-stress/report.json`, 'utf8'),
  ) as {
    parts: { steps: { id: string; ok: boolean }[] }[];
  };
  const stressStatus = Object.fromEntries(
    stress.parts.flatMap((part) =>
      part.steps.filter((s) => /^A[5-7]$|^B[68]$/.test(s.id)).map((s) => [s.id, s.ok]),
    ),
  );
  const pngSha256 = Object.fromEntries(
    pngPaths.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
  const summary = {
    provenance: {
      head,
      tree,
      utc: new Date().toISOString(),
      command: 'vitest run examples/planar-boolean/__tests__/bracket.render.test.ts',
      exit: 0,
    },
    bracketStages: stages.map((s) => ({
      name: s.name,
      faces: s.faces,
      volume: s.volume,
      gridVolume: s.gridVolume,
      relativeError: Math.abs(s.volume - s.gridVolume) / s.gridVolume,
    })),
    mergeFaceCounts: results
      .filter((r) => r.name in UNMERGED_FACES)
      .map((r) => ({
        name: r.name,
        before: UNMERGED_FACES[r.name as keyof typeof UNMERGED_FACES],
        after: r.shape.faces.length,
        volume: must(measure(r.shape)).volume,
      })),
    stressStepOk: stressStatus,
    renders: results.map(({ name }) => ({
      name,
      paths: pngPaths.filter((p) => p.includes(`/${name}-`)),
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
