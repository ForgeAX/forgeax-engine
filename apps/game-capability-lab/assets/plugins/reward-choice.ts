import { FixedUpdate, defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  RigidBody,
  RigidBodyTypeValue,
  type PhysicsWorld,
} from '@forgeax/engine-physics';
import { Transform } from '@forgeax/engine-scene';
import { inState } from '@forgeax/engine-state';
import { GameState } from './gameplay-state';

const PEDESTAL_SENSOR_RADIUS = 0.82;
const STATE_NONE = 0;
const STATE_SHIELD_READY = 1;
const STATE_OVERCHARGE_READY = 2;
const STATE_CONSUMED = 3;

export type RewardChoiceState = 'none' | 'shield-ready' | 'overcharge-ready' | 'consumed';
export type RewardKind = 'shield' | 'overcharge';

/** The player-carried authority for the complete reward-choice lifecycle. */
export const RewardChoice = defineComponent('GameDefaultRewardChoice', {
  state: 'u32',
  contactMask: 'u32',
  unavailableRefusals: 'u32',
  nonPlayerContactMask: 'u32',
  lockedRefusals: 'u32',
  simultaneousContacts: 'u32',
  selections: 'u32',
  shieldConsumptions: 'u32',
  overchargeConsumptions: 'u32',
}, { transient: true });

/** Runtime projection marker for one authored reward pedestal. */
export const RewardPedestal = defineComponent('GameDefaultRewardPedestal', {
  authoredLocalId: 'u32',
  kind: 'u32',
}, { transient: true });

export type AuthoredRewardPedestalIdentity = {
  readonly entity: EntityHandle;
  readonly localId: number;
  readonly kind: RewardKind;
};

export type AuthoredRewardChoiceIdentity = {
  readonly pedestals: readonly AuthoredRewardPedestalIdentity[];
};

export type RewardPedestalContact = {
  readonly entity: number;
  readonly authoredLocalId: number;
  readonly kind: RewardKind;
};

export type RewardContactResolution = {
  readonly state: RewardChoiceState;
  readonly selected: RewardKind | null;
  readonly refusal: 'unavailable' | 'locked' | null;
  readonly simultaneous: boolean;
};

export function resolveRewardChoiceContacts(
  colliding: ReadonlyArray<number> | Uint32Array,
  pedestals: readonly RewardPedestalContact[],
  state: RewardChoiceState,
  available: boolean,
): RewardContactResolution {
  const candidates = pedestals
    .filter((pedestal) => colliding.includes(pedestal.entity))
    .sort((a, b) => a.authoredLocalId - b.authoredLocalId);
  const simultaneous = candidates.length > 1;
  if (candidates.length === 0) return { state, selected: null, refusal: null, simultaneous };
  if (state !== 'none') return { state, selected: null, refusal: 'locked', simultaneous };
  if (!available) return { state, selected: null, refusal: 'unavailable', simultaneous };
  const selected = candidates[0]?.kind ?? null;
  return {
    state: selected === 'shield' ? 'shield-ready' : 'overcharge-ready',
    selected,
    refusal: null,
    simultaneous,
  };
}

export type RewardChoiceSnapshot = {
  readonly state: RewardChoiceState;
  readonly available: boolean;
  readonly unavailableRefusals: number;
  readonly nonPlayerRefusals: number;
  readonly lockedRefusals: number;
  readonly simultaneousContacts: number;
  readonly selections: number;
  readonly shieldConsumptions: number;
  readonly overchargeConsumptions: number;
  readonly pedestals: readonly {
    readonly entity: number;
    readonly authoredLocalId: number;
    readonly kind: RewardKind;
    readonly position: readonly [number, number, number];
    readonly physicsReady: boolean;
  }[];
};

export type RewardChoiceEvent = 'selected' | 'refused' | 'shield-consumed' | 'overcharge-consumed';

export type RewardChoiceHandle = {
  readonly installSystem: (ctx: {
    readonly physics: PhysicsWorld | undefined;
    readonly isAvailable: () => boolean;
    readonly onProgress: (snapshot: RewardChoiceSnapshot) => void;
    readonly onChange: (
      snapshot: RewardChoiceSnapshot,
      event: RewardChoiceEvent,
      position: readonly [number, number, number],
    ) => void;
  }) => void;
  readonly consumeShield: () => boolean;
  readonly consumeOvercharge: () => boolean;
  readonly reset: () => void;
  readonly snapshot: () => RewardChoiceSnapshot;
};

function stateName(value: number): RewardChoiceState {
  if (value === STATE_SHIELD_READY) return 'shield-ready';
  if (value === STATE_OVERCHARGE_READY) return 'overcharge-ready';
  if (value === STATE_CONSUMED) return 'consumed';
  return 'none';
}

/** Compose the two authored sensors into one reset-safe ECS reward authority. */
export function createRewardChoice(
  world: World,
  player: EntityHandle,
  authored: AuthoredRewardChoiceIdentity,
): RewardChoiceHandle | undefined {
  const pedestals = [...authored.pedestals].sort((a, b) => a.localId - b.localId);
  if (pedestals.length !== 2 || pedestals[0]?.kind !== 'shield' || pedestals[1]?.kind !== 'overcharge') return undefined;
  const pedestalContacts: readonly RewardPedestalContact[] = pedestals.map((pedestal) => ({
    entity: pedestal.entity,
    authoredLocalId: pedestal.localId,
    kind: pedestal.kind,
  }));
  const baseScales = new Map<number, readonly [number, number, number]>();
  for (const pedestal of pedestals) {
    const transform = world.get(pedestal.entity, Transform);
    if (!transform.ok) return undefined;
    baseScales.set(pedestal.entity, [
      transform.value.scale[0] ?? 1,
      transform.value.scale[1] ?? 1,
      transform.value.scale[2] ?? 1,
    ]);
  }

  let physics: PhysicsWorld | undefined;
  let available = (): boolean => false;
  let onChange: ((snapshot: RewardChoiceSnapshot, event: RewardChoiceEvent, position: readonly [number, number, number]) => void) | undefined;

  const authority = () => world.get(player, RewardChoice);
  const positionOf = (entity: EntityHandle): readonly [number, number, number] => {
    const transform = world.get(entity, Transform);
    return transform.ok
      ? [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0]
      : [0, 0, 0];
  };
  const projectVisuals = (state: RewardChoiceState): void => {
    for (const pedestal of pedestals) {
      const base = baseScales.get(pedestal.entity);
      if (base === undefined) continue;
      const selected = state === `${pedestal.kind}-ready`;
      const factor = state === 'none' ? (available() ? 1.25 : 0.82) : selected ? 1.45 : 0.68;
      world.set(pedestal.entity, Transform, {
        scale: [base[0] * factor, base[1] * factor, base[2] * factor],
      });
    }
  };
  const reset = (): void => {
    world.set(player, RewardChoice, {
      state: STATE_NONE,
      contactMask: 0,
      unavailableRefusals: 0,
      nonPlayerContactMask: 0,
      lockedRefusals: 0,
      simultaneousContacts: 0,
      selections: 0,
      shieldConsumptions: 0,
      overchargeConsumptions: 0,
    });
    for (const pedestal of pedestals) {
      const scale = baseScales.get(pedestal.entity);
      if (scale !== undefined) world.set(pedestal.entity, Transform, { scale });
      world.set(pedestal.entity, RewardPedestal, {
        authoredLocalId: pedestal.localId,
        kind: pedestal.kind === 'shield' ? 0 : 1,
      });
      world.set(pedestal.entity, RigidBody, { type: RigidBodyTypeValue.kinematic });
      world.set(pedestal.entity, Collider, {
        shape: ColliderShapeValue.sphere,
        radius: PEDESTAL_SENSOR_RADIUS,
        isSensor: true,
      });
      if (physics?.hasBody(pedestal.entity)) {
        const position = positionOf(pedestal.entity);
        physics.teleport(pedestal.entity, vec3.create(position[0], position[1], position[2]));
      }
    }
  };
  const snapshot = (): RewardChoiceSnapshot => {
    const value = authority();
    const state = value.ok ? value.value : {
      state: STATE_NONE,
      contactMask: 0,
      unavailableRefusals: 0,
      nonPlayerContactMask: 0,
      lockedRefusals: 0,
      simultaneousContacts: 0,
      selections: 0,
      shieldConsumptions: 0,
      overchargeConsumptions: 0,
    };
    return {
      state: stateName(state.state),
      available: available(),
      unavailableRefusals: state.unavailableRefusals,
      nonPlayerRefusals: (state.nonPlayerContactMask & 1) + ((state.nonPlayerContactMask >> 1) & 1),
      lockedRefusals: state.lockedRefusals,
      simultaneousContacts: state.simultaneousContacts,
      selections: state.selections,
      shieldConsumptions: state.shieldConsumptions,
      overchargeConsumptions: state.overchargeConsumptions,
      pedestals: pedestals.map((pedestal) => ({
        entity: pedestal.entity,
        authoredLocalId: pedestal.localId,
        kind: pedestal.kind,
        position: positionOf(pedestal.entity),
        physicsReady: physics?.hasBody(pedestal.entity) === true,
      })),
    };
  };
  const consume = (kind: RewardKind): boolean => {
    const state = authority();
    const ready = kind === 'shield' ? STATE_SHIELD_READY : STATE_OVERCHARGE_READY;
    if (!state.ok || state.value.state !== ready) return false;
    world.set(player, RewardChoice, {
      state: STATE_CONSUMED,
      ...(kind === 'shield'
        ? { shieldConsumptions: state.value.shieldConsumptions + 1 }
        : { overchargeConsumptions: state.value.overchargeConsumptions + 1 }),
    });
    projectVisuals('consumed');
    onChange?.(snapshot(), `${kind}-consumed`, positionOf(player));
    return true;
  };

  world.addComponent(player, { component: RewardChoice, data: {} }).unwrap();
  for (const pedestal of pedestals) {
    world.addComponent(pedestal.entity, {
      component: RewardPedestal,
      data: { authoredLocalId: pedestal.localId, kind: pedestal.kind === 'shield' ? 0 : 1 },
    }).unwrap();
    world.addComponent(pedestal.entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } }).unwrap();
    world.addComponent(pedestal.entity, {
      component: Collider,
      data: { shape: ColliderShapeValue.sphere, radius: PEDESTAL_SENSOR_RADIUS, isSensor: true },
    }).unwrap();
    world.addComponent(pedestal.entity, { component: CollidingEntities, data: { entities: [] } }).unwrap();
  }
  reset();

  return {
    installSystem: (ctx) => {
      physics = ctx.physics;
      available = ctx.isAvailable;
      onChange = ctx.onChange;
      world.addSystem(FixedUpdate, {
        name: 'game-reward-choice',
        runIf: inState(GameState, 'Play'),
        after: ['game-energy-core-extraction'],
        before: ['game-counterattack'],
        queries: [],
        fn: () => {
          const state = authority();
          if (!state.ok) return;
          let next = { ...state.value };
          for (let index = 0; index < pedestals.length; index++) {
            const pedestal = pedestals[index];
            if (pedestal === undefined) continue;
            const contacts = world.get(pedestal.entity, CollidingEntities);
            if (!contacts.ok) continue;
            if (contacts.value.entities.some((entity) => entity !== player)) next.nonPlayerContactMask |= 2 ** index;
          }
          const contacts = world.get(player, CollidingEntities);
          const colliding: ReadonlyArray<number> | Uint32Array = contacts.ok ? contacts.value.entities : [];
          let contactMask = 0;
          for (let index = 0; index < pedestalContacts.length; index++) {
            const pedestal = pedestalContacts[index];
            if (pedestal !== undefined && colliding.includes(pedestal.entity)) contactMask |= 2 ** index;
          }
          const entered = pedestalContacts
            .filter((_pedestal, index) => (contactMask & 2 ** index) !== 0 && (next.contactMask & 2 ** index) === 0)
            .map((pedestal) => pedestal.entity);
          const resolved = resolveRewardChoiceContacts(
            entered,
            pedestalContacts,
            stateName(next.state),
            available(),
          );
          next.contactMask = contactMask;
          if (resolved.simultaneous) next.simultaneousContacts += 1;
          if (resolved.refusal === 'unavailable') next.unavailableRefusals += 1;
          if (resolved.refusal === 'locked') next.lockedRefusals += 1;
          if (resolved.selected !== null) {
            next.state = resolved.selected === 'shield' ? STATE_SHIELD_READY : STATE_OVERCHARGE_READY;
            next.selections += 1;
          }
          world.set(player, RewardChoice, next);
          projectVisuals(resolved.state);
          ctx.onProgress(snapshot());
          if (resolved.selected !== null) {
            const pedestal = pedestals.find((candidate) => candidate.kind === resolved.selected);
            onChange?.(snapshot(), 'selected', pedestal === undefined ? positionOf(player) : positionOf(pedestal.entity));
          } else if (resolved.refusal !== null) {
            onChange?.(snapshot(), 'refused', positionOf(player));
          }
        },
      }).unwrap();
    },
    consumeShield: () => consume('shield'),
    consumeOvercharge: () => consume('overcharge'),
    reset,
    snapshot,
  };
}
