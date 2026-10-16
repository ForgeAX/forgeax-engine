import { readFileSync } from 'node:fs';
import type { ImportContext, ImportRunnerFs as PublicImportRunnerFs } from '@forgeax/engine-import';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ImportRunnerFs } from '../import-runner.js';

type DecodeImage = ImportContext['decodeImage'];
type RunnerDecodeImage = NonNullable<ImportRunnerFs['decodeImage']>;
type DecodeImageMime = Parameters<DecodeImage>[1];
type DecodeImageResult = Awaited<ReturnType<DecodeImage>>;

const readSource: ImportRunnerFs['readSource'] = async () => ({
  ok: true,
  value: new Uint8Array(),
});

declare const hostDecodeImage: DecodeImage;

const runnerSource = readFileSync(new URL('../import-runner.ts', import.meta.url), 'utf8');

function assertOptionalHostInjection(): void {
  const withoutHostDecoder = {
    readSource,
  } satisfies PublicImportRunnerFs;

  const withHostDecoder = {
    readSource,
    decodeImage: hostDecodeImage,
  } satisfies PublicImportRunnerFs;

  void withoutHostDecoder;
  void withHostDecoder;
}

void assertOptionalHostInjection;

describe('ImportRunnerFs decodeImage owner', () => {
  it('derives the public callback and result envelope from ImportContext', () => {
    expectTypeOf<RunnerDecodeImage>().toEqualTypeOf<DecodeImage>();
    expectTypeOf<PublicImportRunnerFs>().toEqualTypeOf<ImportRunnerFs>();
    expectTypeOf<Awaited<ReturnType<RunnerDecodeImage>>>().toEqualTypeOf<DecodeImageResult>();
  });

  it('preserves the PNG/JPEG/TGA input contract and optional host injection', () => {
    expectTypeOf<DecodeImageMime>().toEqualTypeOf<'image/png' | 'image/jpeg' | 'image/x-tga'>();
    expectTypeOf<ImportRunnerFs['decodeImage']>().toEqualTypeOf<DecodeImage | undefined>();
  });

  it('keeps both runner views derived from the authority', () => {
    expect(runnerSource).toContain("decodeImage?: ImportContext['decodeImage'];");
    expect(runnerSource).toContain("const decodeImage: ImportContext['decodeImage'] =");
    expect(runnerSource).not.toContain("mimeType: 'image/png' | 'image/jpeg'");
  });
});
