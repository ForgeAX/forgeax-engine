import type { ComponentValuesMap, LocalEntityId } from '@forgeax/engine-types';

/** Runtime-only component update used while expanding a keyed scene. */
export interface MountOverride {
  readonly localId: LocalEntityId;
  readonly comp: string;
  readonly field?: string;
  readonly value: unknown;
}

/** Numeric SceneInstance projection; never part of SceneAsset authoring/wire data. */
export interface SceneInstanceMount {
  readonly localId: LocalEntityId;
  readonly source: number | string;
  readonly memberFirst: LocalEntityId;
  readonly memberCount: number;
  readonly parent?: LocalEntityId;
  readonly components?: Partial<ComponentValuesMap>;
  readonly overrides?: readonly MountOverride[];
  readonly publicationFence?: import('@forgeax/engine-types').ScenePublicationFence;
}
