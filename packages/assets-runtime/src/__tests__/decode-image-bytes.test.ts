// @forgeax/engine-assets-runtime -- decodeImageBytes unit test skeleton
// (tweak-20260714-runtime-image-bytes-decoder-add-decodeimagebytes M1 / m1-1).
//
// Red skeleton at M1: the M1 stub throws 'not-implemented', so any behavioural
// assertion here is red until M2 fills the function body. Two forever-tests
// still hold at M1:
//   - AC-07 (a): the symbol is importable from the @forgeax/engine-assets-
//     runtime main barrel (grep-discoverable single-hop entry point).
//   - AC-07 (b): the source file leads with a `/**` TSDoc block on the
//     exported function (charter F1: single-page contract).
//
// Behavioural AC-04 / AC-08 / AC-09 arms are declared here in the exhaustive
// switch skeleton so the M1 red matches the M2 green surface without churn
// (charter P3 explicit failure -- red arms declare the target shape).

/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeImageBytes } from '../index';

const here = dirname(fileURLToPath(import.meta.url));

describe('decodeImageBytes barrel + TSDoc contract (AC-07)', () => {
  it('is exported from the @forgeax/engine-assets-runtime main barrel', () => {
    expect(typeof decodeImageBytes).toBe('function');
  });

  it('carries a leading `/**` TSDoc block on the exported function', () => {
    const src = readFileSync(join(here, '..', 'decode-image-bytes.ts'), 'utf8');
    // The exported function must be immediately preceded by a `*/` closing
    // its TSDoc block; the `/**` opener must appear before that. This is a
    // structural (not textual) check on the AI user's IDE-hover surface.
    const exportIdx = src.indexOf('export async function decodeImageBytes(');
    expect(exportIdx).toBeGreaterThan(0);
    const preface = src.slice(0, exportIdx);
    const jsdocClose = preface.lastIndexOf('*/');
    const jsdocOpen = preface.lastIndexOf('/**');
    expect(jsdocOpen).toBeGreaterThan(0);
    expect(jsdocClose).toBeGreaterThan(jsdocOpen);
  });
});

describe('decodeImageBytes structured failure surface (AC-04 / AC-08 / AC-09)', () => {
  it('AC-08: unsupported mime -> err with image-format-unsupported', async () => {
    const result = await decodeImageBytes(new Uint8Array([1]), 'image/gif');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const expected =
      "mime is one of ['image/png', 'image/jpeg', 'image/x-tga']; texture format <-> colorSpace family agrees";
    const hint =
      'supports PNG / JPG / TGA true-color sources; convert unsupported formats with: magick convert <input> <output>.png; check importSettings.colorSpace consistency with format family if formatColorSpaceConflict present';
    expect(result.error.code).toBe('image-format-unsupported');
    expect(result.error.detail).toEqual({
      code: 'image-format-unsupported',
      actualMime: 'image/gif',
    });
    expect(result.error.expected).toBe(expected);
    expect(result.error.hint).toBe(hint);
    expect(result.error.name).toBe('ImageError');
    expect(result.error.message).toBe(
      `[ImageError image-format-unsupported] expected: ${expected}; hint: ${hint}`,
    );
  });

  it('AC-09: corrupt bytes with declared mime -> err with image-decode-failed', async () => {
    // Node env has no createImageBitmap; the decoder returns the structured
    // env-missing failure through the same `image-decode-failed` arm as a
    // real decoder rejection in the browser (charter P3 explicit failure --
    // AI users switch on one arm regardless of environment).
    const result = await decodeImageBytes(new Uint8Array([0, 0, 0]), 'image/png');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('image-decode-failed');
    if (result.error.detail.code === 'image-decode-failed') {
      expect(typeof result.error.detail.reason).toBe('string');
      expect(result.error.detail.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('runtime-only bytes remain orthogonal to static pack loading', () => {
  it('keeps the bytes decoder available without accepting static catalog rows', async () => {
    const result = await decodeImageBytes(new Uint8Array([0]), 'image/gif');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('image-format-unsupported');
  });
});
