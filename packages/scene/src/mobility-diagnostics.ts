import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type {
  MobilityDiagnostic,
  MobilityDiagnosticCode,
  MobilityDiagnosticSubject,
} from './errors';
import { worldSceneEntityRefOf } from './instances/entity-ref';

/** Producer-supplied facts for one violation; scene derives entity location and text. */
export type MobilityViolation = MobilityDiagnostic extends infer D
  ? D extends MobilityDiagnostic
    ? { readonly code: D['code'] } & Omit<D['detail'], keyof MobilityDiagnosticSubject>
    : never
  : never;

export type MobilityDiagnosticListener = (
  world: World,
  diagnostic: Readonly<MobilityDiagnostic>,
) => void;

const MOBILITY_TEXT: Readonly<
  Record<MobilityDiagnosticCode, { readonly expected: string; readonly hint: string }>
> = {
  'mobility-invalid-kind': {
    expected:
      "Mobility 'stationary' only on light entities; mesh entities are 'static' or 'movable'",
    hint: 'set Mobility.kind to MobilityKindValue.static (never moves) or MobilityKindValue.movable, or remove Mobility',
  },
  'mobility-static-moved': {
    expected: "an entity with Mobility 'static' keeps its Transform after placement",
    hint: 'declare MobilityKindValue.movable (or remove Mobility) on entities that move; rendering stays correct, but static caches and baked data for this entity become stale',
  },
  'mobility-physics-conflict': {
    expected: "Mobility 'static' only with no RigidBody or RigidBody type 'static'",
    hint: "declare MobilityKindValue.movable for simulated or kinematic bodies, or set RigidBody.type to 'static'; neither component is derived from the other",
  },
};

const reportedByWorld = new WeakMap<World, Set<string>>();
const listeners = new Set<MobilityDiagnosticListener>();

/** Observe Mobility violations. Each `(World, code, entity)` is reported once. */
export function subscribeMobilityDiagnostics(listener: MobilityDiagnosticListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Report one Mobility violation found by its detecting owner. Returns false when
 * the same `(code, entity)` was already reported for this World.
 */
export function emitMobilityDiagnostic(
  world: World,
  entity: EntityHandle,
  violation: MobilityViolation,
): boolean {
  let reported = reportedByWorld.get(world);
  if (reported === undefined) {
    reported = new Set();
    reportedByWorld.set(world, reported);
  }
  const key = `${violation.code}|${entity}`;
  if (reported.has(key)) return false;
  reported.add(key);

  const sceneEntityRef = worldSceneEntityRefOf(world, entity);
  const { code, ...facts } = violation;
  const diagnostic = Object.freeze({
    code,
    ...MOBILITY_TEXT[code],
    detail: Object.freeze({
      ...facts,
      entity,
      ...(sceneEntityRef === undefined ? {} : { sceneEntityRef }),
    }),
  }) as MobilityDiagnostic;
  for (const listener of listeners) {
    try {
      listener(world, diagnostic);
    } catch {
      // Diagnostics must never break the detecting system.
    }
  }
  console.warn(diagnostic);
  return true;
}
