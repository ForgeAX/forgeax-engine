// feat-20260521-sprite-atlas-animation / M2 / T-09.
//
// TDD red phase: packages/runtime/src/components/sprite-animation.ts does
// not yet exist; this test-d stays red (TS module-resolution failure)
// until T-12 lands the SSOT (plan-strategy section 2 D-5 + D-6 + section
// 3.1 SAC node). After T-12 the import resolves and the type-level
// assertions turn green. AC-02 schema lock + AC-08 IDE-autocomplete
// affordance are the consumer-side guarantees these checks defend.
//
// Schema decision lineage (six fields locked, 1:1 with requirements
// section 2.3 table):
//   1. frameCount    : 'u32'         total frame count, >= 1.
//   2. frameDuration : 'f32'         per-frame seconds, > 0.
//   3. currentFrame  : 'u32'         live frame index, runtime mutable.
//   4. accumDt       : 'f32'         dt accumulator, persists across ticks.
//   5. regions       : 'array<f32>'  flat [uMin, vMin, uW, vH] per frame
//                                     (length = frameCount * 4 invariant
//                                      enforced by the M4 tick system).
//   6. playbackMode  : 'u32'         numeric encoding of SpritePlaybackMode
//                                     (SPRITE_PLAYBACK_MODE_LOOP=0 /
//                                      SPRITE_PLAYBACK_MODE_CLAMP=1; M1 SSOT
//                                      sprite-playback-mode.ts; D-5).
//
// Why u32 for playbackMode (and not a string-literal union)? research F-2
// + F-5: the ECS schema whitelist (`SchemaFieldType`) is closed and rejects
// string-literal unions; the M1 Tonemap path (`tonemap: f32` +
// TONEMAP_NONE/TONEMAP_REINHARD_EXTENDED constants + `tonemapFromF32`
// mapper) is the SSOT shape this feat reuses (D-5 same charter P4 mental
// model — one encoding rule across all closed-union schema columns).
//
// Why array<f32> (and not array<f32, N>) for `regions`? The length
// `frameCount * 4` is a runtime value (frameCount itself is a column read
// per entity); the variable-capacity `array<f32>` mirrors `Instances.transforms`
// (M1 feat-20260514) where the runtime length is also data-dependent. The
// length invariant is enforced by the M4 sprite-animation-tick system at
// first observation (AC-09 fail-fast path; D-1 + D-6).
//
// Anchors: plan-tasks.json T-09 (acceptanceCheck: vitest --typecheck on
// sprite-animation.test-d turns green after T-12, six fields 1:1 with
// requirements section 2.3); plan-strategy section 2 D-5 + D-6 + section
// 3.1 PR/SAC + section 4 risks R-SCHEMA-1 + R-SCHEMA-2; research F-2 + F-5;
// requirements section AC-02 + section 2.3 field semantics table; charter
// F1 (single-import surface), P3 (schema fail-fast at TS edge), P4
// (consistent abstraction with M1 Tonemap encoding).

import type { Component, SchemaOf, ShapeOf } from '@forgeax/engine-ecs';
import type { SpriteAnimation } from '@forgeax/engine-render/authoring';
import { describe, expectTypeOf, it } from 'vitest';
import {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
} from '../../../../render/src/components/sprite-playback-mode';

describe('SpriteAnimation — Component token shape (AC-02 schema lock)', () => {
  it("name literal type is 'SpriteAnimation'", () => {
    expectTypeOf<typeof SpriteAnimation.name>().toEqualTypeOf<'SpriteAnimation'>();
  });

  it('schema is exactly the 6-field record from requirements section 2.3', () => {
    expectTypeOf<SchemaOf<typeof SpriteAnimation>>().toEqualTypeOf<
      Readonly<{
        readonly frameCount: 'u32';
        readonly frameDuration: 'f32';
        readonly currentFrame: 'u32';
        readonly accumDt: 'f32';
        readonly regions: 'array<f32>';
        readonly playbackMode: 'u32';
      }>
    >();
  });

  it('SpriteAnimation matches Component<"SpriteAnimation", {6 fields}>', () => {
    type Expected = Component<
      'SpriteAnimation',
      {
        readonly frameCount: 'u32';
        readonly frameDuration: 'f32';
        readonly currentFrame: 'u32';
        readonly accumDt: 'f32';
        readonly regions: 'array<f32>';
        readonly playbackMode: 'u32';
      }
    >;
    expectTypeOf<typeof SpriteAnimation>().toMatchTypeOf<Expected>();
  });

  it('schema field literals narrow to their exact tier-2 vocab keywords', () => {
    expectTypeOf<SchemaOf<typeof SpriteAnimation>['frameCount']>().toEqualTypeOf<'u32'>();
    expectTypeOf<SchemaOf<typeof SpriteAnimation>['frameDuration']>().toEqualTypeOf<'f32'>();
    expectTypeOf<SchemaOf<typeof SpriteAnimation>['currentFrame']>().toEqualTypeOf<'u32'>();
    expectTypeOf<SchemaOf<typeof SpriteAnimation>['accumDt']>().toEqualTypeOf<'f32'>();
    expectTypeOf<SchemaOf<typeof SpriteAnimation>['regions']>().toEqualTypeOf<'array<f32>'>();
    expectTypeOf<SchemaOf<typeof SpriteAnimation>['playbackMode']>().toEqualTypeOf<'u32'>();
  });
});

describe('SpriteAnimation — data shape via ShapeOf (AC-02 + AC-08)', () => {
  it('ShapeOf<schema> exposes 6 fields with the documented JS types', () => {
    type Data = ShapeOf<SchemaOf<typeof SpriteAnimation>>;
    expectTypeOf<keyof Data>().toEqualTypeOf<
      'frameCount' | 'frameDuration' | 'currentFrame' | 'accumDt' | 'regions' | 'playbackMode'
    >();
    expectTypeOf<Data['frameCount']>().toEqualTypeOf<number>();
    expectTypeOf<Data['frameDuration']>().toEqualTypeOf<number>();
    expectTypeOf<Data['currentFrame']>().toEqualTypeOf<number>();
    expectTypeOf<Data['accumDt']>().toEqualTypeOf<number>();
    expectTypeOf<Data['regions']>().toEqualTypeOf<Float32Array>();
    expectTypeOf<Data['playbackMode']>().toEqualTypeOf<number>();
  });

  it('world.spawn data is Partial<ShapeOf<schema>> — every field optional at consumer', () => {
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof SpriteAnimation>>>;

    // Empty payload type-checks (consumer surface accepts omission).
    const empty: SpawnData = {};
    void empty;

    // Full payload — playback-mode constant flows in via SPRITE_PLAYBACK_MODE_*
    // numeric literal (T-07 SSOT). AI users grep `SPRITE_PLAYBACK_MODE_LOOP`
    // and find one symbol with one numeric encoding; charter F1 single-symbol
    // discovery.
    const full: SpawnData = {
      frameCount: 4,
      frameDuration: 0.1,
      currentFrame: 0,
      accumDt: 0,
      regions: new Float32Array(4 * 4),
      playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
    };
    void full;

    const clampMode: SpawnData = { playbackMode: SPRITE_PLAYBACK_MODE_CLAMP };
    void clampMode;
  });
});

describe('SpriteAnimation — @ts-expect-error negative assertions (AC-08)', () => {
  it('1. plain number[] is not assignable to data.regions (Float32Array nominal)', () => {
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof SpriteAnimation>>>;
    // @ts-expect-error number[] lacks the Float32Array brand.
    const wrong: SpawnData = { regions: [0, 0, 1, 1] };
    void wrong;
  });

  it("2. string-literal 'loop' is not assignable to data.playbackMode (numeric u32)", () => {
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof SpriteAnimation>>>;
    // @ts-expect-error playbackMode is a u32 numeric column (D-5);
    // string-literal 'loop' is the type-level alias only — runtime
    // narrowing flows through `spritePlaybackModeFromU32`.
    const wrong: SpawnData = { playbackMode: 'loop' };
    void wrong;
  });

  it('3. mismatched scalar field types are TS errors', () => {
    type SpawnData = Partial<ShapeOf<SchemaOf<typeof SpriteAnimation>>>;
    // @ts-expect-error frameCount is `number`; assigning a string is a TS error.
    const wrong: SpawnData = { frameCount: '4' };
    void wrong;
  });
});
