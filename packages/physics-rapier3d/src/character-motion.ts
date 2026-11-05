import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  CharacterController,
  type CharacterSynchronization,
  Collider,
  PHYSICS_ERROR_HINTS,
  PhysicsError,
  RigidBodyTypeValue,
} from '@forgeax/engine-physics';
import { unpackSlot } from '@forgeax/engine-types';
import { rapierBodyTypeToString } from './body-type.js';
import type { RapierRigidBody } from './physics-entity-records.js';
import {
  type PhysicsSyncQueryRow,
  type PhysicsSyncState,
  readPhysicsSyncDescriptor,
} from './physics-sync.js';
import type { Rapier3DModule } from './wasm-loader.js';

/** Preserve moveAndSlide's fail-fast order before touching ECS state. */
export function requireCharacterBody(
  entity: number,
  body: RapierRigidBody | undefined,
  rapier: Rapier3DModule,
): RapierRigidBody {
  if (!body)
    throw new PhysicsError({
      code: 'body-not-found',
      expected: 'a registered Rapier body for this entity',
      hint: PHYSICS_ERROR_HINTS['body-not-found'],
      detail: { code: 'body-not-found', entity },
    });
  if (body.numColliders() === 0)
    throw new PhysicsError({
      code: 'collider-not-found',
      expected: 'a Collider attached to this entity body',
      hint: PHYSICS_ERROR_HINTS['collider-not-found'],
      detail: { code: 'collider-not-found', entity },
    });
  if (body.bodyType() !== rapier.RigidBodyType.KinematicPositionBased)
    throw new PhysicsError({
      code: 'controller-requires-kinematic',
      expected: "RigidBody.type === 'kinematic'",
      hint: PHYSICS_ERROR_HINTS['controller-requires-kinematic'],
      detail: {
        code: 'controller-requires-kinematic',
        entity,
        bodyType: rapierBodyTypeToString(rapier, body.bodyType()),
      },
    });
  return body;
}

/** Borrow the existing per-entity sync receipt without accepting the global cursor. */
export function characterSynchronizationSource(
  entity: number,
  character: CharacterSynchronization,
  body: RapierRigidBody | undefined,
  state: PhysicsSyncState | undefined,
  rapier: Rapier3DModule,
) {
  if (!body)
    throw new PhysicsError({
      code: 'body-not-found',
      expected: 'a registered character body',
      hint: PHYSICS_ERROR_HINTS['body-not-found'],
      detail: { code: 'body-not-found', entity },
    });
  if (
    character.position.length !== 3 ||
    !Array.from(character.position).every(Number.isFinite) ||
    typeof character.grounded !== 'boolean'
  )
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'a finite character center and boolean grounded state',
      hint: PHYSICS_ERROR_HINTS['invalid-body-config'],
      detail: { code: 'invalid-body-config', field: 'character', value: character },
    });
  const handle = entity as EntityHandle;
  let row: PhysicsSyncQueryRow | undefined;
  if (state)
    for (const query of state.queries) {
      row = query.at(handle);
      if (row) break;
    }
  if (!state || !row?.has(state.transformComponent) || !row.has(CharacterController))
    throw new PhysicsError({
      code: 'invalid-body-config',
      expected: 'a live CharacterController registered with physics systems',
      hint: PHYSICS_ERROR_HINTS['invalid-body-config'],
      detail: { code: 'invalid-body-config', field: 'CharacterController', value: entity },
    });
  if (!row.has(Collider))
    throw new PhysicsError({
      code: 'collider-not-found',
      expected: 'an authored character Collider',
      hint: PHYSICS_ERROR_HINTS['collider-not-found'],
      detail: { code: 'collider-not-found', entity },
    });
  const index = unpackSlot(entity),
    accepted = state.accepted.get(index),
    previous = accepted?.entity === handle ? accepted : undefined;
  const current = readPhysicsSyncDescriptor(row, state, previous);
  if (
    body.bodyType() !== rapier.RigidBodyType.KinematicPositionBased ||
    current?.rigidBody.type !== RigidBodyTypeValue.kinematic
  )
    throw new PhysicsError({
      code: 'controller-requires-kinematic',
      expected: 'an authored kinematic character',
      hint: PHYSICS_ERROR_HINTS['controller-requires-kinematic'],
      detail: {
        code: 'controller-requires-kinematic',
        entity,
        bodyType: rapierBodyTypeToString(rapier, body.bodyType()),
      },
    });
  return { state, handle, index, previous };
}
