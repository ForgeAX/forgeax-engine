import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-002: a desk lamp built from the operators and selectors C-001 did not use:
 * a revolved weighted base with a sharp rim loop, an extruded switch tab, ring-seeded
 * grip cuts on the stem, a duplicated joint knob, a cable clip ripped open with
 * `split` and capped with `fillHoles`, a faceted cone shade cut with `bisect`, capped,
 * triangulated into vents and given a welded inner liner selected by `thin`, and a
 * bulb whose metal socket is `disconnect`ed from the glass. Straight-line code: tools
 * map every journal entry back to the call on its source line.
 */
export interface LampParameters {
  /** Length of the lower arm (meters). */
  readonly height: number;
  /** Forward lean of the upper arm from vertical (degrees). */
  readonly reach: number;
  /** Mouth radius of the shade (meters). */
  readonly shadeRadius: number;
}

export const LAMP_DEFAULTS: LampParameters = { height: 0.22, reach: 40, shadeRadius: 0.075 };


export function buildLamp(
  p: LampParameters = LAMP_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const baseTop = 0.036;
  const elbow = baseTop + p.height;
  const upper = 0.2;
  /** Clearance between an arm end and its joint pin. */
  const gap = 0.006;
  const stem = p.height - gap;
  const lean = (p.reach * Math.PI) / 180;
  const tip: [number, number, number] = [0, elbow + upper * Math.cos(lean), upper * Math.sin(lean)];
  const shadeHeight = p.shadeRadius * 1.4;
  const apex = shadeHeight / 2;
  const capY = apex - shadeHeight * 0.28;
  // The shade keeps a fixed 110 degree turn from the upper arm, so no reach swings the
  // arm into it; its cap faces the tip joint 0.5 mm off the cheeks.
  const tilt = 110 - p.reach;
  const back: [number, number, number] = [0, Math.cos((tilt * Math.PI) / 180), -Math.sin((tilt * Math.PI) / 180)];
  const standoff = capY + 0.0125;
  const mount: [number, number, number] = [tip[0], tip[1] - back[1] * standoff, tip[2] - back[2] * standoff];

  // Base: a revolved weighted disc; the rim band's two edge loops are made crisp.
  const base = session('base');
  base.revolve({ points: [[0, 0], [0.1, 0], [0.105, 0.006], [0.105, 0.024], [0.094, 0.031], [0.03, baseTop], [0, baseTop]], segments: 32, label: 'base', tag: 'base' });
  base.markSharp(sel.near([0.105, 0.015, 0], 1).toEdges('touching').and(sel.edges.perpendicular('y')).loop());

  // Switch: a chamfered tab outline extruded and laid on the base slope.
  const tab = session('switch');
  tab.extrudePolygon({ points: [[-0.012, -0.005], [0.012, -0.005], [0.015, -0.002], [0.015, 0.002], [0.012, 0.005], [-0.012, 0.005], [-0.015, 0.002], [-0.015, -0.002]], depth: 0.006, label: 'switch', tag: 'switch' });
  tab.rotate(sel.all(), 'x', -90);
  tab.translate(sel.all(), [0, baseTop, 0.019]);

  // Cable clip: a rectangular ring ripped open along its front meridian, capped, sprung open.
  const clip = session('clip');
  clip.revolve({ points: [[0.0105, 0], [0.013, 0], [0.013, 0.01], [0.0105, 0.01], [0.0105, 0]], segments: 16, label: 'clip', tag: 'clip' });
  clip.split(sel.inBox([-1e-6, -1, 0], [1, 1, 1]).toEdges('touching').and(sel.inBox([-1, -1, 0], [1e-6, 1, 1]).toEdges('touching')));
  clip.fillHoles(sel.edges.meshBoundary(), { label: 'clip-end' });
  clip.rotate(sel.inBox([0, -1, -1], [1, 1, 1]), 'y', 12);
  clip.translate(sel.all(), [0, baseTop + p.height * 0.35, 0]);

  // Bulb: the pole faces nearest the top become the neck, extruded into a disconnected socket.
  const bulb = session('bulb');
  bulb.sphere({ radius: 0.022, widthSegments: 16, heightSegments: 10, label: 'glass', tag: 'bulb' });
  bulb.delete(sel.near([0, 0.022, 0], 16));
  bulb.fillHoles(sel.edges.meshBoundary(), { label: 'neck' });
  bulb.extrude(sel.createdBy('neck', 'cap'), { distance: 0.018, region: 'merged', label: 'socket' });
  bulb.disconnect(sel.createdBy('socket'));
  bulb.translate(sel.all(), [0, capY - 0.0424, 0]);

  // Shade: a faceted cone cut below the apex and capped, lined, then vents pressed into the cap.
  const shade = session('shade');
  shade.cone({ radius: p.shadeRadius, height: shadeHeight, radialSegments: 8, heightSegments: 3, label: 'shade', tag: 'shade' });
  shade.bisect({ point: [0, capY, 0], normal: [0, 1, 0] });
  shade.delete(sel.side([0, capY, 0], [0, 1, 0]));
  shade.fillHoles(sel.edges.meshBoundary(), { label: 'shade-top' });
  shade.delete(sel.createdBy('shade', 'bottom'));
  shade.duplicate(sel.all(), { label: 'liner' });
  shade.flip(sel.createdBy('liner', 'copy'));
  shade.offset(sel.createdBy('liner', 'copy'), { distance: 0.0025, region: 'merged', label: 'liner' });
  shade.weld({ distance: 1e-7 });
  shade.triangulate(sel.createdBy('shade-top', 'cap'));
  shade.inset(sel.createdBy('shade-top', 'cap'), { thickness: p.shadeRadius / 30, region: 'perFace', label: 'vent' });
  shade.extrude(sel.createdBy('vent', 'inner'), { distance: -0.0012, region: 'perFace', label: 'vent-depth' });
  shade.append(bulb);
  shade.rotate(sel.all(), 'x', -tilt);
  shade.translate(sel.all(), mount);

  // Stand: lower arm with ring-seeded grip cuts, a pin-and-cheek joint duplicated to the tip.
  const m = session('lamp');
  m.cylinder({ radiusTop: 0.008, radiusBottom: 0.008, height: stem, radialSegments: 12, heightSegments: 3, center: [0, baseTop + stem / 2, 0], label: 'stem', tag: 'arm' });
  m.loopCut(sel.near([0.008, baseTop + stem * 0.75, 0], 1).toEdges('touching').and(sel.edges.parallel('y')).ring(), { cuts: 2 });
  m.offset(sel.inBox([-1, baseTop + stem * 0.75, -1], [1, baseTop + stem * 0.9, 1]), { distance: 0.0012, region: 'merged', label: 'grip' });
  m.cylinder({ radiusTop: 0.004, radiusBottom: 0.004, height: 0.018, radialSegments: 12, label: 'pin', tag: 'joint' });
  m.cylinder({ radiusTop: 0.012, radiusBottom: 0.012, height: 0.004, radialSegments: 16, center: [0, 0.011, 0], label: 'cheek', tag: 'joint' });
  m.duplicate(sel.createdBy('cheek'), { label: 'cheek-far' });
  m.translate(sel.createdBy('cheek-far'), [0, -0.022, 0]);
  m.rotate(sel.tag('joint'), 'z', 90);
  m.translate(sel.tag('joint'), [0, elbow, 0]);
  m.duplicate(sel.tag('joint'), { label: 'joint-tip' });
  m.translate(sel.createdBy('joint-tip'), [tip[0], tip[1] - elbow, tip[2]]);
  m.cylinder({ radiusTop: 0.007, radiusBottom: 0.007, height: upper - 2 * gap, radialSegments: 12, label: 'arm', tag: 'arm' });
  m.rotate(sel.createdBy('arm'), 'x', p.reach);
  m.translate(sel.createdBy('arm'), [0, elbow + (upper / 2) * Math.cos(lean), (upper / 2) * Math.sin(lean)]);
  m.append(base);
  m.append(tab);
  m.append(clip);
  m.append(shade);
  m.markSharp(sel.edges.dihedral('>', 40));
  m.assign(sel.tag('base').or(sel.tag('joint')), 'metal');
  m.assign(sel.tag('switch'), 'rubber');
  m.assign(sel.tag('shade'), 'enamel');
  m.assign(sel.thin(0.003).and(sel.createdBy('liner', 'top')), 'reflector');
  m.assign(sel.tag('bulb'), 'glass');
  m.assign(sel.createdBy('socket'), 'brass');
  m.uv.project({ mode: 'box', scale: 0.25 });
  return m;
}
