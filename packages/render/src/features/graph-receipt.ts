import type { EntityHandle } from '@forgeax/engine-ecs';
import type { RenderFeaturePlannedFrame } from './plan';

/** Compiler provenance consumed by an encoder and acknowledged only by its accepted frame/view. */
export type RenderFeatureGraphReceipt<Graph extends object = object> = {
  readonly frame: number;
  readonly generation: number;
  readonly view: EntityHandle | undefined;
  readonly plans: readonly RenderFeaturePlannedFrame[];
} & ({ readonly kind: 'empty' } | { readonly kind: 'compiled'; readonly graph: Graph });
