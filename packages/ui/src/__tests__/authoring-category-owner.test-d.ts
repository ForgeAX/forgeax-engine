import { expect, expectTypeOf, test } from 'vitest';
import { classifyUiAuthoring } from '../authoring/index.js';
import {
  pickClassification,
  UI_AUTHORING_PROFILE,
  type UiAuthoringCategory,
  type UiAuthoringProfile,
} from '../authoring/profile.js';

type ExpectedUiAuthoringCategory = 'native' | 'normalizable' | 'runtime-bound';

expectTypeOf<UiAuthoringCategory>().toEqualTypeOf<ExpectedUiAuthoringCategory>();
expectTypeOf<UiAuthoringCategory>().toEqualTypeOf<UiAuthoringProfile['precedence'][number]>();
expectTypeOf(UI_AUTHORING_PROFILE.precedence).toEqualTypeOf<
  readonly ['runtime-bound', 'normalizable', 'native']
>();

test('preserves precedence priority and native fallback', () => {
  expect(UI_AUTHORING_PROFILE.precedence).toEqual(['runtime-bound', 'normalizable', 'native']);
  expect(
    pickClassification(
      { category: 'native', blocking: false },
      { category: 'normalizable', blocking: true },
      { category: 'runtime-bound', blocking: true },
    ),
  ).toEqual({ category: 'runtime-bound', blocking: true });
  expect(
    pickClassification(
      { category: 'native', blocking: false },
      { category: 'normalizable', blocking: true },
    ),
  ).toEqual({ category: 'normalizable', blocking: true });
  expect(pickClassification()).toEqual({ category: 'native', blocking: false });
});

test('keeps the package classification projection intact', () => {
  expect(
    classifyUiAuthoring({
      sourcePath: 'native.ui.html',
      html: '<div data-ui-part="root">HUD</div>',
      css: '.button { color: red; }',
    }),
  ).toEqual({ category: 'native', blocking: false, diagnostics: [] });
  expect(
    classifyUiAuthoring({
      sourcePath: 'runtime.ui.html',
      html: '<script>window.alert(1)</script>',
      css: '.button { color: red; }',
    }).category,
  ).toBe('runtime-bound');
});
