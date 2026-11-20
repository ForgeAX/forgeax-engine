import type { Component } from '@forgeax/engine-ecs';
import type { meshAssetContribution } from '@forgeax/engine-geometry';
import type { textureContribution } from '@forgeax/engine-image';
import type { RuntimePackProducer } from '@forgeax/engine-import';
import type { materialContribution } from '@forgeax/engine-render';
import type { sceneAssetContribution } from '@forgeax/engine-scene';

export const levelComponents: readonly Component[];
export const levelDecoders: readonly [
  typeof meshAssetContribution,
  typeof textureContribution,
  typeof materialContribution,
  typeof sceneAssetContribution,
];
export function createLevelStreamingPack(
  profile: {
    readonly streetBlock: {
      readonly meshEntities: number;
      readonly meshAssets: number;
      readonly materialAssets: number;
      readonly textureAssets: number;
      readonly textureExtent: readonly number[];
      readonly maskedEntities: number;
      readonly nestedInstances: number;
      readonly hierarchyDepth: number;
      readonly colliders: Readonly<Record<string, number>>;
      readonly alternateInstancesCase?: {
        readonly groups: number;
        readonly instancesPerGroup: number;
      };
    };
  },
  options?: { readonly withInstances?: boolean },
): Promise<{
  readonly producer: RuntimePackProducer;
  readonly rootGuid: string;
  readonly guids: readonly string[];
  readonly facts: {
    readonly workloadCase: 'street-block' | 'street-block-plus-instances';
    readonly instanceGroups: number;
    readonly instancesPerGroup: number;
    readonly outputs: number;
    readonly binaryArtifacts: number;
    readonly textureBytes: number;
    readonly production: string;
  };
}>;
