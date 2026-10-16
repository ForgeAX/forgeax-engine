// Compile-time type-derivation tests for the DefineComponentOptions surface
// after the M1 buffer/array vocab collapse (w3, AC-05).
//
// Locks the `arrayStride` option-bit removal: passing an `arrayStride` map
// to `defineComponent`'s third options arg is a TS compile-time error after
// w5. The stride contract migrates to RenderSystem-extract entry-site
// defensive plus AI user set-site responsibility (plan-strategy §2.3).
//
// Pre-M1 (before w5): `arrayStride: { ... }` is a valid option on
// `DefineComponentOptions` and the @ts-expect-error directive is unsatisfied
// (TDD red state).
//
// Post-M1 (after w5): the option is removed; the directive is satisfied; the
// surface is narrower.

import { describe, it } from 'vitest';
import { type DefineComponentOptions, defineComponent } from '../component';

describe('DefineComponentOptions — arrayStride option-bit removed (w3, AC-05)', () => {
  it('arrayStride is no longer a key on DefineComponentOptions', () => {
    type Opts = DefineComponentOptions;
    // @ts-expect-error 'arrayStride' is no longer a key on DefineComponentOptions
    // after feat-20260515 w5 (stride responsibility migrated to RenderSystem
    // extract entry).
    const opts: Opts = { arrayStride: { f: 16 } };
    void opts;
  });

  it('defineComponent rejects arrayStride at the call-site', () => {
    // @ts-expect-error 'arrayStride' is no longer accepted by defineComponent
    // after feat-20260515 w5.
    const Bar = defineComponent('Bar', { f: { type: 'array<f32>' } }, { arrayStride: { f: 16 } });
    void Bar;
  });
});
