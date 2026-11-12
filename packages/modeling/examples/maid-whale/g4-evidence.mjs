// Case C-200 stage G4 (local parts) evidence. Usage:
//   node examples/maid-whale/g4-evidence.mjs <engine-worktree> <out-dir>
import { stageEvidence } from './stage-evidence.mjs';

const result = stageEvidence({
  engine: process.argv[2],
  out: process.argv[3],
  caseId: 'C-200-G4',
  source: 'examples/maid-whale/g4-details.pack.ts',
  files: ['g4-details.pack.ts', 'details.ts', 'g4-evidence.mjs'],
  stages: [
    ['tail', 'G3 body: hair, head, dress with apron, arms, legs, shoes, tail'],
    ['head-details', 'headdress: white band arched through the crown and the measured frill ends, 13 stepped teeth tapering toward the ears; whale fins as front x side triangle intersections with white stepped trim; light-blue bows; curled ahoge', "sel.tag('headdress').or(sel.tag('fin-l')).or(sel.tag('fin-r')).or(sel.tag('ribbon-l')).or(sel.tag('ribbon-r')).or(sel.tag('ahoge'))"],
    ['chest-details', 'frilled collar ring, navy bowtie with tails, faceted gem in a gold rim at the measured brooch center', "sel.tag('collar').or(sel.tag('bowtie')).or(sel.tag('brooch'))"],
    ['final', 'Mary-Jane straps with gold buckles; large white back bow behind the skirt with the apron ties from the waistband sides', "sel.tag('back-bow').or(sel.tag('strap-l')).or(sel.tag('strap-r'))"],
  ],
  closeups: [
    ['closeup-head', [-0.3, 0.62, -0.25, 0.32, 1.03, 0.2], ['front', 'iso']],
    ['closeup-chest', [-0.12, 0.48, -0.05, 0.12, 0.65, 0.15], ['front', 'iso']],
    ['closeup-back', [-0.2, 0.0, -0.3, 0.2, 0.45, 0.1], ['back', 'iso']],
  ],
});
console.log(JSON.stringify(result));
