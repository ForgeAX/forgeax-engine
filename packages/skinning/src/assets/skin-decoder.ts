import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
  parseShadowCapsuleSet,
  type SkeletonAsset,
  type SkinAsset,
} from '@forgeax/engine-types';

function floatArray(value: unknown): Float32Array | undefined {
  if (value instanceof Float32Array) return value.every(Number.isFinite) ? value : undefined;
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    const result = Float32Array.from(value);
    return result.every(Number.isFinite) ? result : undefined;
  }
  return undefined;
}

export const skinContribution: AssetDecoderContribution<SkinAsset, 'skin'> = {
  kind: { kind: 'skin' } as AssetKind<SkinAsset, 'skin'>,
  consumer: 'resolveSkinJoints',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload;
      if (
        payload !== null &&
        typeof payload === 'object' &&
        payload.kind === 'skin' &&
        typeof payload.skeletonGuid === 'string' &&
        payload.skeletonGuid.length > 0 &&
        Array.isArray(payload.jointPaths) &&
        payload.jointPaths.every((path) => typeof path === 'string')
      ) {
        return ok(payload);
      }
      return err({
        code: 'asset-package-invalid',
        expected: 'a skin payload with a skeleton GUID and joint paths',
        hint: 'recook the skin binding and publish its skeleton reference',
        detail: { guid: envelope.guid, reason: 'skin owner validation failed' },
      });
    },
  },
};

export const skeletonContribution: AssetDecoderContribution<SkeletonAsset, 'skeleton'> = {
  kind: { kind: 'skeleton' } as AssetKind<SkeletonAsset, 'skeleton'>,
  consumer: 'resolveSkinJoints',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload as unknown;
      if (payload !== null && typeof payload === 'object') {
        const source = payload as Record<string, unknown>;
        const inverseBindMatrices = floatArray(source.inverseBindMatrices);
        const bounds = floatArray(source.bounds);
        const jointCount = source.jointCount;
        const shadowCapsules =
          source.shadowCapsules === undefined || !Number.isSafeInteger(jointCount)
            ? undefined
            : parseShadowCapsuleSet(source.shadowCapsules, jointCount as number);
        if (
          source.kind === 'skeleton' &&
          inverseBindMatrices !== undefined &&
          Number.isSafeInteger(jointCount) &&
          (jointCount as number) >= 0 &&
          inverseBindMatrices.length === (jointCount as number) * 16 &&
          (source.bounds === undefined || (bounds !== undefined && bounds.length === 6)) &&
          (source.shadowCapsules === undefined || shadowCapsules !== undefined)
        ) {
          return ok({
            kind: 'skeleton',
            inverseBindMatrices,
            jointCount: jointCount as number,
            ...(bounds === undefined ? {} : { bounds }),
            ...(shadowCapsules === undefined ? {} : { shadowCapsules }),
          });
        }
      }
      return err({
        code: 'asset-package-invalid',
        expected: 'a skeleton payload with one inverse-bind matrix per joint',
        hint: 'recook the skeleton and publish its complete joint data',
        detail: { guid: envelope.guid, reason: 'skeleton owner validation failed' },
      });
    },
  },
};
