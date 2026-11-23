import type { EntityHandle } from '@forgeax/engine-ecs';
import type { RenderFeaturePlanExecution } from './host';
import type { RenderFeaturePlannedFrame } from './plan';

/** Submission work consumed by an encoder and acknowledged only by its accepted frame/view. */
export type RenderFeatureGraphReceipt<Graph extends object = object> = {
  readonly frame: number;
  readonly generation: number;
  readonly view: EntityHandle | undefined;
  readonly plans: readonly RenderFeaturePlannedFrame[];
} & (
  | { readonly kind: 'empty' }
  | { readonly kind: 'commands'; readonly executions: readonly RenderFeaturePlanExecution[] }
  | { readonly kind: 'compiled'; readonly graph: Graph }
);
