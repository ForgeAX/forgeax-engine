// Pure-function shelf packer for the `forgeax asset atlas`
// subcommand (feat-20260521-sprite-atlas-animation M5' T-31). Maps a list
// of decoded RGBA sprites to a non-overlapping atlas region map +
// atlasWidth / atlasHeight envelope.
//
// Why pure-fn (plan-strategy section 2 D-4):
//   - sidecar (`<name>.atlas.meta.json`) addresses regions by source name,
//     so the on-disk contract is stable under algorithm swaps. Future feats
//     can replace shelfPack with MaxRects / rectpack2D without breaking
//     downstream consumers (charter P5 producer/consumer split).
//   - the caller (runAtlas) owns disk IO + decode; this file owns only the
//     geometric layout decision so unit tests do not need filesystem state.
//
// Algorithm (research F-1 Godot chart_pack shelf precedent, ~80 LOC MVP):
//   1. Validate: empty input -> 'atlas-empty-input'; any single image
//      width/height > maxAtlasSize -> 'atlas-size-exceeded' (caller cannot
//      recover by repacking, so we fail-fast before the inner loop).
//   2. Sort by height descending (standard shelf optimisation -- tall
//      sprites on the bottom shelves keep gaps small); break ties by name
//      so layouts are deterministic across runs (helps reproducible builds
//      + cross-platform CI parity).
//   3. Pick a target shelf width by `nextPow2(ceil(sqrt(totalArea)))` so
//      the first shelf width is roughly square; clamp to maxAtlasSize and
//      widen if any single image exceeds the initial guess.
//   4. Walk left-to-right; start a new shelf when the cursor would overflow
//      the target width. New shelves stack downward; bail out with
//      'atlas-size-exceeded' if a placement would push past maxAtlasSize.
//   5. atlasHeight = nextPow2(usedHeight) clamped to maxAtlasSize so the
//      output dimensions are GPU-friendly (most sprite atlases live happily
//      inside power-of-two limits even when WebGPU lifts the requirement).

import type { ImageErrorCode } from '@forgeax/engine-types';

/**
 * Decoded image input for shelfPack. `pixels` length must equal
 * `width * height * 4` (RGBA8); the field is carried so the caller can
 * blit into the atlas buffer without re-decoding inside this module.
 */
export interface AtlasImageInput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/**
 * One placed sprite inside the packed atlas. `(x, y)` is the top-left
 * corner in pixel coordinates; `(w, h)` mirrors the source dimensions.
 */
export interface AtlasRegion {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ShelfPackResult {
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly regions: ReadonlyArray<AtlasRegion>;
}

/**
 * Detail shape used by both `atlas-empty-input` and `atlas-size-exceeded`
 * branches. Fields are optional because the two codes carry different
 * subsets; the caller projects each branch onto the matching
 * `ImageErrorDetail` variant before emitting the structured error.
 */
export interface ShelfPackError {
  readonly code: Extract<ImageErrorCode, 'atlas-empty-input' | 'atlas-size-exceeded'>;
  readonly detail: {
    readonly name?: string;
    readonly width?: number;
    readonly height?: number;
    readonly maxAtlasSize?: number;
    readonly receivedCount?: number;
  };
}

export type ShelfPackOutcome =
  | { readonly ok: true; readonly value: ShelfPackResult }
  | { readonly ok: false; readonly error: ShelfPackError };

function sizeExceeded(
  image: AtlasImageInput,
  maxAtlasSize: number,
): { readonly ok: false; readonly error: ShelfPackError } {
  return {
    ok: false,
    error: {
      code: 'atlas-size-exceeded',
      detail: {
        name: image.name,
        width: image.width,
        height: image.height,
        maxAtlasSize,
      },
    },
  };
}

function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function shelfPack(
  images: ReadonlyArray<AtlasImageInput>,
  opts: { readonly maxAtlasSize: number },
): ShelfPackOutcome {
  const { maxAtlasSize } = opts;

  if (images.length === 0) {
    return {
      ok: false,
      error: { code: 'atlas-empty-input', detail: { receivedCount: 0 } },
    };
  }

  for (const img of images) {
    if (img.width > maxAtlasSize || img.height > maxAtlasSize) {
      return sizeExceeded(img, maxAtlasSize);
    }
  }

  const sorted = [...images].sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  let totalArea = 0;
  let maxImageWidth = 0;
  for (const img of sorted) {
    totalArea += img.width * img.height;
    if (img.width > maxImageWidth) maxImageWidth = img.width;
  }
  let targetWidth = nextPow2(Math.ceil(Math.sqrt(totalArea)));
  if (maxImageWidth > targetWidth) targetWidth = nextPow2(maxImageWidth);
  if (targetWidth > maxAtlasSize) targetWidth = maxAtlasSize;

  const regions: AtlasRegion[] = [];
  let cursorX = 0;
  let cursorY = 0;
  const firstHeight = sorted[0]?.height ?? 0;
  let currentShelfHeight = firstHeight;
  let usedWidth = 0;

  for (const img of sorted) {
    if (cursorX + img.width > targetWidth && cursorX !== 0) {
      cursorY += currentShelfHeight;
      cursorX = 0;
      currentShelfHeight = img.height;
    }
    if (cursorY + img.height > maxAtlasSize) {
      return sizeExceeded(img, maxAtlasSize);
    }
    regions.push({ name: img.name, x: cursorX, y: cursorY, w: img.width, h: img.height });
    cursorX += img.width;
    if (cursorX > usedWidth) usedWidth = cursorX;
  }

  const usedHeight = cursorY + currentShelfHeight;
  let atlasWidth = nextPow2(usedWidth);
  if (atlasWidth > maxAtlasSize) atlasWidth = maxAtlasSize;
  let atlasHeight = nextPow2(usedHeight);
  if (atlasHeight > maxAtlasSize) atlasHeight = maxAtlasSize;

  return { ok: true, value: { atlasWidth, atlasHeight, regions } };
}
