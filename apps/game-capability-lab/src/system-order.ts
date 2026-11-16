import { defineSystemSet } from '@forgeax/engine-ecs';

/** Stable ordering contracts shared by this owner's system implementations. */
export const GamePlayerMovementOrder = defineSystemSet({ name: 'game-player-movement' });
export const GameCounterattackOrder = defineSystemSet({ name: 'game-counterattack' });
export const GameEnergyCoreExtractionOrder = defineSystemSet({
  name: 'game-energy-core-extraction',
});
export const GameLookOrder = defineSystemSet({ name: 'game-look' });
export const GamePickShootOrder = defineSystemSet({ name: 'game-pick-shoot' });
export const GameProjectileSimulationOrder = defineSystemSet({
  name: 'game-projectile-simulation',
});
export const GameInputActionsOrder = defineSystemSet({ name: 'game-input-actions' });
export const GameChargeShotOrder = defineSystemSet({ name: 'game-charge-shot' });
export const GameHealthPickupCollectionOrder = defineSystemSet({
  name: 'game-health-pickup-collection',
});

export const GameRewardChoiceOrder = defineSystemSet({ name: 'game-reward-choice' });
export const GameBarrierRouteOrder = defineSystemSet({ name: 'game-barrier-route' });
export const GameTargetFeedbackOrder = defineSystemSet({ name: 'game-target-feedback' });
