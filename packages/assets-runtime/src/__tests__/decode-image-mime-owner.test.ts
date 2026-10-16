/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { decodeImageBytes } from '../index';

type ExpectedSupportedMime = 'image/png' | 'image/jpeg';
type PublicMime = Parameters<typeof decodeImageBytes>[1];

const decoderSource = readFileSync(new URL('../decode-image-bytes.ts', import.meta.url), 'utf8');

describe('decodeImageBytes supported MIME owner', () => {
  it('keeps the supported MIME vocabulary and public boundary exact', () => {
    expectTypeOf<ExpectedSupportedMime>().toEqualTypeOf<'image/png' | 'image/jpeg'>();
    expectTypeOf<PublicMime>().toEqualTypeOf<string>();
    expectTypeOf<string>().toEqualTypeOf<PublicMime>();

    const acceptsSupportedMime = (mime: ExpectedSupportedMime): ExpectedSupportedMime => mime;
    acceptsSupportedMime('image/png');
    acceptsSupportedMime('image/jpeg');
    // @ts-expect-error Unsupported MIME values remain outside the private vocabulary.
    acceptsSupportedMime('image/gif');
  });

  it('derives the private type guard from one readonly MIME owner', () => {
    expect(decoderSource).toContain(
      "const SUPPORTED_MIMES = ['image/png', 'image/jpeg'] as const;",
    );
    expect(decoderSource).toContain('type SupportedMime = (typeof SUPPORTED_MIMES)[number];');
    expect(decoderSource).toContain(
      'function isSupportedMime(mime: string): mime is SupportedMime',
    );
    expect(decoderSource).toContain(
      'return SUPPORTED_MIMES.some((supportedMime) => supportedMime === mime);',
    );
    expect(decoderSource).not.toContain("return mime === 'image/png' || mime === 'image/jpeg';");
  });
});
