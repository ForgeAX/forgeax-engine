import {
  type Asset,
  type AssetDecoderContribution,
  AssetError,
  type AssetKind,
  err,
  type GpuTextureAsset,
  ok,
  type Result,
  validateTextureGenerator,
} from '@forgeax/engine-types';

function invalid(expected: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: 'publish a GPU texture reference to a declared texture-generator output',
    }),
  );
}

function gpuSource(value: GpuTextureAsset): Result<GpuTextureAsset['source'], AssetError> {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.kind !== 'gpu-texture' ||
    'data' in value ||
    'encoding' in value
  )
    return invalid('a GPU texture without CPU pixel content');
  const source = value.source;
  if (
    source === null ||
    typeof source !== 'object' ||
    source.kind !== 'generated' ||
    typeof source.generator !== 'string' ||
    typeof source.output !== 'string'
  )
    return invalid('a named GPU generator output reference');
  return ok(source);
}

/** Project one independent GPU asset from its generator's sole descriptor authority. */
export function prepareGpuTextureAsset(
  value: GpuTextureAsset,
  source: (guid: string) => Asset | undefined,
): Result<GpuTextureAsset, AssetError> {
  const reference = gpuSource(value);
  if (!reference.ok) return reference;
  const generator = source(reference.value.generator);
  if (generator?.kind !== 'texture-generator')
    return invalid('a loaded texture-generator dependency');
  const valid = validateTextureGenerator(generator);
  if (!valid.ok) return valid;
  const descriptor = generator.outputs[reference.value.output];
  if (descriptor === undefined) return invalid('a declared generator output');
  return ok({ kind: 'gpu-texture', source: reference.value, ...descriptor });
}

export const gpuTextureContribution: AssetDecoderContribution<GpuTextureAsset, 'gpu-texture'> = {
  kind: { kind: 'gpu-texture' } as AssetKind<GpuTextureAsset, 'gpu-texture'>,
  consumer: 'Renderer GPU texture residency',
  decoder: {
    async decode({ envelope }) {
      const source = gpuSource(envelope.payload);
      if (!source.ok || !envelope.refs.includes(source.value.generator))
        return err({
          code: 'asset-package-invalid',
          expected: 'a GPU texture and its generator dependency',
          hint: 'recook the GPU texture reference',
          detail: { guid: envelope.guid, reason: 'invalid GPU source' },
        });
      return ok(envelope.payload);
    },
    prepare(value, context) {
      const source = gpuSource(value);
      if (!source.ok) return source;
      const handle = context.reference(source.value.generator, 'texture-generator');
      if (!handle.ok) return handle;
      const generator = context.read<
        'texture-generator',
        import('@forgeax/engine-types').TextureGeneratorAsset
      >(handle.value);
      if (!generator.ok) return generator;
      return prepareGpuTextureAsset(value, () => generator.value);
    },
  },
};
