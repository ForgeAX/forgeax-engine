// Case C-200 stage G2 (blockout) evidence. Usage:
//   node examples/maid-whale/g2-evidence.mjs <engine-worktree> <out-dir>
import { stageEvidence } from './stage-evidence.mjs';

const result = stageEvidence({
  engine: process.argv[2],
  out: process.argv[3],
  caseId: 'C-200-G2',
  source: 'examples/maid-whale/g2-blockout.pack.ts',
  files: ['g2-blockout.pack.ts', 'blockout.ts', 'g2-evidence.mjs'],
  stages: [
    ['head', 'hair mass: three-view intersection of the measured back and side hair outlines (the back sees the full width, the front has the face notch); head ellipsoid sized from the face width and crown-to-chin height'],
    ['body', 'dress: loft of 11 superellipse sections, widths from the front/back silhouettes, depths from the side silhouette, torso from the visible front depth', "sel.tag('dress')"],
    ['arms', 'arms: puffed sleeve rings from shoulder through elbow to the measured cuff; cuff ring and hand block at the measured hand extent', "sel.tag('arm-l').or(sel.tag('arm-r'))"],
    ['legs', 'legs and socks sized from the front leg/sock extents; shoes as three-view intersections of each front shoe outline and the side shoe outline', "sel.tag('shoe-l').or(sel.tag('shoe-r'))"],
    ['final', 'tail: three-view intersection of the front and side tail outlines, plus a lofted root under the back bow (hidden on the sheet)', "sel.tag('tail').or(sel.tag('tail-root'))"],
  ],
});
console.log(JSON.stringify(result));
