// Case C-200 stage G3 (secondary forms) evidence. Usage:
//   node examples/maid-whale/g3-evidence.mjs <engine-worktree> <out-dir>
import { stageEvidence } from './stage-evidence.mjs';

const result = stageEvidence({
  engine: process.argv[2],
  out: process.argv[3],
  caseId: 'C-200-G3',
  source: 'examples/maid-whale/g3-forms.pack.ts',
  files: ['g3-forms.pack.ts', 'forms.ts', 'g3-evidence.mjs'],
  stages: [
    ['hair-done', 'hair: cap cut open at the brow plane, 10 back clumps on the measured hair ellipse ending at the strand tips of the back outline, 4 side locks, 6 bangs; faceted lens sections fused by a voxel smooth union into one closed mass', "sel.tag('hair')"],
    ['head', 'head ellipsoid under the hair (G2)'],
    ['body', 'dress: pleated skirt and white hem band as open-bottom shells (legs reach inside), bodice, waistband; apron skirt, ruffled hem and bib as curved plates over the dress front, extents from the G1 apron/waistband bounds', "sel.tag('dress')"],
    ['arms', 'puffed sleeves, cuffs and hands (G2 forms, cuff placement refined)'],
    ['final', 'tail: rotation-minimizing sweep of an elliptical section along the measured centerline with a 1 -> 0.5 scale ramp, two-lobed fluke extruded from the side outline columns and turned onto the measured fluke direction', "sel.tag('tail')"],
  ],
});
console.log(JSON.stringify(result));
