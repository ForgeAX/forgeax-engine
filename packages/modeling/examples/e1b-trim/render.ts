import { mkdirSync } from 'node:fs';
import { contactSheet, mergeScenes, renderScene, renderShape, STANDARD_VIEWS } from '../brep-kit/index.ts';
import { classifiedArc } from './arc.ts';
import { classifyArc } from './trim.ts';

const outDir = new URL('./out/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const r = classifyArc();
const views = (['iso', 'front', 'top'] as const).filter((v) => STANDARD_VIEWS.includes(v));
const shaped = renderShape([r.top, r.side], {
  outDir,
  name: 'pair-',
  modes: ['features', 'network'],
  views,
});
if (!shaped.ok) throw new Error('render failed');
const arc = classifiedArc(r.top, r.topFace, r.branch);
const cells = views.flatMap((v) => {
  const feat = shaped.value.views.find((x) => x.mode === 'features' && x.view === v);
  const arcView = renderScene(mergeScenes(arc), v, { size: 640 });
  return [
    { image: feat?.image ?? arcView, caption: `features ${v}` },
    { image: arcView, caption: `classified arc ${v}` },
  ];
});
contactSheet(cells, { columns: 2, path: `${outDir}/sheet.png` });
process.stdout.write(
  `${JSON.stringify({ arcSamples: r.arcSamples, in: r.inCount, out: r.outCount, on: r.onCount, seamCuts: r.seamCuts, spans: r.spans })}\n`,
);
