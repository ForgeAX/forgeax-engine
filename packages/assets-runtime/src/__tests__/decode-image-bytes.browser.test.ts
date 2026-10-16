// @forgeax/engine-assets-runtime -- decodeImageBytes browser e2e test
// (tweak-20260714-runtime-image-bytes-decoder-add-decodeimagebytes M3 / m3-1).
//
// Runs under the vitest browser project (chromium + real createImageBitmap +
// OffscreenCanvas 2D). Anchors the end-to-end "bytes -> POD -> world column
// handle" happy path that the Node-side unit test cannot exercise (Node has
// no createImageBitmap; unit test only covers the structured-failure arms).
//
// Coverage:
//   - AC-01: real PNG bytes -> ok(TextureAsset) with all POD fields populated
//     (kind / width / height / format / data / colorSpace / mipmap /
//     mipLevelCount); default (opts omitted) drives srgb + mipmap=true, and a
//     second run with opts.colorSpace='linear' + opts.mipmap=false confirms
//     the two POD fields the opts derive (format + mipLevelCount).
//   - AC-02: the returned POD is accepted by `world.allocSharedRef(
//     'TextureAsset', pod)` -- the SSOT runtime column-handle path (charter
//     P4 consistent abstraction: the same POD any static loader would
//     produce). The handle is a live u32 whose resolve returns payload
//     identity (structural equivalence, not deep-copy).
//   - AC-03 (regression): running this file alongside the existing browser
//     project confirms the pre-existing static loader path is unaffected
//     (checked by the M3 boundary sweep `pnpm test:browser`, no new arms
//     added here).
//
// Fixture: 1x1 red PNG inlined as base64 (67 bytes) -- keeps the whole
// contract self-contained in this one file so an AI user grep-discovering
// the test does not need to chase a binary fixture (charter F1 single-page).

import { World } from '@forgeax/engine-ecs';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { decodeImageBytes } from '../decode-image-bytes';

// 1x1 red PNG (RGBA 8-bit). Universally decodable by browser createImageBitmap.
const PNG_1X1_RED_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function pngBytes(): Uint8Array {
  const bin = atob(PNG_1X1_RED_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

describe('decodeImageBytes browser real-PNG happy path (AC-01)', () => {
  it('AC-01: real PNG bytes -> ok(TextureAsset) with all POD fields populated (default srgb + mipmap)', async () => {
    const result = await decodeImageBytes(pngBytes(), 'image/png');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pod = result.value;
    expect(pod.kind).toBe('texture');
    expect(pod.shape.extent.width).toBeGreaterThan(0);
    expect(pod.shape.extent.height).toBeGreaterThan(0);
    // RGBA8 tight-packed: width * height * 4 bytes.
    expect(pod.data.length).toBe(pod.shape.extent.width * pod.shape.extent.height * 4);
    expect(pod.format).toBe('rgba8unorm-srgb');
    expect(pod.colorSpace).toBe('srgb');
    expect(pod.mips).toEqual({ kind: 'generate' });
  });

  it('AC-01: opts.colorSpace="linear" + opts.mipmap=false narrows format + mipLevelCount', async () => {
    const result = await decodeImageBytes(pngBytes(), 'image/png', {
      colorSpace: 'linear',
      mipmap: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pod = result.value;
    expect(pod.format).toBe('rgba8unorm');
    expect(pod.colorSpace).toBe('linear');
    expect(pod.mips).toEqual({ kind: 'none' });
  });
});

describe('decodeImageBytes browser structural equivalence with static loader path (AC-02)', () => {
  it('AC-02: POD is accepted by world.allocSharedRef and resolves back to the same identity', async () => {
    const result = await decodeImageBytes(pngBytes(), 'image/png');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pod = result.value;

    const world = new World();
    const handle = world.allocSharedRef<'TextureAsset', TextureAsset>('TextureAsset', pod);
    // Handle is a branded u32 -- must be a finite non-negative integer.
    expect(typeof handle).toBe('number');
    expect(Number.isFinite(handle as unknown as number)).toBe(true);
    expect(handle as unknown as number).toBeGreaterThan(0);

    // Structural equivalence: the shared-ref store round-trips the SAME POD
    // reference (identity preserved, no deep-copy) -- what any static
    // texture loader path produces after allocSharedRef.
    const resolved = world.sharedRefs.resolve<'TextureAsset', TextureAsset>(handle);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toBe(pod);
    expect(resolved.value.kind).toBe('texture');
    expect(resolved.value.format).toBe('rgba8unorm-srgb');
  });
});
