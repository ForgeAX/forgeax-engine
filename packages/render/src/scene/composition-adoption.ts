import type { World } from '@forgeax/engine-ecs';
import type { InstanceCollectionId } from '../instances';
import type { RenderableSnapshot } from '../render-system-extract';
import type { RenderSceneApplyResult } from './render-scene-types';

/**
 * Skin input changes one composition step observed, in step order. The
 * `skin-inputs` Render World system applies them to the entry's SkinSceneInputs
 * after `render-scene`; the entry tag drops work for a composition the step
 * itself replaced.
 */
export type SkinWork<Entry> =
  | { readonly kind: 'rows'; readonly entry: Entry; readonly delta: RenderSceneApplyResult }
  | { readonly kind: 'baseline'; readonly entry: Entry }
  | {
      readonly kind: 'joints';
      readonly entry: Entry;
      readonly worldId: number;
      readonly entities: ArrayLike<number>;
    }
  | { readonly kind: 'initialize'; readonly entry: Entry }
  | {
      readonly kind: 'published';
      readonly entry: Entry;
      readonly baseline: boolean;
      readonly retired: Iterable<number>;
      readonly rows: Iterable<number>;
      readonly entities: Uint32Array;
      readonly transforms: Float32Array;
    };

/** Instances collection acceptance a composition step observed, in step order. */
export type InstanceWork =
  | { readonly kind: 'release'; readonly world: World; readonly entityKey: number }
  | {
      readonly kind: 'accept';
      readonly world: World;
      readonly entityKey: number;
      readonly instances: NonNullable<RenderableSnapshot['instances']>;
    }
  | { readonly kind: 'retain'; readonly ids: ReadonlySet<InstanceCollectionId> };

/**
 * The adoption a composition step leaves for the `skin-inputs` and
 * `instance-collections` systems. Both lists hold O(changes) entries; a failed
 * or skipped step discards them.
 */
export class CompositionAdoptionWork<Entry> {
  skin: SkinWork<Entry>[] = [];
  instances: InstanceWork[] = [];

  clear(): void {
    this.skin = [];
    this.instances = [];
  }
}
