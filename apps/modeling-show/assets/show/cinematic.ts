import type { ShowSegment, StagePose } from './director.ts';

/**
 * The mech-gt film as a shot list for offline rendering: car beauty shots on a slowly
 * turning turntable, then the transformation with the turntable stopped and one shot per
 * read point of the clip's beats (S7-MOTION.md "Motion"), a push-in on the head for the
 * final pose, and the robot on the turntable. Each shot is a composed camera
 * (`StagePose.shot`: azimuth in the subject's frame, pitch, lens, fill, aim) that drifts
 * slightly, so no two frames repeat. `filmCue(t)` maps film time to the Show cue and
 * `filmPose` is the matching choreography.
 */
export const FILM_FPS = 24;
/** Length of the S7 forward clip in seconds (run to the robot, brace and pose by 15.6 s, then the hold). */
export const CLIP_SECONDS = 18;
const DEG = Math.PI / 180;

export const FILM_SEGMENTS: readonly ShowSegment[] = [
  { subject: 0, kind: 'turntable', seconds: 5.5 },
  // The transforming car at rest before it moves: its redesigned door side and deck (W-F23).
  { subject: 1, kind: 'turntable', seconds: 4.5, form: 0 },
  { subject: 1, kind: 'transform', seconds: CLIP_SECONDS },
  { subject: 1, kind: 'turntable', seconds: 6, form: 1 },
];

export const FILM_SECONDS = FILM_SEGMENTS.reduce((sum, s) => sum + s.seconds, 0);

interface Shot {
  /** Start, in seconds within its segment. */
  readonly from: number;
  readonly azimuth: number;
  readonly pitch: number;
  readonly lensMm: number;
  readonly fill: number;
  readonly aim: number;
  readonly crop?: boolean;
  /** End values the shot moves to (push-ins, drifts); default: a 3 % dolly-in and a 4 degree arc. */
  readonly to?: Partial<Omit<Shot, 'from' | 'to' | 'crop'>>;
}

/**
 * Shots per segment, in segment seconds. Azimuths are in the subject's frame: the car's
 * front faces +z (0); the standing figure turns to face +z as well.
 */
const SHOTS: readonly (readonly Shot[])[] = [
  [
    // Car beauty: long lens, low, front three-quarter, then the side profile.
    { from: 0, azimuth: 35 * DEG, pitch: 5 * DEG, lensMm: 100, fill: 0.42, aim: 0.45 },
    { from: 3, azimuth: 95 * DEG, pitch: 3 * DEG, lensMm: 135, fill: 0.34, aim: 0.45 },
  ],
  [
    // Tight on the left door and intake (W-F23), long lens; the camera tracks along the flank so
    // the highlight sweeps across the panel.
    { from: 0, azimuth: 118 * DEG, pitch: 3 * DEG, lensMm: 135, fill: 0.68, aim: 0.48, crop: true, to: { azimuth: 68 * DEG } },
    // Rear three-quarter, a little above: the deck-edge roll and the rear-fender haunch in reflection.
    { from: 2.3, azimuth: 145 * DEG, pitch: 12 * DEG, lensMm: 85, fill: 0.55, aim: 0.42, to: { azimuth: 160 * DEG } },
  ],
  [
    // unlatch, split, legs (clip 0-4.2): rear three-quarter from above, so the split, the legs
    // and the underside of the rising engine cover read
    { from: 0, azimuth: 145 * DEG, pitch: 18 * DEG, lensMm: 35, fill: 0.45, aim: 0.45, to: { azimuth: 135 * DEG } },
    // stand, wheels out, chest and turn while it rises (4.2-7.8): from the side, so the opening
    // silhouette reads instead of the underbody
    { from: 4.2, azimuth: 95 * DEG, pitch: 5 * DEG, lensMm: 40, fill: 0.72, aim: 0.5, to: { azimuth: 70 * DEG } },
    // arms, wheels in, shoulders, head (7.8-12.4)
    { from: 7.8, azimuth: -25 * DEG, pitch: 5 * DEG, lensMm: 45, fill: 0.78, aim: 0.52 },
    // armor and the robot reached (12.4-13.8)
    { from: 12.4, azimuth: 10 * DEG, pitch: 4 * DEG, lensMm: 50, fill: 0.8, aim: 0.55 },
    // brace, pose and hold (13.8-18): low hero angle on the side the torso turns to, pushing in
    {
      from: 13.8,
      azimuth: 58 * DEG,
      pitch: -3 * DEG,
      lensMm: 40,
      fill: 0.82,
      aim: 0.5,
      // Ends on the head with the eye line on the upper third.
      to: { lensMm: 70, fill: 1.2, aim: 0.7, azimuth: 50 * DEG },
    },
  ],
  [
    // The robot on the turntable, front three-quarter.
    { from: 0, azimuth: 30 * DEG, pitch: 5 * DEG, lensMm: 50, fill: 0.82, aim: 0.5 },
  ],
];

/** Turntable spin while the car turns (radians per second); it stops for the transformation. */
const CAR_SPIN = 10 * DEG;
const ROBOT_SPIN = 18 * DEG;

/** The cue (segment, u) at film time `t` seconds. */
export function filmCue(t: number): { readonly segment: number; readonly u: number } {
  let rest = Math.min(Math.max(t, 0), FILM_SECONDS);
  for (const [segment, s] of FILM_SEGMENTS.entries()) {
    if (rest < s.seconds || segment === FILM_SEGMENTS.length - 1) return { segment, u: Math.min(1, rest / s.seconds) };
    rest -= s.seconds;
  }
  throw new Error('unreachable');
}

const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export function filmPose(_kind: ShowSegment['kind'], u: number, index: number): StagePose {
  const segment = FILM_SEGMENTS[index] as ShowSegment;
  const t = u * segment.seconds;
  const shots = SHOTS[index] as readonly Shot[];
  const at = shots.reduce((found, s, i) => (s.from <= t ? i : found), 0);
  const shot = shots[at] as Shot;
  const end = (shots[at + 1]?.from ?? segment.seconds) - shot.from;
  const k = ease((t - shot.from) / end);
  const to = shot.to ?? { fill: shot.fill * 1.03, azimuth: shot.azimuth + 4 * DEG };
  const mix = (a: number, b: number | undefined) => a + ((b ?? a) - a) * k;
  const spin = index === 0 ? CAR_SPIN * t : index === FILM_SEGMENTS.length - 1 ? ROBOT_SPIN * t : 0;
  return {
    spin,
    transform: segment.kind === 'transform' ? u : (segment.form ?? 0),
    explode: 0,
    section: undefined,
    xray: false,
    history: undefined,
    camera: { rail: 'low', u: 0 },
    // The flank kicker serves the car shots; it fades out as the car stands up (its floor streak).
    kicker: index < 2 ? 1 : index === 2 ? 1 - ease(t / 3) : 0,
    shot: {
      azimuth: mix(shot.azimuth, to.azimuth),
      pitch: mix(shot.pitch, to.pitch),
      lensMm: mix(shot.lensMm, to.lensMm),
      fill: mix(shot.fill, to.fill),
      aim: mix(shot.aim, to.aim),
      ...(shot.crop === true ? { crop: true } : {}),
    },
  };
}
