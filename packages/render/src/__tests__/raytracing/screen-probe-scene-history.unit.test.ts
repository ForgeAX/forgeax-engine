import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sceneHistoryCases, sceneHistorySourceWitness } from './screen-probe-scene-history.fixture';

const source = readFileSync(
  new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
  'utf8',
);
it.each(
  sceneHistoryCases,
)('keeps current source history validity distinct from known black: $name', (row) => {
  const observed = sceneHistorySourceWitness(source, row.rgb);
  expect(observed.alpha, `${row.name}: copied validity`).toBe(row.valid ? 1 : 0);
  expect(observed.resolvesScreenHit, `${row.name}: conditional screen-hit admission`).toBe(
    row.valid,
  );
  expect(observed.rgb, `${row.name}: copied RGB`).toEqual(row.valid ? row.rgb : [0, 0, 0]);
});
