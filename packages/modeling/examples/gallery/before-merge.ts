// Fragmented state of the coplanar-merge solids: run with GALLERY_NO_MERGE=1 (register.mjs swaps the merge hook for the
// identity), so booleanSolids returns the pre-merge faces. Renders are handed to rows-merge.ts as raw RGBA.
import { measure } from '../../src/brep/measure.ts';
import { caption, finish, metricLine, must, record, runQuad, saveRaw } from './common.ts';
import { overlayImage } from './overlay.ts';
import { networkImages, shapeImages } from './render-solid.ts';
import { slotBlock, tUnion } from './solids.ts';

if (process.env.GALLERY_NO_MERGE !== '1')
  throw new Error('before-merge.ts must run with GALLERY_NO_MERGE=1');

const SIZE = 0.4;
const solids = [
  { name: 'through-slot', shape: slotBlock(), expectFaces: 32 },
  { name: 'T-union', shape: tUnion(), expectFaces: 42 },
] as const;

for (const { name, shape, expectFaces } of solids) {
  const faces = shape.faces.length;
  record({
    row: 'merge-compare',
    solid: name,
    variant: 'fragmented',
    faces,
    expectFaces,
    facesAsDocumented: faces === expectFaces,
    volume: must(measure(shape)).volume,
  });
  const { shaded, features } = shapeImages(shape);
  caption(shaded, [`${name} FRAGMENTED ${faces} faces`, 'shaded iso']);
  caption(features, [`${name} FRAGMENTED ${faces} faces`, 'feature lines iso']);
  saveRaw(`${name}-fragmented-shaded`, shaded);
  saveRaw(`${name}-fragmented-features`, features);
  for (const mode of ['iso', 'quad-dominant'] as const) {
    const run = runQuad(shape, mode, SIZE);
    record({ row: 'merge-compare-quad', solid: name, variant: 'fragmented', faces, ...run.row });
    if (run.result === undefined) continue;
    const net = networkImages(run.result, ['iso']).iso;
    if (net === undefined) continue;
    caption(net, [`${name} FRAGMENTED ${mode} size ${SIZE}`, metricLine(run.row)]);
    saveRaw(`${name}-fragmented-net-${mode}`, net);
    const over = overlayImage(shape, run.result.mesh, 'iso', 640);
    caption(over, [`${name} FRAGMENTED ${mode} size ${SIZE}`, metricLine(run.row)]);
    saveRaw(`${name}-fragmented-overlay-${mode}`, over);
  }
}
finish('before-merge');
