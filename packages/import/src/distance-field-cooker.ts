import {
  buildMeshDistanceField,
  buildVisibilityDistanceField,
  type DistanceFieldPolicy,
  encodeMeshDistanceField,
  MESH_DISTANCE_FIELD_GENERATION_VERSION,
} from '@forgeax/engine-geometry';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';

export type DistanceFieldCookInput = {
  readonly meshGuid: string;
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
} & (
  | { readonly policy?: 'geometric'; readonly resolution?: number; readonly twoSided?: boolean }
  | {
      readonly policy: 'sampled-visibility';
      readonly voxelSize: number;
      readonly triangleSidedness: ArrayLike<number>;
    }
);
export interface DistanceFieldCookPayload {
  readonly meshGuid: string;
  readonly meshDigest: string;
  readonly policy: DistanceFieldPolicy['kind'];
  readonly artifact: 'distance-field.bin';
}
/** Explicit derived-data operation on an existing mesh GUID, registered by its build owner. */
export function createMeshDistanceFieldCooker(): NativeCooker<
  DistanceFieldCookPayload,
  DistanceFieldCookInput
> {
  return {
    key: 'mesh-distance-field',
    async cook(input) {
      if (!input.meshGuid) throw new TypeError('distance field requires its source mesh GUID');
      if (
        input.policy !== undefined &&
        input.policy !== 'geometric' &&
        input.policy !== 'sampled-visibility'
      )
        throw new TypeError('unknown distance-field cook policy');
      const built =
        input.policy === 'sampled-visibility'
          ? await buildVisibilityDistanceField(input.positions, input.indices, input)
          : await buildMeshDistanceField(input.positions, input.indices, input);
      if (!built.ok) throw new TypeError(built.error.detail.reason);
      const encoded = await encodeMeshDistanceField(built.value);
      if (!encoded.ok) throw new TypeError(encoded.error.detail.reason);
      return {
        guid: input.meshGuid,
        payload: {
          meshGuid: input.meshGuid,
          meshDigest: built.value.meshDigest,
          policy: built.value.policy.kind,
          artifact: 'distance-field.bin',
        },
        refs: [],
        artifacts: {
          'distance-field.bin': { mediaType: 'application/octet-stream', bytes: encoded.value },
        },
        inputFingerprint: `mesh-distance-field:${MESH_DISTANCE_FIELD_GENERATION_VERSION}:${built.value.meshDigest}:${built.value.spacing}:${JSON.stringify(built.value.policy)}`,
      };
    },
  };
}
