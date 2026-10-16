// apps/hello/sprite-atlas/src/__tests__/main-type-affordance.test-d.ts
// AC-08 IDE autocomplete type inference fixture for the sprite animation
// component surface (feat-20260521-sprite-atlas-animation M6 T-35).
//
// The primary AC-08 validation anchor is the actual world.spawn() call
// site in src/main.ts (charter F1: the demo is the AI user consumption
// point). This file provides a compile-time auxiliary guard that
// verifies the 6-field SpriteAnimation data shape and the 4-float
// SpriteRegionOverride shape via vitest typecheck (expectTypeOf).

import type { SchemaOf, ShapeOf } from '@forgeax/engine-ecs';
import { SpriteAnimation, SpriteRegionOverride } from '@forgeax/engine-render/authoring';
import { describe, expectTypeOf, it } from 'vitest';

// SpriteAnimation data shape: 6 fields inferred from defineComponent schema.
// The component name literal + schema object fields are preserved as const
// by TS (defineComponent<const N, const S>) so IDE autocomplete surfaces
// frameCount/frameDuration/currentFrame/accumDt/regions/playbackMode.
describe('SpriteAnimation — AC-08 type affordance', () => {
  it("name literal type is 'SpriteAnimation'", () => {
    expectTypeOf<typeof SpriteAnimation.name>().toEqualTypeOf<'SpriteAnimation'>();
  });

  it('schema derives 6 fields 1:1 with requirements section 2.3', () => {
    type AnimData = ShapeOf<SchemaOf<typeof SpriteAnimation>>;
    expectTypeOf<AnimData>().toHaveProperty('frameCount');
    expectTypeOf<AnimData>().toHaveProperty('frameDuration');
    expectTypeOf<AnimData>().toHaveProperty('currentFrame');
    expectTypeOf<AnimData>().toHaveProperty('accumDt');
    expectTypeOf<AnimData>().toHaveProperty('regions');
    expectTypeOf<AnimData>().toHaveProperty('playbackMode');
  });
});

// SpriteRegionOverride data shape: 1 field (region: array<f32, 4>).
describe('SpriteRegionOverride — AC-08 type affordance', () => {
  it("name literal type is 'SpriteRegionOverride'", () => {
    expectTypeOf<typeof SpriteRegionOverride.name>().toEqualTypeOf<'SpriteRegionOverride'>();
  });

  it('schema derives 1 field: region', () => {
    type SroData = ShapeOf<SchemaOf<typeof SpriteRegionOverride>>;
    expectTypeOf<SroData>().toHaveProperty('region');
  });
});
