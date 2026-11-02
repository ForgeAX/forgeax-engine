/**
 * The Show timeline: an ordered list of segments, each one beat on one subject. Pure
 * functions map a time on the timeline to the cue and the stage pose of that instant,
 * so the same choreography drives the browser, the Dawn smoke and the tests.
 */
export type ShowSegmentKind = 'turntable' | 'transform' | 'explode' | 'section' | 'xray' | 'history';

export interface ShowSegment {
  /** Index into the Show's subject list. */
  readonly subject: number;
  readonly kind: ShowSegmentKind;
  readonly seconds: number;
  /** Transformation path parameter held through a segment of another kind (default 0, the first form). */
  readonly form?: number;
}

export interface ShowCue {
  readonly index: number;
  readonly segment: ShowSegment;
  /** Progress inside the segment, 0..1. */
  readonly u: number;
}

export type CameraRail = 'orbit' | 'cinematic' | 'low';

/** What every owner is asked to show at one instant of a segment. */
export interface StagePose {
  /** Turntable yaw in radians. */
  readonly spin: number;
  /** Transformation path parameter of a rigged subject (0 = first form). */
  readonly transform: number;
  /** Explode amount, 0..1. */
  readonly explode: number;
  /** Section plane position across the subject bounds, 0..1; undefined = no cut. */
  readonly section: number | undefined;
  /** Shell parts drawn as X-ray. */
  readonly xray: boolean;
  /** Position on the build history, 0..1; undefined = the finished subject. */
  readonly history: number | undefined;
  /** Camera rail, position on it, and distance scale from the subject (1 = the rail). */
  readonly camera: { readonly rail: CameraRail; readonly u: number; readonly zoom?: number };
  /** Strength of the low flank kicker light, 0..1 (default 1); a film keeps it on the car shots. */
  readonly kicker?: number;
  /**
   * A composed shot instead of the rail: the camera looks at height `aim` (0 = floor, 1 =
   * top of the form on stage) from `azimuth` (radians about +y from +z, in the subject's
   * frame) and `pitch`, through a lens of `lensMm` (35 mm full-frame equivalent), at the
   * distance where the form fills `fill` of the frame height (and of its width).
   */
  readonly shot?: {
    readonly azimuth: number;
    readonly pitch: number;
    readonly lensMm: number;
    readonly fill: number;
    readonly aim: number;
    /** Fit only the height: a close shot may crop the form's ends (default: keep it in the width). */
    readonly crop?: boolean;
  };
}

export function timelineSeconds(segments: readonly ShowSegment[]): number {
  return segments.reduce((sum, s) => sum + s.seconds, 0);
}

/** The cue at `time` seconds; the timeline loops. */
export function cueAt(segments: readonly ShowSegment[], time: number): ShowCue {
  const total = timelineSeconds(segments);
  if (segments.length === 0 || !(total > 0)) throw new Error('a Show needs segments with positive length');
  let t = ((time % total) + total) % total;
  for (const [index, segment] of segments.entries()) {
    if (t < segment.seconds || index === segments.length - 1) {
      return { index, segment, u: Math.min(1, Math.max(0, t / segment.seconds)) };
    }
    t -= segment.seconds;
  }
  throw new Error('unreachable');
}

/** Timeline time of `u` inside segment `index`; u = 1 stays on the segment's last instant. */
export function timeOf(segments: readonly ShowSegment[], index: number, u: number): number {
  let t = 0;
  for (let i = 0; i < index; i++) t += (segments[i] as ShowSegment).seconds;
  const seconds = (segments[index] as ShowSegment).seconds;
  return t + Math.min(seconds * (1 - 1e-9), Math.max(0, u) * seconds);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Rise over [0, a], hold, fall over [b, 1]. */
const envelope = (u: number, a: number, b: number) => smooth(0, a, u) * (1 - smooth(b, 1, u));

/** The stage pose of a cue: the segment kind's choreography, held at the segment's form. */
export function cuePose(
  segment: ShowSegment,
  u: number,
  pose: (kind: ShowSegmentKind, u: number, index: number) => StagePose = stagePose,
  index = 0,
): StagePose {
  const staged = pose(segment.kind, u, index);
  return segment.form === undefined || segment.kind === 'transform' ? staged : { ...staged, transform: segment.form };
}

export function stagePose(kind: ShowSegmentKind, u: number): StagePose {
  const rest = { spin: 0, transform: 0, explode: 0, section: undefined, xray: false, history: undefined };
  switch (kind) {
    case 'turntable':
      return { ...rest, spin: u * 2 * Math.PI, camera: { rail: 'orbit', u: 0.08 * u } };
    case 'transform':
      // Hold each form briefly; the camera flies the cinematic rail meanwhile.
      return { ...rest, transform: smooth(0.12, 0.88, u), camera: { rail: 'cinematic', u } };
    case 'explode': {
      const explode = envelope(u, 0.35, 0.8);
      return { ...rest, spin: 0.6 * u, explode, camera: { rail: 'orbit', u: 0.1 + 0.05 * u, zoom: 1 + 0.45 * explode } };
    }
    case 'section':
      // The plane sweeps in to the middle of the subject and back out.
      return { ...rest, section: 0.3 - 0.25 * Math.cos(2 * Math.PI * u), camera: { rail: 'low', u: 0.15 * u } };
    case 'xray':
      return { ...rest, xray: true, transform: envelope(u, 0.45, 0.75), camera: { rail: 'orbit', u: 0.2 + 0.1 * u } };
    case 'history':
      return { ...rest, spin: 0.5 * u, history: u, camera: { rail: 'orbit', u: 0.05 * u } };
  }
}
