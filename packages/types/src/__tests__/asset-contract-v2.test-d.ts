import { describe, expectTypeOf, it } from 'vitest';
import type {
  ArtifactDescriptor,
  AssetCodec,
  AssetEnvelopeV2,
  AssetPublicationTuple,
  AssetRuntimeArtifactDescriptor,
  ContentEncoding,
  Integrity,
  PackV2,
} from '../asset.js';

describe('Pack v2 asset contract', () => {
  it('keeps media type, asset codec, and outer encoding as separate facts', () => {
    expectTypeOf<ArtifactDescriptor['mediaType']>().toBeString();
    expectTypeOf<AssetCodec['name']>().toBeString();
    expectTypeOf<ContentEncoding>().toEqualTypeOf<'identity' | 'zstd'>();
    expectTypeOf<Integrity['algorithm']>().toEqualTypeOf<'sha256'>();
    expectTypeOf<ArtifactDescriptor['integrity']>().toEqualTypeOf<Integrity | undefined>();
  });

  it('uses an asset-local artifact map inside the v2 envelope', () => {
    expectTypeOf<AssetEnvelopeV2['artifacts']>().toEqualTypeOf<
      Readonly<Record<string, AssetRuntimeArtifactDescriptor>>
    >();
    expectTypeOf<PackV2['schemaVersion']>().toEqualTypeOf<'2.0.0'>();
    expectTypeOf<PackV2['assets'][number]>().toMatchTypeOf<AssetEnvelopeV2>();
  });

  it('requires the publication tuple on the runtime envelope', () => {
    expectTypeOf<AssetPublicationTuple>().toEqualTypeOf<{
      readonly scopeId: string;
      readonly generation: number;
      readonly digest: string;
      readonly outputSetDigest: string;
    }>();
    expectTypeOf<PackV2>().toMatchTypeOf<AssetPublicationTuple>();
    expectTypeOf<
      PackV2['assets'][number]['artifacts'][string]['contentEncoding']
    >().toEqualTypeOf<ContentEncoding>();
    expectTypeOf<
      PackV2['assets'][number]['artifacts'][string]['byteLength']
    >().toEqualTypeOf<number>();
    expectTypeOf<
      PackV2['assets'][number]['artifacts'][string]['integrity']
    >().toEqualTypeOf<Integrity>();
  });
});
