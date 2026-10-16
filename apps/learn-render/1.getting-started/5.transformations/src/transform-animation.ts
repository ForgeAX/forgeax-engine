// transform-animation.ts -- pure helper exposing the LO §1.5 demo's
// per-frame Transform mapping as a t-only function so the unit test
// (transform-state.test.ts) can assert field values without booting a
// renderer / canvas / WebGPU. The system fn body in index.ts calls
// `computeTransformAt(elapsedSeconds)` each tick; the renderer reads
// the mutated Transform SoA columns and the engine-internal mat4
// composer turns them into the GPU uniform.
//
// Charter P5 producer / consumer split: the helper produces the field
// values; the system fn consumes them to write Transform columns; the
// engine RenderSystem consumes the columns to compose the world matrix.
//
// LO §1.5 verbatim (from the canonical learnopengl.com chapter):
//   trans = glm::translate(trans, glm::vec3(0.5f, -0.5f, 0.0f));
//   trans = glm::rotate(trans, (float)glfwGetTime(), glm::vec3(0,0,1));
//   trans = glm::scale(trans, glm::vec3(0.5, 0.5, 0.5));
//
// forgeax maps this to the Transform component's pos/quat/scale array columns:
//   pos   = (0.5, -0.5, 0)               (LO translate constant).
//   quat  = (0, 0, sin(t/2), cos(t/2))   (Z-axis quaternion, [x,y,z,w]).
//   scale = sin-pulse 0.5 + 0.5*sin(t*2pi/3) (D-8 / OOS-8 carve-
//                                                   out animates the
//                                                   static glm::vec3(
//                                                   0.5) into a
//                                                   visible pulse).
//
// Plan-decisions L-3: the sin-pulse public formula is documented as
// `0.5 + 0.5 * sin(t * 2 pi / 3)` -- the touch-zero bottom is briefly
// invisible at t = 1.5s mod 3s (per request, OOS-8 already accepts this
// trade off). README "diff with LO" row carries the carve-out note.

import { quat } from '@forgeax/engine-math';

export interface TransformFieldsAt {
  readonly pos: readonly [number, number, number];
  /** Quaternion component order [x, y, z, w]. */
  readonly quat: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

const PULSE_PERIOD_SECONDS = 3;
const TWO_PI = Math.PI * 2;
const Z_AXIS: Readonly<[number, number, number]> = [0, 0, 1];

/**
 * Compute the LO §1.5 Transform field values at elapsed time `t`
 * (seconds). Pure function -- allocates one `Quat` per call.
 *
 * @param t elapsed seconds since the demo's animation epoch.
 */
export function computeTransformAt(t: number): TransformFieldsAt {
  // LO rotate(t, Z) -> quat.fromAxisAngle(Z_AXIS, t).
  const q = quat.fromAxisAngle(quat.create(), Z_AXIS, t);

  // sin-pulse scale animation (D-8): 0.5 + 0.5 * sin(t * 2 pi / 3).
  const pulse = 0.5 + 0.5 * Math.sin((t * TWO_PI) / PULSE_PERIOD_SECONDS);

  return {
    // LO translate constant.
    pos: [0.5, -0.5, 0],
    quat: [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1],
    scale: [pulse, pulse, pulse],
  };
}
