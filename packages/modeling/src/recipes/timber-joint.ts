import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { type DesignedContact, partDistance, partGeometry } from '../interference';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export type TimberJointKind = 'through' | 'blind';

export interface TimberJointOptions extends RecipeNaming {
  /** `through`: the mortise runs the post's full width and opens at both faces; `blind`: it stops short of the back (default `through`). */
  readonly kind?: TimberJointKind;
  /** Post width, the reference dimension of the joint (meters). */
  readonly postWidth: number;
  /** Beam height along Y (meters, default 1.5 post widths). */
  readonly beamHeight?: number;
  /**
   * Blind only: tenon seating depth into the post along X (meters, default 0.6 post width). A
   * through tenon crosses the full post width, so it takes no tenonLength.
   */
  readonly tenonLength?: number;
  /**
   * How far the tenon end stands past the post's far face (meters, default 0.15 of the tenon
   * height). Zero flushes it with the face; negative values are refused.
   */
  readonly protrusion?: number;
  /** Clearance on every tenon and peg face (meters, default 0.5 mm). */
  readonly clearance?: number;
  /** Peg diameter (meters, default one third of the tenon thickness). Pass 0 for no peg. */
  readonly pegDiameter?: number;
}

/**
 * Declared ranges. The clearance band (0.2 to 2 mm) covers the allowance around the 0.5 mm
 * default; the beam height and tenon length are multiples of the post width; protrusion is at
 * most half the post width.
 */
export const TIMBER_JOINT_RANGES = {
  postWidth: [0.05, 0.3],
  beamHeightPosts: [1, 3],
  tenonLengthPosts: [0.3, 0.9],
  clearance: [0.0002, 0.002],
  protrusionPosts: [0, 0.5],
} as const satisfies Record<string, Range>;

/** Tenon thickness is one third of the post width (secondary: common carpentry rule). */
const TENON_THICKNESS_RATIO = 1 / 3;
/** Tenon height is half the beam height (a chosen proportion, not a source value). */
const TENON_HEIGHT_RATIO = 1 / 2;
/** Default protrusion as a fraction of the tenon height (design choice). */
const PROTRUSION_RATIO = 0.15;
/** Shoulder length along the beam axis, as a fraction of the beam height (design choice). */
const SHOULDER_RATIO = 1;
/** Peg diameter as a fraction of the tenon thickness (design choice). */
const PEG_RATIO = 1 / 3;
/** Polygon sides for the peg and its holes (design choice; a clamp, not a fine surface). */
const PEG_SIDES = 16;

export interface TimberJointShape {
  readonly kind: TimberJointKind;
  readonly postWidth: number;
  readonly beamHeight: number;
  readonly tenonLength: number;
  /** Tenon length plus protrusion: the distance from the shoulder face to the tenon end. */
  readonly tenonReach: number;
  readonly protrusion: number;
  readonly tenonThickness: number;
  readonly tenonHeight: number;
  readonly clearance: number;
  readonly pegDiameter: number;
}

/** Validate the options into a shape; every refusal is a `model-invalid-argument`. */
export function timberShape(options: TimberJointOptions): Result<TimberJointShape, ModelingError> {
  const kind = options.kind ?? 'through';
  if (kind !== 'through' && kind !== 'blind') {
    return err(
      modelingError(
        'model-invalid-argument',
        'a timber joint kind of through or blind',
        { kind },
        'choose through or blind; a dovetail is not modeled by this recipe',
      ),
    );
  }
  const clearance = options.clearance ?? 0.0005;
  const postWidth = options.postWidth;
  const checked = checkAll([
    () => inRange('postWidth', postWidth, TIMBER_JOINT_RANGES.postWidth),
    () => inRange('clearance', clearance, TIMBER_JOINT_RANGES.clearance),
  ]);
  if (!checked.ok) return checked;
  const beamHeight = options.beamHeight ?? 1.5 * postWidth;
  // A through tenon crosses the whole post, so its seated length is the post width; a blind tenon
  // seats for the chosen depth. An explicit tenonLength on a through joint would be ignored, so it
  // is refused instead.
  if (kind === 'through' && options.tenonLength !== undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a through joint with no tenonLength: its tenon spans the full post width',
        { tenonLength: options.tenonLength },
        'omit tenonLength for a through joint; use kind blind to choose a seating depth',
      ),
    );
  }
  const tenonLength = kind === 'through' ? postWidth : (options.tenonLength ?? 0.6 * postWidth);
  const height = inRange('beamHeight', beamHeight, [
    TIMBER_JOINT_RANGES.beamHeightPosts[0] * postWidth,
    TIMBER_JOINT_RANGES.beamHeightPosts[1] * postWidth,
  ]);
  if (!height.ok) return height;
  if (kind === 'blind') {
    const length = inRange('tenonLength', tenonLength, [
      TIMBER_JOINT_RANGES.tenonLengthPosts[0] * postWidth,
      TIMBER_JOINT_RANGES.tenonLengthPosts[1] * postWidth,
    ]);
    if (!length.ok) return length;
  }
  const tenonHeight = TENON_HEIGHT_RATIO * beamHeight;
  const protrusion =
    options.protrusion ?? (kind === 'through' ? PROTRUSION_RATIO * tenonHeight : 0);
  if (protrusion < 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a protrusion of zero or more: the tenon end stands past the post face or stops flush',
        { protrusion },
        'pass protrusion 0 to flush the tenon with the far face, or a positive reach beyond it',
      ),
    );
  }
  const reach = inRange('protrusion', protrusion, [
    TIMBER_JOINT_RANGES.protrusionPosts[0] * postWidth,
    TIMBER_JOINT_RANGES.protrusionPosts[1] * postWidth,
  ]);
  if (!reach.ok) return reach;
  // A blind pocket keeps its back closed: the tenon stops flush at the pocket floor, so it cannot
  // stand past the far face the way a through tenon does.
  if (kind === 'blind' && protrusion !== 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a blind joint with no protrusion: its tenon stops at the closed pocket floor',
        { protrusion },
        'pass protrusion 0 for a blind joint, or use through to stand the tenon past the far face',
      ),
    );
  }
  // A blind pocket keeps wood behind its floor: the tenon end and its clearance leave a floor
  // that must stand at least one clearance inside the post's back face.
  if (kind === 'blind' && tenonLength + 2 * clearance >= postWidth) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a blind tenon that leaves wood behind its pocket floor',
        { tenonLength, postWidth, clearance },
        'a blind tenon this long would break through the back of the post; shorten tenonLength or use through',
      ),
    );
  }
  const tenonThickness = TENON_THICKNESS_RATIO * postWidth;
  const pegDiameter = options.pegDiameter ?? PEG_RATIO * tenonThickness;
  // The peg hole (diameter plus a clearance on each side) must sit inside the tenon's section, so
  // the hole never reaches the shoulder or the tenon's outer faces.
  const holeDiameter = pegDiameter + 2 * clearance;
  if (
    pegDiameter !== 0 &&
    !(pegDiameter > 0 && holeDiameter < Math.min(tenonLength, tenonHeight))
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        'a peg hole that fits inside the tenon length and height',
        { pegDiameter, holeDiameter, tenonLength, tenonHeight },
        'shorten the peg, lengthen the tenon or raise beamHeight; pass 0 for no peg',
      ),
    );
  }
  return ok({
    kind,
    postWidth,
    beamHeight,
    tenonLength,
    tenonReach: tenonLength + protrusion,
    protrusion,
    tenonThickness,
    tenonHeight,
    clearance,
    pegDiameter,
  });
}

/**
 * A mortise-and-tenon joint with a shouldered beam and an optional peg.
 *
 * Parts (labels; the renderer groups every `timber-joint-beam*` part with the beam):
 * - `timber-joint-post`: a block with a mortise. A `through` mortise opens at both X faces, so
 *   the far face shows a slot the tenon end passes through. A `blind` mortise opens at the -X
 *   face only and keeps a closed back, `clearance` short of the far face.
 * - `timber-joint-beam`: the shoulder block that stands outside the post's -X face.
 * - `timber-joint-beam-tenon`: the tenon, from the shoulder face through the mortise to
 *   `tenonReach`, so it stands `protrusion` past the far face.
 * - `timber-joint-beam-peg`: a round peg along Z through clearance holes in the tenon and in the
 *   post walls, crossing the tenon inside the post, present when `pegDiameter > 0`.
 *
 * Contacts: the shoulder seats on the post's -X face and the tenon seats on the shoulder face
 * (`seat`); the tenon faces meet the mortise walls at `clearance` (`fit`, band
 * [clearance / 2, 2 clearance]); the peg is a `fit` against the tenon and the post because its
 * holes exist.
 */
export function timberJoint(options: TimberJointOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'timber-joint';
  const shape = timberShape(options);
  if (!shape.ok) return shape;
  const s = shape.value;
  const c = s.clearance;
  const w = s.postWidth;
  const label = (role: string): string => `${name}-${role}`;
  const shoulderLength = SHOULDER_RATIO * s.beamHeight;
  // The tenon starts at the shoulder face (x = -w / 2) and ends at x = -w / 2 + tenonReach.
  const tenonStartX = -0.5 * w;
  const tenonCentreX = tenonStartX + s.tenonReach / 2;
  // The peg crosses the tenon at its centre and runs along Z past both post faces.
  const pegCentreX = tenonCentreX;
  const pegRadius = s.pegDiameter / 2;
  const holeRadius = pegRadius + c;
  const pegLength = w + s.pegDiameter;

  const tenon = (): Model => {
    const m = model();
    m.box({
      size: [s.tenonReach, s.tenonHeight, s.tenonThickness],
      center: [tenonCentreX, 0, 0],
      label: label('beam-tenon'),
    });
    return m;
  };

  const post = model();
  post.box({ size: [w, w, w], label: label('post') });
  // Through: the pocket runs the full post width and opens at both X faces. Blind: it opens at
  // the -X face and stops `clearance` short of the far face, leaving a closed back.
  const pocket = s.kind === 'through' ? w + 2 * c : s.tenonLength + 2 * c;
  const pocketCentreX = s.kind === 'through' ? 0 : -0.5 * w + s.tenonLength / 2;
  const mortise = model();
  mortise.box({
    size: [pocket, s.tenonHeight + 2 * c, s.tenonThickness + 2 * c],
    center: [pocketCentreX, 0, 0],
    label: label('mortise'),
  });
  post.difference(mortise, { label: label('mortise') });
  if (post.poisoned !== undefined) return err(post.poisoned);

  // The tenon is measured alone: the shoulder's seat on the post face would otherwise read as
  // zero clearance. The measurement runs before any peg hole is cut.
  const measured = measureClearance(name, post, tenon(), c, w);
  if (!measured.ok) return measured;

  if (s.pegDiameter > 0) {
    const hole = pegCylinder(holeRadius, pegLength, pegCentreX, label('post-hole'));
    if (!hole.ok) return hole;
    post.difference(hole.value, { label: label('post') });
    if (post.poisoned !== undefined) return err(post.poisoned);
  }

  const shoulder = model();
  shoulder.box({
    size: [shoulderLength, s.beamHeight, w],
    center: [-0.5 * w - shoulderLength / 2, 0, 0],
    label: label('beam'),
  });
  const beamTenon = tenon();
  if (s.pegDiameter > 0) {
    const hole = pegCylinder(holeRadius, pegLength, pegCentreX, label('tenon-hole'));
    if (!hole.ok) return hole;
    beamTenon.difference(hole.value, { label: label('beam-tenon') });
  }
  if (beamTenon.poisoned !== undefined) return err(beamTenon.poisoned);

  post.append(shoulder, { tag: name });
  post.append(beamTenon, { tag: name });

  const contacts: DesignedContact[] = [
    { parts: [label('post'), label('beam')], kind: 'seat' },
    { parts: [label('beam'), label('beam-tenon')], kind: 'seat' },
    { parts: [label('post'), label('beam-tenon')], kind: 'fit', gap: [c / 2, 2 * c] },
  ];

  if (s.pegDiameter > 0) {
    const peg = pegCylinder(pegRadius, pegLength, pegCentreX, label('beam-peg'));
    if (!peg.ok) return peg;
    post.append(peg.value, { tag: name });
    contacts.push(
      { parts: [label('beam-tenon'), label('beam-peg')], kind: 'fit', gap: [c / 2, 2 * c] },
      { parts: [label('post'), label('beam-peg')], kind: 'fit', gap: [c / 2, 2 * c] },
    );
  }

  const finished = finishPart(
    post,
    name,
    {
      mortise: [0, 0, 0],
      shoulder: [-0.5 * w - shoulderLength, 0, 0],
      peg: [pegCentreX, 0, 0],
    },
    {
      measuredClearance: measured.value,
      postWidth: w,
      beamHeight: s.beamHeight,
      tenonLength: s.tenonLength,
      tenonReach: s.tenonReach,
      protrusion: s.protrusion,
      tenonThickness: s.tenonThickness,
      tenonHeight: s.tenonHeight,
      clearance: c,
      pegDiameter: s.pegDiameter,
    },
  );
  if (!finished.ok) return finished;
  return ok({ ...finished.value, contacts });
}

/** A round prism along Z of the given length, centred on the Z axis at x = centreX, y = 0. */
function pegCylinder(
  radius: number,
  length: number,
  centreX: number,
  label: string,
): Result<Model, ModelingError> {
  const points: Point2[] = Array.from({ length: PEG_SIDES }, (_, i) => {
    const a = (2 * Math.PI * i) / PEG_SIDES;
    return [centreX + radius * cos(a), radius * sin(a)] as Point2;
  });
  const m = model();
  m.extrudePolygon({ points, depth: length, label });
  m.translate(sel.all(), [0, 0, -length / 2]);
  if (m.poisoned !== undefined) return err(m.poisoned);
  return ok(m);
}

/**
 * Closest distance between the post and the tenon measured on their own sessions before the
 * append, the same partDistance validate uses for a fit. A joint with no measurable gap is refused.
 */
function measureClearance(
  name: string,
  post: Model,
  tenon: Model,
  clearance: number,
  postWidth: number,
): Result<number, ModelingError> {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const;
  const geometry = [
    partGeometry(post.editMesh, `${name}-post`, post.editMesh.faces(), true),
    partGeometry(tenon.editMesh, `${name}-beam-tenon`, tenon.editMesh.faces(), true),
  ];
  const measured = partDistance(
    geometry,
    0,
    1,
    { deltas: [identity, identity], relative: () => identity },
    4 * clearance + postWidth,
  );
  if (!(measured > 0) || !Number.isFinite(measured)) {
    return err(
      modelingError(
        'model-degenerate',
        'a tenon with a measurable clearance from its mortise',
        { measured, clearance },
        'the tenon meets its mortise; a joint with no clearance is not a fit',
      ),
    );
  }
  return ok(measured);
}
