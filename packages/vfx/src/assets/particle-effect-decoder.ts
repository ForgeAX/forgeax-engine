import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  ok,
  type ParticleEffectAsset,
} from '@forgeax/engine-types';

export const particleEffectContribution: AssetDecoderContribution<
  ParticleEffectAsset,
  'particle-effect'
> = {
  kind: { kind: 'particle-effect' } as AssetKind<ParticleEffectAsset, 'particle-effect'>,
  consumer: 'VfxGpuRuntime',
  decoder: {
    async decode({ envelope }) {
      const payload = envelope.payload;
      if (
        payload.kind === 'particle-effect' &&
        payload.schemaVersion === 3 &&
        payload.program.format === 'forgeax-vfx-program-4' &&
        payload.emitters.length === payload.program.emitters.length &&
        payload.programFingerprint === payload.program.fingerprint
      ) {
        return ok(payload);
      }
      return err({
        code: 'asset-package-invalid',
        expected: 'a schemaVersion 3 particle payload matching its cooked program format 4',
        hint: 'cold-cook the legacy payload with the current VFX compiler and publish atomically',
        detail: { guid: envelope.guid, reason: 'particle owner validation failed' },
      });
    },
  },
};
