import type { ImportDiagnostic } from '@forgeax/engine-types';
import { parseCssAuthoring } from '../authoring/css.js';
import type { SourceLocation, ValidationError } from './html.js';

export type CssValidation =
  | { readonly ok: true; readonly value: { readonly css: string } }
  | { readonly ok: false; readonly error: ValidationError };

function toLegacyError(diagnostic: ImportDiagnostic): ValidationError {
  return {
    code: diagnostic.code.includes('url') ? 'invalid-url' : 'unsafe-html',
    message: diagnostic.actual,
    location: diagnostic.sourceRange,
  };
}

export function validateCssSource(source: string): CssValidation {
  const result = parseCssAuthoring(source, '<inline>.ui.css');
  const blocking = result.diagnostics.find((entry) => entry.severity === 'error');
  return blocking
    ? { ok: false, error: toLegacyError(blocking) }
    : { ok: true, value: { css: source } };
}

export function cssAssetUrls(source: string): readonly string[] {
  return parseCssAuthoring(source, '<inline>.ui.css').references.map((entry) => entry.value);
}

export type { SourceLocation };
