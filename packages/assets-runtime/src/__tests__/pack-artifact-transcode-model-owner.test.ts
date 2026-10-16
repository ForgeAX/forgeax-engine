/// <reference types="node" />

import { readFileSync } from 'node:fs';
import type { TranscodeModel } from '@forgeax/engine-codec';
import type { Loader } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { textureLoader } from '../loaders/pack-artifact.js';

const packArtifactSource = readFileSync(
  new URL('../loaders/pack-artifact.ts', import.meta.url),
  'utf8',
);

describe('assets-runtime transcode model owner', () => {
  it('keeps the public texture loader and model vocabulary intact', () => {
    expectTypeOf<typeof textureLoader>().toEqualTypeOf<Loader>();
    expectTypeOf<TranscodeModel>().toEqualTypeOf<'etc1s' | 'uastc-ldr' | 'uastc-hdr'>();

    const models: readonly TranscodeModel[] = ['etc1s', 'uastc-ldr', 'uastc-hdr'];
    expect(models).toEqual(['etc1s', 'uastc-ldr', 'uastc-hdr']);
  });

  it('derives the private model view from the codec owner', () => {
    expect(packArtifactSource).toContain('import type { CodecError, TranscodeModel }');
    expect(packArtifactSource).toContain('selectTranscodeTarget,');
    expect(packArtifactSource).toContain('transcodeKtx2,');
    expect(packArtifactSource).not.toContain("await import('@forgeax/engine-codec')");
    expect(packArtifactSource).not.toContain('codec.module.import');
    expect(packArtifactSource).toContain(
      'function transcodeModel(profile: string): TranscodeModel | undefined',
    );
    expect(packArtifactSource).not.toContain(
      "function transcodeModel(profile: string): 'etc1s' | 'uastc-ldr' | 'uastc-hdr' | undefined",
    );
  });
});
