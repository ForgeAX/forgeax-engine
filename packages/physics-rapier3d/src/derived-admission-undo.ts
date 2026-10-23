import type { DerivedPhysicsMotion, DerivedPhysicsPublication } from '@forgeax/engine-physics';
import type {
  DerivedBodyRecord,
  DerivedBodySource,
  DerivedCandidateRecord,
  DerivedConstraintRecord,
} from './derived-candidate-records.js';
import type { RapierRigidBody, RapierWorld } from './physics-entity-records.js';

interface XYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Native body state one derived admission must restore exactly on rollback. */
export interface DerivedBodyState {
  readonly bodyType: number;
  readonly enabled: boolean;
  readonly linearVelocity: XYZ;
  readonly angularVelocity: XYZ;
  readonly translation: XYZ;
  readonly rotation: XYZ & { readonly w: number };
  readonly worldCom: XYZ;
  readonly mass: number;
}

/** Everything one record's admission replaces, captured before any native change. */
export interface DerivedAdmissionUndo {
  readonly record: DerivedCandidateRecord;
  readonly body: RapierRigidBody;
  readonly bodyState: DerivedBodyState;
  readonly old: DerivedBodyRecord | undefined;
  readonly automaticAdditionalMass: number;
  readonly automaticRecordMass: number | undefined;
  readonly source: DerivedBodySource | undefined;
  readonly publication: DerivedPhysicsPublication | undefined;
  readonly colliders: readonly {
    readonly collider: RapierWorld;
    readonly density: number | undefined;
    readonly enabled: boolean;
  }[];
  readonly constraints: ReadonlyMap<string, DerivedConstraintRecord>;
  readonly stagedConstraints: Map<string, DerivedConstraintRecord>;
  /** A thrown consumer geometry callback may have changed ECS state. */
  geometryCommitUncertain: boolean;
}

export function captureDerivedBodyState(body: RapierRigidBody): DerivedBodyState {
  return {
    bodyType: body.bodyType(),
    enabled: body.isEnabled(),
    linearVelocity: body.linvel(),
    angularVelocity: body.angvel(),
    translation: body.translation(),
    rotation: body.rotation(),
    worldCom: body.worldCom(),
    mass: body.mass(),
  };
}

function near(current: XYZ, previous: XYZ): boolean {
  return (
    Math.abs(current.x - previous.x) <= 1e-6 &&
    Math.abs(current.y - previous.y) <= 1e-6 &&
    Math.abs(current.z - previous.z) <= 1e-6
  );
}

/** Rollback is certified only when the native body reads back its captured state. */
export function derivedBodyStateRestored(body: RapierRigidBody, state: DerivedBodyState): boolean {
  const currentMass = body.mass();
  const currentRotation = body.rotation();
  return (
    Number.isFinite(currentMass) &&
    Math.abs(currentMass - state.mass) <= 1e-6 * Math.max(1, Math.abs(state.mass)) &&
    near(body.worldCom(), state.worldCom) &&
    near(body.linvel(), state.linearVelocity) &&
    near(body.angvel(), state.angularVelocity) &&
    Math.abs(
      currentRotation.x * state.rotation.x +
        currentRotation.y * state.rotation.y +
        currentRotation.z * state.rotation.z +
        currentRotation.w * state.rotation.w,
    ) >=
      1 - 1e-6 &&
    body.bodyType() === state.bodyType &&
    body.isEnabled() === state.enabled
  );
}

/** Move the body so its center of mass lands on the authored one, then adopt velocities. */
export function applyDerivedMotion(
  body: RapierRigidBody,
  motion: DerivedPhysicsMotion,
  lockRotation: boolean,
): void {
  const currentCom = body.worldCom();
  const targetCom = motion.centerOfMass;
  const translation = body.translation();
  body.setTranslation(
    {
      x: translation.x + targetCom[0] - currentCom.x,
      y: translation.y + targetCom[1] - currentCom.y,
      z: translation.z + targetCom[2] - currentCom.z,
    },
    true,
  );
  body.setLinvel(
    { x: motion.linearVelocity[0], y: motion.linearVelocity[1], z: motion.linearVelocity[2] },
    true,
  );
  body.setAngvel(
    lockRotation
      ? { x: 0, y: 0, z: 0 }
      : {
          x: motion.angularVelocity[0],
          y: motion.angularVelocity[1],
          z: motion.angularVelocity[2],
        },
    true,
  );
}
