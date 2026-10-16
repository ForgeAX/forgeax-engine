// input-snapshot.test-d.ts -- compile-time assertions for AC-07.
//
// Anchors:
// - mouse.button(i) accepts the literal union 0 | 1 | 2 (W3C MouseEvent.button:
//   0=primary, 1=auxiliary, 2=secondary; plan-strategy section 2.10 D-5).
// - mouse.button(3) is a TS error (literal-narrowing rejects out-of-range).
// - keyboard.down/justPressed/up plus physical-code readers return boolean
//   (not unknown / not Result).
//
// charter awareness:
// - F2 minimal surface: keyboard read points are locked at compile time
// - P3 explicit failure: invalid button index is a compile-time error,
//   not a silent runtime fallback (no string parsing, no number coercion)

import { describe, expectTypeOf, it } from 'vitest';
import { createInputSnapshot, type InputSnapshot } from '../index';

describe('InputSnapshot type surface (AC-07)', () => {
  it('keyboard.down accepts string and returns boolean', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.keyboard.down).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(snap.keyboard.down('w')).toEqualTypeOf<boolean>();
  });

  it('keyboard.up accepts string and returns boolean', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.keyboard.up).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(snap.keyboard.up('w')).toEqualTypeOf<boolean>();
  });

  it('keyboard.justPressed accepts string and returns boolean', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.keyboard.justPressed).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(snap.keyboard.justPressed('w')).toEqualTypeOf<boolean>();
  });

  it('keyboard code readers accept string and return boolean', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.keyboard.downCode).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(snap.keyboard.justPressedCode).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(snap.keyboard.upCode).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(snap.keyboard.downCode('KeyA')).toEqualTypeOf<boolean>();
  });

  it('mouse.movementDelta has shape { x: number; y: number }', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.mouse.movementDelta).toEqualTypeOf<{
      readonly x: number;
      readonly y: number;
    }>();
  });

  it('mouse.position has shape { x: number; y: number }', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.mouse.position).toEqualTypeOf<
      { readonly x: number; readonly y: number } | undefined
    >();
  });

  it('mouse.pointerLocked returns boolean (required, alongside movementDelta)', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.mouse.pointerLocked).toEqualTypeOf<boolean>();
  });

  it('mouse button edge readers accept the literal union and return boolean', () => {
    const snap: InputSnapshot = createInputSnapshot();
    expectTypeOf(snap.mouse.justPressed(0)).toEqualTypeOf<boolean>();
    expectTypeOf(snap.mouse.justReleased(0)).toEqualTypeOf<boolean>();
  });

  it('mouse.button(3) is a TS compile error (literal-narrowing rejects out-of-range)', () => {
    const snap: InputSnapshot = createInputSnapshot();
    // @ts-expect-error -- 3 is not assignable to 0 | 1 | 2 (charter P3 explicit failure)
    snap.mouse.button(3);
    // @ts-expect-error -- arbitrary number is not assignable either
    snap.mouse.button(42 as number);
  });
});
