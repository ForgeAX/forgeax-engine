import type { MeshAsset } from '@forgeax/engine-types';
import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-001: a hard-surface prop crate built only from P0 operators. The body is
 * one box: loop-cut bands, recessed side panels, a welded-in lid plate with a
 * raised boss, and an extruded plinth. Separate parts (mirrored arch handles, a
 * bridged hinge, lifted rivets) are built in their own sessions and appended.
 * The code is straight-line on purpose: tools map every journal entry back to
 * the call on its source line. Checkpoints name the body stages for `model history`
 * and `model render --checkpoint` (no-ops outside a capture).
 */
export interface CrateParameters {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export const CRATE_DEFAULTS: CrateParameters = { width: 0.8, height: 0.5, depth: 0.5 };


function exported(part: Model): MeshAsset {
  const out = part.toMesh({ normals: { mode: 'smooth' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

export function buildCrate(
  p: CrateParameters = CRATE_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const w = p.width / 2;
  const h = p.height / 2;
  const d = p.depth / 2;
  const band = h / 3;
  const reach = 10;

  // Handles: a half-torus arch whose open tube ends sit on the side face, mirrored to -X.
  const handle = session('handle');
  handle.torus({ radius: 0.06, tube: 0.01, radialSegments: 12, tubularSegments: 8, angle: 180, tag: 'metal' });
  handle.rotate(sel.all(), 'z', -90);
  handle.rotate(sel.all(), 'x', 90);
  handle.translate(sel.all(), [w, h * 0.6, 0]);
  handle.mirror({ axis: 'x' });

  // Rivets: a sphere cut into an open dome, placed at one lid corner, mirrored to four.
  const rivet = session('rivet');
  rivet.sphere({ radius: 0.012, widthSegments: 12, heightSegments: 6 });
  rivet.planeCut({ point: [0, 0, 0], normal: [0, 1, 0], keep: 'positive' });
  rivet.translate(sel.all(), [w - 0.025, 0, d - 0.025]);
  rivet.mirror({ axis: 'x' });
  rivet.mirror({ axis: 'z' });
  rivet.uv.project({ mode: 'box', scale: 0.5 });

  // Lid plate: built as its own part, turned to face +Y and placed on the top opening.
  const lidPlate = session('lidPlate');
  lidPlate.plane({ width: p.width, height: p.depth });
  lidPlate.rotate(sel.all(), 'x', -90);
  lidPlate.translate(sel.all(), [0, h, 0]);

  // Hinge: a tube with its middle knuckle removed and re-bridged into one pin.
  const hinge = session('hinge');
  const span = p.width * 0.9;
  hinge.cylinder({ radiusTop: 0.012, radiusBottom: 0.012, height: span, radialSegments: 12, heightSegments: 3, tag: 'metal' });
  hinge.delete(sel.inBox([-1, -span / 6 - 1e-6, -1], [1, span / 6 + 1e-6, 1]));
  hinge.bridge(sel.edges.meshBoundary(), { segments: 3, label: 'pin' });
  hinge.rotate(sel.all(), 'z', 90);
  hinge.translate(sel.all(), [0, h + 0.012, -d - 0.012]);

  // Body.
  const m = session('crate');
  m.box({ size: [p.width, p.height, p.depth], tag: 'shell', label: 'body' });
  m.loopCut(sel.edges.parallel('y'), { cuts: 2 });
  m.checkpoint('banded');
  m.inset(sel.tag('shell').and(sel.inBox([-reach, -band - 1e-6, -reach], [reach, band + 1e-6, reach])), { thickness: 0.02, region: 'perFace', label: 'panel' });
  m.extrude(sel.createdBy('panel', 'inner'), { distance: -0.012, region: 'perFace', label: 'recess' });
  m.checkpoint('panels');
  m.delete(sel.extreme('+y'));
  m.append(lidPlate, { label: 'lid', tag: 'lid' });
  m.weld({ distance: 1e-6 });
  m.inset(sel.createdBy('lid', 'part'), { thickness: 0.05, region: 'merged', label: 'lid-rim' });
  m.offset(sel.createdBy('lid-rim', 'inner'), { distance: 0.02, region: 'merged', label: 'lid-boss' });
  m.checkpoint('lid');
  m.inset(sel.extreme('-y'), { thickness: 0.05, region: 'merged', label: 'base' });
  m.extrude(sel.createdBy('base', 'rim'), { distance: 0.03, region: 'merged', label: 'skirt' });
  m.checkpoint('base');
  m.append(handle, { label: 'handles' });
  m.append(hinge, { label: 'hinge' });
  m.lift(exported(rivet), { label: 'rivets', tag: 'metal' });
  m.translate(sel.createdBy('rivets', 'face'), [0, h, 0]);
  m.dissolve(sel.createdBy('rivets', 'face').toEdges('contained').and(sel.edges.dihedral('<', 1)));
  m.orient(sel.all());
  m.checkpoint('assembled');
  m.markSharp(sel.edges.dihedral('>', 35));
  m.assign(sel.tag('metal'), 'metal');
  m.assign(sel.createdBy('recess', 'top'), 'panel');
  m.assign(sel.createdBy('lid-boss', 'top'), 'trim');
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}
