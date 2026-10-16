import { buildMeshCardLayout, encodeMeshCardLayout } from '@forgeax/engine-geometry';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';

export interface MeshCardCookInput {
  readonly meshGuid: string;
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly resolution?: number;
  readonly maxCards?: number;
  readonly triangleSidedness?: ArrayLike<number>;
}
export interface MeshCardCookPayload {
  readonly meshGuid: string;
  readonly meshDigest: string;
  readonly artifact: 'mesh-cards.json';
}

/** Derived layout on the original mesh GUID; material capture remains a separate consumer. */
export function createMeshCardCooker(): NativeCooker<MeshCardCookPayload, MeshCardCookInput> {
  return {
    key: 'mesh-card-layout',
    async cook(input) {
      if (!input.meshGuid) throw new TypeError('card layout requires its source mesh GUID');
      const resolution = input.resolution ?? 16,
        maxCards = input.maxCards ?? 24;
      const built = await buildMeshCardLayout(input.positions, input.indices, {
        resolution,
        maxCards,
        ...(input.triangleSidedness === undefined
          ? {}
          : { triangleSidedness: input.triangleSidedness }),
      });
      if (!built.ok) throw built.error;
      const encoded = encodeMeshCardLayout(built.value);
      if (!encoded.ok) throw encoded.error;
      return {
        guid: input.meshGuid,
        payload: {
          meshGuid: input.meshGuid,
          meshDigest: built.value.meshDigest,
          artifact: 'mesh-cards.json',
        },
        refs: [],
        artifacts: { 'mesh-cards.json': { mediaType: 'application/json', bytes: encoded.value } },
        inputFingerprint: `mesh-card-layout:5:${built.value.meshDigest}:${built.value.sidednessDigest}:${resolution}:${maxCards}`,
      };
    },
  };
}
