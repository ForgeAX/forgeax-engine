import type { Tuple3 } from '@forgeax/engine-modeling';
import { SPLITS } from './s2-body.ts';
import { NOSE } from './s3-rough.ts';
import { S6A_ANCHORS } from './s6a-anchors.ts';
import { type AnchorSpec, resolveAnchor } from './s6c-hosts.ts';
import type { Anchor } from './s6c-kit.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): where the details sit. Cabin stations are S6c's
 * own; exterior details hosted on a feature line resolve on the shell (`s6c-hosts.ts`), the
 * rest come from the S6a form line's table (`s6a-anchors.ts`).
 */

const ACROSS: Tuple3 = [1, 0, 0];

/** Cabin anchors: tub floor stations and the dash cowl (car frame, both sides explicit). */
export const CABIN = {
  /** Seats 5 cm forward of the S6c original, clear of the v3 hip housings behind them (car z -0.46..-0.24). */
  'seat-l': { part: 'monocoque', origin: [0.38, 0.246, 0.03], normal: [0, 1, 0], tangent: ACROSS },
  'seat-r': { part: 'monocoque', origin: [-0.38, 0.246, 0.03], normal: [0, 1, 0], tangent: ACROSS },
  /** Column axis toward the driver, 20 degrees above horizontal. */
  wheel: { part: 'monocoque', origin: [0.38, 0.715, 0.44], normal: [0, Math.sin(Math.PI / 9), -Math.cos(Math.PI / 9)], tangent: ACROSS },
  dash: { part: 'monocoque', origin: [0, 0.79, 0.6], normal: [0, 1, 0], tangent: ACROSS },
  /** Console channel floor at the dash, 1 cm over the v3 torso frame's crossbars (y 0.42–0.48); the stowed core passes under its bridge. */
  console: { part: 'monocoque', origin: [0, 0.49, 0.58], normal: [0, 1, 0], tangent: ACROSS },
  pedals: { part: 'monocoque', origin: [0.38, 0.246, 0.4], normal: [0, 1, 0], tangent: ACROSS },
} as const satisfies Record<string, Anchor>;

/**
 * Exterior details on the feature-line feature lines, left side. The others wait for what they need:
 * lamp, intake and exhaust outlines for the named front-face / tail-band loops, the wipers and
 * the door hinge for the cowl and A-pillar stations, the side-intake vanes and the door handle
 * (tucked under the intake lip) for the intake loop, the rear tow cover and diffuser fins for
 * the tail plane.
 */
export const HOSTED: Readonly<Record<string, AnchorSpec>> = {
  /** Level stalk at the door's front top corner, where the blueprint's front view has the mirror. */
  'mirror-l': { host: 'door-l-outer', line: 'belt', at: SPLITS.doorFront - 0.04, offset: [0, 0.019], lift: 0.001, normal: [1, 0.05, 0] },
  'tow-front': { host: 'bumper-corner-l', line: 'rocker-front', at: NOSE - 0.06, offset: [0, 0.08], lift: 0.0005 },
};

let exterior: Readonly<Record<string, Anchor>> | undefined;

/** Exterior anchors: the hosted ones resolved on the shell over the S6a table. */
export function bodyAnchors(): Readonly<Record<string, Anchor>> {
  exterior ??= {
    ...S6A_ANCHORS,
    ...Object.fromEntries(
      Object.entries(HOSTED).map(([key, spec]) => {
        const a = resolveAnchor(spec);
        if (a === undefined) throw new Error(`anchor ${key}: ${spec.line} at ${spec.at} is off the shell`);
        return [key, a];
      }),
    ),
  };
  return exterior;
}
