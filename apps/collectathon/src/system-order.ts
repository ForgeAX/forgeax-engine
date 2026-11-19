import { defineSystemSet } from '@forgeax/engine-ecs';

/** Stable ordering contracts shared by this owner's system implementations. */
export const GuardianAiOrder = defineSystemSet({ name: 'guardian-ai' });
export const PlayerMoveOrder = defineSystemSet({ name: 'player-move' });
export const CoreCollectOrder = defineSystemSet({ name: 'core-collect' });
export const GuardianHitOrder = defineSystemSet({ name: 'guardian-hit' });
export const PortalActivateOrder = defineSystemSet({ name: 'portal-activate' });
