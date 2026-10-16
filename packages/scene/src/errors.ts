import type { EcsError, EntityHandle } from '@forgeax/engine-ecs';
import type { SceneEntityRef } from '@forgeax/engine-types';

export type SceneErrorCode = 'hierarchy-broken' | 'hierarchy-cycle';

/** Scene-instantiation failures owned by the scene package. */
export type SceneInstanceErrorCode = 'component-not-defined' | 'scene-override-type-mismatch';

export { ComponentNotDefinedError } from '@forgeax/engine-ecs/projection';

/** The structured ECS failure retained by a Scene derived-write diagnostic. */
export interface SceneErrorCause {
  readonly code: EcsError['code'];
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: unknown;
}

/** Location detail shared by hierarchy diagnostics and derived-write errors. */
export interface SceneHierarchyErrorDetail {
  readonly kind?: 'hierarchy';
  readonly entity: EntityHandle;
  readonly parent: EntityHandle;
}

/** A flat derived publication failure with its original ECS error intact. */
export interface SceneDerivedWriteErrorDetail {
  readonly kind: 'derived-write';
  readonly entity: EntityHandle;
  readonly parent: EntityHandle;
  readonly bindingIndex: number;
  readonly base: number;
  readonly start: number;
  readonly count: number;
  readonly cause: SceneErrorCause;
}

export type SceneErrorDetail = SceneHierarchyErrorDetail | SceneDerivedWriteErrorDetail;

export class SceneError extends Error {
  readonly code: SceneErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneErrorDetail | undefined;

  constructor(args: {
    code: SceneErrorCode;
    expected: string;
    hint: string;
    detail?: SceneErrorDetail;
  }) {
    super(`[SceneError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'SceneError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Non-blocking `Mobility` contract violations. Detection belongs to the package
 * that can see both sides of the contract (scene: Transform, render: meshes,
 * physics: RigidBody); every producer reports through this one union.
 */
export type MobilityDiagnosticCode =
  | 'mobility-invalid-kind'
  | 'mobility-static-moved'
  | 'mobility-physics-conflict';

/** Entity location shared by every Mobility diagnostic. */
export interface MobilityDiagnosticSubject {
  readonly entity: EntityHandle;
  /** Persistent authored identity; absent for runtime-spawned entities. */
  readonly sceneEntityRef?: SceneEntityRef;
}

export type MobilityInvalidKindDetail = MobilityDiagnosticSubject;

export type MobilityStaticMovedDetail = MobilityDiagnosticSubject;

export interface MobilityPhysicsConflictDetail extends MobilityDiagnosticSubject {
  readonly rigidBodyType: 'dynamic' | 'kinematic';
}

/** One reported Mobility violation; `detail` narrows per `code`. */
export type MobilityDiagnostic =
  | {
      readonly code: 'mobility-invalid-kind';
      readonly expected: string;
      readonly hint: string;
      readonly detail: MobilityInvalidKindDetail;
    }
  | {
      readonly code: 'mobility-static-moved';
      readonly expected: string;
      readonly hint: string;
      readonly detail: MobilityStaticMovedDetail;
    }
  | {
      readonly code: 'mobility-physics-conflict';
      readonly expected: string;
      readonly hint: string;
      readonly detail: MobilityPhysicsConflictDetail;
    };
