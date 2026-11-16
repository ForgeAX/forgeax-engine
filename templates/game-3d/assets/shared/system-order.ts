import { defineSystemSet } from '@forgeax/engine/ecs';

/** Stable ordering contracts shared by this owner's system implementations. */
export const Game3dPlayerInputOrder = defineSystemSet({ name: "game-3d-player-input" });
