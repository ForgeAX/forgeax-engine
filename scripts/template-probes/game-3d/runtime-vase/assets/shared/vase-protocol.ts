import type { EntityHandle } from '@forgeax/engine/ecs';

/** Port channel between the guide UI button and the runtime vase plugin. */
export const VASE_CHANNEL = 'game-3d/runtime-vase';

export type VaseValues = Record<'height' | 'radius' | 'sides', number>;

export interface VaseState {
  readonly busy: boolean;
  readonly guid: string;
  readonly values: VaseValues;
  readonly generation?: number;
  readonly entity?: EntityHandle;
  readonly vertexCount?: number;
  readonly aabb?: number[];
  readonly error?: string;
}
