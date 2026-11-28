// Scope additions: (a) the blind-pocket block and the two slice-2 intersect solids, which were not re-rendered after the
// coplanar merge, and (d) the qf-multi plate with a through hole in iso mode, all through the same per-solid row as
// rows-modes.
import { boxWithThroughHole } from '../../src/brep/boolean-hole.ts';
import { finish, must } from './common.ts';
import { type BestMode, solidRow } from './solid-row.ts';
import { blindPocketBlock, steppedLIntersect, tIntersect } from './solids.ts';

const best: BestMode = {};
const plate = must(boxWithThroughHole({ size: [3, 3, 1], radius: 0.75, label: 'plate' }));
for (const solid of [
  { name: 'blind-pocket', shape: blindPocketBlock(), size: 0.4 },
  { name: 'T-intersect', shape: tIntersect(), size: 0.4 },
  { name: 'stepped-L-intersect', shape: steppedLIntersect(), size: 0.4 },
  { name: 'plate-with-hole', shape: plate, size: 0.25 },
]) {
  solidRow(solid, best);
}
finish('rows-extras');
