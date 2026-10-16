// pick-errors.test-d.ts — PickError code-owner and closed-union declaration guard.
//
// The guard proves the package barrel keeps the public PickErrorCode projection
// equal to the PickError.code owner, rejects an invalid literal, and remains
// exhaustively switchable without a `default` arm. Adding a member later without
// extending the switch breaks the declaration typecheck.
//
// Both closed unions the picking barrel exports are covered:
//   - PickErrorCode  — single member ('camera-component-missing'), thrown by pick().
//   - PickTileError  — two-member discriminated union (code), returned by pickTile().
//
// Charter P3 (tension): closed unions must retain zero-loss exhaustive-switch
// capability across the package boundary — this file is the compile-time proof.

// (b) external-consumer import path: the type resolves from the package barrel.
import type { PickError, PickErrorCode, PickTileError } from '@forgeax/engine-picking';
import { expectTypeOf, test } from 'vitest';

function assertNever(_x: never): never {
  throw new Error('exhaustive');
}

// PickErrorCode exhaustive switch, no default — assertNever traps a future
// member that is added without extending this switch.
function describePickErrorCode(code: PickErrorCode): string {
  switch (code) {
    case 'camera-component-missing':
      return 'camera missing';
    default:
      return assertNever(code);
  }
}

// (c) PickTileError exhaustive switch over the discriminant, no default.
function describePickTileError(err: PickTileError): string {
  switch (err.code) {
    case 'tilemap-not-found':
      return 'tilemap not found';
    case 'tilemap-component-missing':
      return 'tilemap component missing';
    default:
      return assertNever(err);
  }
}

test('PickErrorCode derives the exact closed surface from PickError', () => {
  expectTypeOf<PickErrorCode>().toEqualTypeOf<PickError['code']>();
  expectTypeOf<PickErrorCode>().toEqualTypeOf<'camera-component-missing'>();

  const acceptPickErrorCode = (code: PickErrorCode): void => {
    void code;
  };
  acceptPickErrorCode('camera-component-missing');
  // @ts-expect-error invalid codes must not be accepted.
  acceptPickErrorCode('not-a-pick-error');

  // Compile-time exhaustiveness (run-time noop).
  void describePickErrorCode;
});

test('PickTileError is the closed two-member discriminated union', () => {
  expectTypeOf<PickTileError['code']>().toEqualTypeOf<
    'tilemap-not-found' | 'tilemap-component-missing'
  >();
  void describePickTileError;
});
