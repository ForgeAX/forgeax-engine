// light-snapshot - feat-20260519-light-casters-point-spot-pbr
// M2 / w14 (TDD red): LightSnapshot discriminated union typecheck.
//
// AC anchor: requirements AC-03 (LightSnapshot sum-type + exhaustive switch
// application point); plan-strategy D-S1 (3) (LightSnapshot to GPU buffer
// bucket 1:1 mapping; charter P4 host pre-multiplication parity);
// plan-strategy R-10 (record-system internal consumer rewritten to three-arm
// switch in the same commit as the snapshot evolution).
//
// type-level expectations:
//   type LightSnapshot =
//     | { kind: 'directional'; direction; color; intensity }
//     | { kind: 'point';       position; color; intensity; invRangeSquared }
//     | { kind: 'spot';        position; direction; color; intensity;
//                              invRangeSquared; cosInner; cosOuter };
//
// Exhaustive switch on `kind` must typecheck without `default` branch; missing
// any variant -> tsc reports `Type 'never' is not assignable` on the
// `assertNever(s)` line. Vitest --typecheck flag picks this file up via the
// `*.test-d.ts` suffix (root vitest config K-3 unit project's typecheck pass
// covers any .test-d.ts file in any package).

import { expectTypeOf, test } from 'vitest';
import type { DirectionalShadowQuality } from '../../../render/src/components/directional-shadow-filter';
import type { LightValidationError } from '../../../render/src/components/light-helpers';
import type {
  DirectLightSlotKind,
  DirectLightSnapshot,
} from '../../../render/src/light-buffer-layout';
import type {
  DirectionalLightSnapshot,
  ExtractedLights,
  LightSnapshot,
  PointLightSnapshot,
  RectAreaDirectLightSnapshot,
  SpotLightSnapshot,
} from '../../../render/src/render-system-extract';

function assertNever(_x: never): never {
  throw new Error('exhaustive');
}

// AC-03 application point: the AI user writes a switch on `kind` and TS
// guarantees every variant is reached. assertNever in the unreachable arm
// breaks the build if a future variant lands and the switch is not extended.
function consumeSnapshot(s: LightSnapshot): number {
  switch (s.kind) {
    case 'directional':
      return s.intensity;
    case 'point':
      return s.invRangeSquared;
    case 'spot':
      return s.cosInner + s.cosOuter;
    case 'rect-area':
      return s.halfWidth + s.halfHeight;
    default:
      return assertNever(s);
  }
}

test('LightSnapshot is a discriminated union on kind', () => {
  expectTypeOf<LightSnapshot>().toEqualTypeOf<
    DirectionalLightSnapshot | PointLightSnapshot | SpotLightSnapshot | RectAreaDirectLightSnapshot
  >();
  // Smoke that the consumer compiles (run-time noop; compile-time exhaustive).
  void consumeSnapshot;
});

test('DirectionalLightSnapshot field shape', () => {
  expectTypeOf<DirectionalLightSnapshot['kind']>().toEqualTypeOf<'directional'>();
  expectTypeOf<DirectionalLightSnapshot['intensity']>().toEqualTypeOf<number>();
});

test('PointLightSnapshot field shape', () => {
  expectTypeOf<PointLightSnapshot['kind']>().toEqualTypeOf<'point'>();
  expectTypeOf<PointLightSnapshot['invRangeSquared']>().toEqualTypeOf<number>();
});

test('SpotLightSnapshot field shape', () => {
  expectTypeOf<SpotLightSnapshot['kind']>().toEqualTypeOf<'spot'>();
  expectTypeOf<SpotLightSnapshot['cosInner']>().toEqualTypeOf<number>();
  expectTypeOf<SpotLightSnapshot['cosOuter']>().toEqualTypeOf<number>();
  expectTypeOf<SpotLightSnapshot['invRangeSquared']>().toEqualTypeOf<number>();
});

test('ExtractedLights three-bucket shape', () => {
  expectTypeOf<ExtractedLights['directional']>().toEqualTypeOf<
    DirectionalLightSnapshot | undefined
  >();
  expectTypeOf<ExtractedLights['directionalCount']>().toEqualTypeOf<number>();
  expectTypeOf<ExtractedLights['point']>().toEqualTypeOf<readonly PointLightSnapshot[]>();
  expectTypeOf<ExtractedLights['spot']>().toEqualTypeOf<readonly SpotLightSnapshot[]>();
  expectTypeOf<ExtractedLights['rect']>().toEqualTypeOf<readonly RectAreaDirectLightSnapshot[]>();
});

function consumeDirectLight(snapshot: DirectLightSnapshot): number {
  switch (snapshot.kind) {
    case 'point':
      return snapshot.invRangeSquared;
    case 'spot':
      return snapshot.cosInner + snapshot.cosOuter;
    case 'rect-area':
      return snapshot.halfWidth + snapshot.halfHeight;
    default:
      return assertNever(snapshot);
  }
}

test('DirectLightSlot kind is closed and includes only finite direct lights', () => {
  expectTypeOf<DirectLightSlotKind>().toEqualTypeOf<'point' | 'spot' | 'rect-area'>();
  void consumeDirectLight;
  expectTypeOf<ExtractedLights['directionalShadowQuality']>().toEqualTypeOf<
    DirectionalShadowQuality | undefined
  >();
  expectTypeOf<ExtractedLights['directionalShadowError']>().toEqualTypeOf<
    LightValidationError | undefined
  >();
});
