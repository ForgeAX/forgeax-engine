// feat-20260713-animation-state-machine-plugin M2 / w12 — AnimationGraph enters
// the closed Asset union (AC-14 foundation, type level).
//
// AC-14 (foundation): AnimationGraph joins @forgeax/engine-types' closed `Asset`
// union with `kind: 'animation-graph'` and a GUID-addressable identity (like
// AnimationClip / MaterialAsset). This test-d asserts, at compile time:
//   - the payload shape (kind discriminant + nodes + root),
//   - Asset narrows to AnimationGraph on `kind === 'animation-graph'` with NO
//     `as` assertion at a real consumption call point,
//   - an exhaustive `switch (asset.kind)` covers the new arm without default,
//   - TagOf<AnimationGraph> resolves to 'AnimationGraph' (register<T> returns
//     Handle<'AnimationGraph', 'shared'>).
//
// TDD red anchor: AnimationGraph is not in the Asset union before w13; the
// imports do not resolve and the exhaustive switch's `never` default fails to
// compile. After w13 all assertions hold.

import type { AnimationGraph, Asset, TagOf } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

describe('AnimationGraph POD in the Asset union (M2 / w12)', () => {
  it('type-level: payload shape — kind discriminant + nodes + root', () => {
    expectTypeOf<AnimationGraph['kind']>().toEqualTypeOf<'animation-graph'>();
    expectTypeOf<AnimationGraph['root']>().toEqualTypeOf<number>();
    expectTypeOf<AnimationGraph['nodes']>().toExtend<readonly unknown[]>();
  });

  it('type-level: Asset narrows to AnimationGraph on kind, no `as` assertion', () => {
    function narrow(a: Asset): AnimationGraph | undefined {
      if (a.kind === 'animation-graph') return a; // no `as` — kind discriminant narrows
      return undefined;
    }
    expectTypeOf(narrow).returns.toEqualTypeOf<AnimationGraph | undefined>();
  });

  it('type-level: exhaustive switch on Asset.kind includes the animation-graph arm', () => {
    function classify(a: Asset): string {
      switch (a.kind) {
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
        case 'font':
          return 'font';
        case 'render-pipeline':
          return 'render-pipeline';
        case 'tileset':
          return 'tileset';
        case 'video':
          return 'video';
        case 'particle-effect':
          return 'particle-effect';
        case 'ies-profile':
          return 'ies-profile';
        case 'plugin':
          return 'plugin';
        case 'terrain':
          return 'terrain';
        case 'navigation-mesh':
          return 'navigation-mesh';
        default: {
          const _exhaustive: never = a;
          return _exhaustive;
        }
      }
    }
    expectTypeOf(classify).returns.toEqualTypeOf<string>();
  });

  it('type-level: TagOf<AnimationGraph> resolves to "AnimationGraph"', () => {
    expectTypeOf<TagOf<AnimationGraph>>().toEqualTypeOf<'AnimationGraph'>();
  });
});
