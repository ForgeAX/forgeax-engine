// Bracket quad-baseline: the C-010 L-section with its inner-corner fillet ONLY, built as a B-rep Shape
// with filletPrism (no booleans). The blind slot and the pad boss are NOT built: plane/plane booleans fail
// in the kernel (model-partial, brep-ssi-unsupported plane/plane); lane "planar" is working on it. The mesh-only
// bevels are not reproduced either. Dimensions are copied from examples/bracket/bracket.ts BRACKET_DEFAULTS.
// Runs quad-dominant and blossom-row+split-3; writes summary.json and shaded + network renders.
import { mkdirSync, writeFileSync } from 'node:fs';
import { filletPrism } from '../../src/brep/fillet-prism.ts';
import { quadrangulate } from '../../src/brep/quad.ts';
import { renderShape } from '../brep-kit/render.ts';

const outDir =
  process.env.QF_OUT ??
  new URL('../../../../_scratch/viz-out/qf-bracket/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const P = { length: 0.14, height: 0.1, thickness: 0.014, depth: 0.09, fillet: 0.01 };
const t = P.thickness;
const built = filletPrism({
  profile: [
    [0, 0],
    [P.length, 0],
    [P.length, t],
    [t, t],
    [t, P.height],
    [0, P.height],
  ],
  height: P.depth,
  radii: [0, 0, 0, P.fillet, 0, 0],
  label: 'bracket-section',
});
if (!built.ok) throw new Error(`failed: ${JSON.stringify(built.error).slice(0, 300)}`);
const shape = built.value;
const size = 0.014;

const rows = [
  { label: 'quad-dominant', options: { trimmed: 'quad-dominant' } },
  { label: 'blossom-row+split-3', options: { trimmed: 'blossom-row', fallback: 'split-3' } },
] as const;
const out = rows.map(({ label, options }) => {
  const r = quadrangulate(shape, { size, source: 'boolean', ...options });
  if (!r.ok) return { id: 'bracket-section', mode: label, status: 'fail', code: r.error.code };
  const faces = r.value.faceQuality;
  const views = renderShape([r.value.mesh], {
    name: `bracket-${label}-`,
    modes: ['shaded', 'network'],
    views: ['iso', 'top', 'bottom'],
    outDir,
    colorBy: 'face',
  });
  return {
    id: 'bracket-section',
    mode: label,
    size,
    status: 'ok',
    quads: r.value.report.quads,
    tris: r.value.report.triangles,
    minSj: Math.min(...faces.map((f) => f.minSj)),
    open: r.value.report.openEdges,
    nm: r.value.report.nonManifoldEdges,
    split3Faces: faces.filter((f) => f.split3).length,
    pngs: views.ok ? views.value.views.map((v) => v.path) : String(views.error),
  };
});
writeFileSync(`${outDir}summary.json`, JSON.stringify(out, null, 2));
for (const r of out) console.log(JSON.stringify({ ...r, pngs: undefined }));
