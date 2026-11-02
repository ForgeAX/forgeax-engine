import type { Beat, Choreography, ChoreographyPhase, JointSpec, ModelingError, Rig } from '@forgeax/engine-modeling';
import type { Result } from '@forgeax/engine-types';
import { buildLimb, LIMB_DEFAULTS, type LimbParameters, limbJoints, limbRig } from '../transforming-limb/limb.ts';

/**
 * Case C-118: the C-107 limb (the C-100 car's front-left corner that becomes the robot's
 * left arm) choreographed with `rig.choreograph` instead of hand keys: one main action at a
 * time with a held read point after each, overshoot settles on the big swings
 * (K-A2), the claw opening while the fender settles onto the shoulder as a pauldron. The
 * motion report, holding efforts, space claims per phase, the fender's release from the body
 * and its closed stop check the result.
 */
export const DURATION = 8.4;

/** Joint groups of the motion report: the four main actions. */
export const GROUPS = {
  fender: ['fender-hinge'],
  wheel: ['wheel-swing'],
  arm: ['shoulder', 'elbow'],
  hand: ['telescope', 'claw'],
} as const;

type Shape = Pick<Beat, 'anticipate' | 'overshoot'>;

/**
 * The beats of the three designs. The first anticipated the fender's opening: a dip below
 * closed, where the fender would push into the body; `choreograph` refuses it (the hinge's
 * lower limit is 0) instead of clamping it silently. The second anticipated the shoulder:
 * -3.6 degrees is inside its -5 limit, but the scan confirms the upper arm in the chassis, so
 * the final design settles the swings with overshoot only.
 */
export const DESIGNS = {
  first: { fender: { anticipate: 0.04, overshoot: 0.03 }, shoulder: { anticipate: 0.04, overshoot: 0.03 } },
  second: { fender: { overshoot: 0.03 }, shoulder: { anticipate: 0.04, overshoot: 0.03 } },
  final: { fender: { overshoot: 0.03 }, shoulder: { overshoot: 0.03 } },
} as const satisfies Record<string, { fender: Shape; shoulder: Shape }>;

export type Design = keyof typeof DESIGNS;

export function limbPhases(design: Design = 'final', p: LimbParameters = LIMB_DEFAULTS): ChoreographyPhase[] {
  const { fender, shoulder } = DESIGNS[design];
  return [
    { id: 'fender-open', from: { 'fender-hinge': 0 }, to: { 'fender-hinge': 105 }, beat: { span: [0, 1], ...fender } },
    { id: 'wheel-up', from: { 'wheel-swing': 0 }, to: { 'wheel-swing': p.wheelSwing }, beat: { span: [1.4, 2.3], overshoot: 0.05 } },
    { id: 'shoulder-down', from: { shoulder: 0 }, to: { shoulder: 90 }, beat: { span: [2.7, 4.1], ...shoulder } },
    { id: 'elbow-unfold', from: { elbow: 0 }, to: { elbow: -160 }, beat: { span: [4.5, 5.9], overshoot: 0.04 } },
    { id: 'hand-out', from: { telescope: 0 }, to: { telescope: p.stroke }, beat: { span: [6.3, 6.9] } },
    { id: 'claw-open', from: { claw: 0 }, to: { claw: -80 }, beat: { span: [7.3, 7.9], overshoot: 0.06 } },
    { id: 'pauldron', from: { 'fender-hinge': 105 }, to: { 'fender-hinge': 60 }, beat: { span: [7.3, 7.9], overshoot: 0.05 } },
  ];
}

export function choreographLimb(r: Rig, design: Design = 'final'): Result<Choreography, ModelingError> {
  return r.choreograph({ phases: limbPhases(design), duration: DURATION, interpolation: 'hermite' });
}

/** C-107's joints, the fender hinge closing onto the chassis (its hard stop). */
export function choreoJoints(p: LimbParameters = LIMB_DEFAULTS): JointSpec[] {
  return limbJoints(p).map((j) =>
    j.name === 'fender-hinge' ? { ...j, stops: { min: { stop: 'chassis', against: 'fender' } } } : j,
  );
}

export function choreoRig(p: LimbParameters = LIMB_DEFAULTS): Rig {
  return limbRig(buildLimb(p), p, choreoJoints(p));
}
