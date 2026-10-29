import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSkinnedPreviewPixels, selectSkinnedPreviewAssets, SKINNED_PREVIEW_SOURCE_KEYS } from '../scripts/verify-inline-previews.mjs';

test('skinned evidence requires both characters and all six material assets', () => {
  const assets = SKINNED_PREVIEW_SOURCE_KEYS.map((sourceKey, index) => ({ sourceKey, guid: String(index) }));
  assert.deepEqual(selectSkinnedPreviewAssets(assets), assets);
  assert.throws(() => selectSkinnedPreviewAssets(assets.slice(1)), /mesh\/player/);
});

test('transparent native thumbnail evidence rejects empty, flat and opaque-background images', () => {
  const pixels = { width: 128, height: 128, covered: 2000, opaque: 2000, changed: 2000, edgePixels: 0, colors: 20 };
  assertSkinnedPreviewPixels(pixels, 'Steve', true);
  assert.throws(() => assertSkinnedPreviewPixels({ ...pixels, covered: 0 }, 'Steve', true), /empty rendered subject/);
  assert.throws(() => assertSkinnedPreviewPixels({ ...pixels, colors: 1 }, 'Steve', true), /flat rendered subject/);
  assert.throws(() => assertSkinnedPreviewPixels({ ...pixels, covered: 128 * 128 }, 'Steve', true), /transparent thumbnail background/);
  assert.throws(() => assertSkinnedPreviewPixels({ ...pixels, changed: 0, covered: 128 * 128 }, 'Steve'), /background-only preview/);
  assert.throws(() => assertSkinnedPreviewPixels({ ...pixels, edgePixels: 1 }, 'Steve'), /cropped preview subject/);
  assert.throws(() => assertSkinnedPreviewPixels(pixels, 'Steve'), /lost opaque preview background/);
});
