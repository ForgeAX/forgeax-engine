// Case C-200 stage G5 (low-poly faceting) evidence. Usage:
//   node examples/maid-whale/g5-evidence.mjs <engine-worktree> <out-dir>
import { stageEvidence } from './stage-evidence.mjs';

const result = stageEvidence({
  engine: process.argv[2],
  out: process.argv[3],
  caseId: 'C-200-G5',
  source: 'examples/maid-whale/g5-lowpoly.pack.ts',
  files: ['g5-lowpoly.pack.ts', 'lowpoly.ts', 'g5-evidence.mjs'],
  stages: [
    ['assembled', 'G4 assembly before faceting: smooth hair mass, lofted dress and tail'],
    ['faceted-hair', 'hair: QEM to three times the measured facet count, then isotropic remesh at a nominal 0.055 m edge (curvature keeps finer facets; density inside the sheet range) (crown height kept)', "sel.tag('hair')"],
    ['faceted-dress', 'dress faceted at 0.034 m; the hull-cut tail is already below its facet count and keeps its facets', "sel.tag('dress')"],
    ['final', 'low-poly faceting: hair, dress, tail and arms reduced by QEM to 3x their measured facet count, then isotropically remeshed to the sheet facet edge (nominal 0.030-0.055 m; measured hair density inside the sheet range, inside the measured 0.023-0.051 m); triangulated, exported with flat normals'],
  ],
  closeups: [
    ['wire', [-0.32, 0.05, -0.42, 0.42, 1.02, 0.3], ['front', 'iso']],
  ],
});
console.log(JSON.stringify(result));
