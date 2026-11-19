import {
  type AssetDecoderContribution,
  type AssetKind,
  err,
  type TextureGeneratorAsset,
  validateTextureGenerator,
} from '@forgeax/engine-types';

export const textureGeneratorContribution: AssetDecoderContribution<
  TextureGeneratorAsset,
  'texture-generator'
> = {
  kind: { kind: 'texture-generator' } as AssetKind<TextureGeneratorAsset, 'texture-generator'>,
  consumer: 'Renderer GPU texture generation',
  decoder: {
    async decode({ envelope, artifacts }) {
      let value = envelope.payload;
      if (value.programs === undefined) {
        const artifact = envelope.artifacts.programs;
        if (artifact === undefined)
          return err({
            code: 'asset-package-invalid',
            expected: 'prepared GPU generator program artifact',
            hint: 'recook the generator shader closure',
            detail: { guid: envelope.guid, reason: 'missing programs' },
          });
        if (
          artifact.assetCodec?.name !== 'forgeax-texture-generator-programs' ||
          artifact.assetCodec.version !== '1'
        )
          return err({
            code: 'asset-package-invalid',
            expected: 'GPU generator programs codec version 1',
            hint: 'rebuild with a compatible generator program producer',
            detail: { guid: envelope.guid, reason: 'unsupported program codec' },
          });
        const bytes = await artifacts.read(artifact);
        if (!bytes.ok) return bytes;
        try {
          value = { ...value, programs: JSON.parse(new TextDecoder().decode(bytes.value)) };
        } catch {
          return err({
            code: 'asset-package-invalid',
            expected: 'valid prepared GPU program JSON',
            hint: 'recook the generator shader closure',
            detail: { guid: envelope.guid, reason: 'malformed programs' },
          });
        }
      }
      const valid = validateTextureGenerator(value, true);
      return valid.ok
        ? valid
        : err({
            code: 'asset-package-invalid',
            expected: valid.error.expected,
            hint: valid.error.hint,
            detail: { guid: envelope.guid, reason: valid.error.expected },
          });
    },
    prepare(value, context) {
      const valid = validateTextureGenerator(value, true);
      if (!valid.ok) return valid;
      for (const guid of Object.values(value.inputs)) {
        const texture = context.reference(guid, 'texture');
        if (!texture.ok) {
          const gpu = context.reference(guid, 'gpu-texture');
          if (gpu.ok) continue;
          const sampler = context.reference(guid, 'sampler');
          if (!sampler.ok) return sampler;
        }
      }
      return valid;
    },
  },
};
