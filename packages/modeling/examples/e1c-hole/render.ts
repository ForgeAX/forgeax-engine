import { mkdirSync } from 'node:fs';
import { boxWithThroughHole } from '../../src/brep/boolean-hole.ts';
import { renderShape, STANDARD_VIEWS } from '../brep-kit/index.ts';

const outDir = new URL('./out/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const built = boxWithThroughHole({ size: [2.6, 1, 1], radius: 0.3, label: 'hole' });
if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
const views = (['iso', 'front', 'top'] as const).filter((v) => STANDARD_VIEWS.includes(v));
const shaped = renderShape([built.value], {
  outDir,
  name: 'hole-',
  modes: ['features', 'network'],
  views,
});
if (!shaped.ok) throw new Error('render failed');
process.stdout.write(
  `${JSON.stringify({ faces: built.value.faces.length, views: shaped.value.views.length })}\n`,
);
