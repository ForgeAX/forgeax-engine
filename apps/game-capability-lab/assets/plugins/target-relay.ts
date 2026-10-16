import { Disabled, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import { Name, Transform } from '@forgeax/engine-scene';
import { ResetPose } from './components/gameplay';
import { ScoringTarget, scoringTargetEntities, type ScoringTargetQuery } from './scoring-target';
import { TargetHealth } from './target-health';

const TARGET_RELAY_RESOURCE = 'gameDefaultTargetRelay';

export type TargetRelaySnapshot = {
  readonly status: 'locked' | 'active' | 'complete';
  readonly currentStep: number;
  readonly cleared: number;
  readonly total: number;
  readonly activeTarget: EntityHandle | null;
  readonly activeTargetName: string | null;
  readonly acceptedHits: number;
  readonly rejectedHits: number;
  readonly variationActive: boolean;
};

type TargetRelayState = {
  readonly status: TargetRelaySnapshot['status'];
  readonly currentStep: number;
  readonly acceptedHits: number;
  readonly rejectedHits: number;
};

type TargetVariation = {
  readonly variationTarget: EntityHandle;
  readonly variationAvailable: boolean;
  readonly setVariationActive: (active: boolean) => void;
};

export type TargetRelayHandle = {
  readonly begin: () => void;
  readonly recordHit: (entity: EntityHandle) => boolean;
  readonly activeTarget: () => EntityHandle | undefined;
  readonly snapshot: () => TargetRelaySnapshot;
  readonly reset: () => void;
};

function initialState(): TargetRelayState {
  return { status: 'locked', currentStep: 0, acceptedHits: 0, rejectedHits: 0 };
}

/** Derive the relay target from the authored ECS roster; only progress is state. */
export function createTargetRelay(
  world: World,
  query: ScoringTargetQuery,
  variation?: TargetVariation,
): TargetRelayHandle {
  world.insertResource(TARGET_RELAY_RESOURCE, initialState());
  const read = (): TargetRelayState => world.getResource<TargetRelayState>(TARGET_RELAY_RESOURCE);
  const write = (state: TargetRelayState): void => world.insertResource(TARGET_RELAY_RESOURCE, state);
  const targetForStep = (step: number): EntityHandle | undefined => scoringTargetEntities(query)
    .find((entity) => {
      const target = world.get(entity, ScoringTarget);
      return target.ok && target.value.relayStep === step;
    });
  const total = (): number => scoringTargetEntities(query).reduce((count, entity) => {
    const target = world.get(entity, ScoringTarget);
    return target.ok && target.value.relayStep > count ? target.value.relayStep : count;
  }, 0);
  const activeTarget = (): EntityHandle | undefined => {
    const state = read();
    return state.status === 'active' ? targetForStep(state.currentStep) : undefined;
  };
  const syncVariation = (): void => {
    if (variation === undefined) return;
    variation.setVariationActive(
      variation.variationAvailable && activeTarget() === variation.variationTarget,
    );
  };
  const prepareActiveTarget = (): void => {
    const entity = activeTarget();
    if (entity === undefined) return;
    if (world.get(entity, Disabled).ok) world.removeComponent(entity, Disabled).unwrap();
    const health = world.get(entity, TargetHealth);
    if (health.ok) world.set(entity, TargetHealth, { current: health.value.max });
    const pose = world.get(entity, ResetPose);
    if (!pose.ok) return;
    const position = vec3.create(pose.value.posX, pose.value.posY, pose.value.posZ);
    world.set(entity, Transform, {
      pos: position,
      quat: [pose.value.quatX, pose.value.quatY, pose.value.quatZ, pose.value.quatW],
      scale: [pose.value.scaleX, pose.value.scaleY, pose.value.scaleZ],
    });
    if (world.hasResource('PhysicsWorld')) {
      const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
      if (physics.hasBody(entity)) physics.teleport(entity, position);
    }
  };
  const snapshot = (): TargetRelaySnapshot => {
    const state = read();
    const entity = activeTarget();
    const name = entity === undefined ? undefined : world.get(entity, Name);
    return {
      ...state,
      cleared: state.acceptedHits,
      total: total(),
      activeTarget: entity ?? null,
      activeTargetName: name?.ok === true ? name.value.value : null,
      variationActive: variation?.variationAvailable === true && entity === variation.variationTarget,
    };
  };
  const begin = (): void => {
    if (read().status !== 'locked' || total() === 0) return;
    write({ status: 'active', currentStep: 1, acceptedHits: 0, rejectedHits: 0 });
    prepareActiveTarget();
    syncVariation();
  };
  const recordHit = (entity: EntityHandle): boolean => {
    const state = read();
    if (state.status !== 'active') return false;
    if (activeTarget() !== entity) {
      write({ ...state, rejectedHits: state.rejectedHits + 1 });
      return false;
    }
    const acceptedHits = state.acceptedHits + 1;
    const complete = state.currentStep >= total();
    write({
      status: complete ? 'complete' : 'active',
      currentStep: complete ? state.currentStep : state.currentStep + 1,
      acceptedHits,
      rejectedHits: state.rejectedHits,
    });
    prepareActiveTarget();
    syncVariation();
    return true;
  };
  const reset = (): void => {
    write(initialState());
    syncVariation();
  };
  return { begin, recordHit, activeTarget, snapshot, reset };
}
