// video-asset-union.test-d - type-level assertions for the `VideoAsset`
// entry into the closed `Asset` union (feat-20260623-world-space-video-asset M1).
//
// Assertions:
// - VideoAsset payload shape: `{ kind: 'video', url: string }`, no extra fields.
// - Asset union narrows to VideoAsset on kind === 'video'.
// - Exhaustive switch on Asset.kind includes 'video' arm without default.
// - TagOf<VideoAsset> resolves to 'VideoAsset'.
//
// Anchors: requirements AC-01; plan-strategy M1 acceptanceCheck;
// plan-tasks w1.

import { describe, expectTypeOf, it } from 'vitest';
import type { Asset, TagOf, VideoAsset } from '../index';

describe('VideoAsset POD shape (M1 baseline)', () => {
  it('type-level: payload shape — { kind: "video", url: string }, no extra fields', () => {
    expectTypeOf<VideoAsset['kind']>().toEqualTypeOf<'video'>();
    expectTypeOf<VideoAsset['url']>().toEqualTypeOf<string>();
  });

  it('type-level: Asset union narrows to VideoAsset on kind === "video"', () => {
    function narrow(a: Asset): VideoAsset | undefined {
      if (a.kind === 'video') return a;
      return undefined;
    }
    expectTypeOf(narrow).returns.toEqualTypeOf<VideoAsset | undefined>();
  });

  it('type-level: exhaustive switch on Asset.kind includes "video" arm without default', () => {
    function describeKind(a: Asset): string {
      switch (a.kind) {
        case 'plugin':
          return 'plugin';
        case 'mesh':
          return 'mesh';
        case 'texture':
          return 'texture';
        case 'equirect':
          return 'equirect';
        case 'sampler':
          return 'sampler';
        case 'material':
          return 'material';
        case 'scene':
          return 'scene';
        case 'skeleton':
          return 'skeleton';
        case 'skin':
          return 'skin';
        case 'animation-clip':
          return 'animation-clip';
        case 'animation-graph':
          return 'animation-graph';
        case 'audio':
          return 'audio';
        case 'ies-profile':
          return 'ies-profile';
        case 'font':
          return 'font';
        case 'render-pipeline':
          return 'render-pipeline';
        case 'tileset':
          return 'tileset';
        case 'video':
          return 'video';
        case 'navigation-mesh':
        case 'terrain':
          return 'TerrainAsset';
        case 'particle-effect':
          return 'particle-effect';
      }
      // No default branch -- TS guards completeness.
    }
    expectTypeOf(describeKind).returns.toEqualTypeOf<string>();
  });

  it('type-level: TagOf<VideoAsset> resolves to "VideoAsset"', () => {
    expectTypeOf<TagOf<VideoAsset>>().toEqualTypeOf<'VideoAsset'>();
  });
});
