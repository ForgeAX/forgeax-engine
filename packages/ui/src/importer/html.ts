import type { ImportDiagnostic } from '@forgeax/engine-types';
import { parseHtmlAuthoring } from '../authoring/html.js';

export interface SourceLocation {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface ValidationError {
  readonly code: 'unsafe-html' | 'invalid-template' | 'invalid-url';
  readonly message: string;
  readonly location: SourceLocation;
}

export type HtmlValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: ValidationError };

function toLegacyError(diagnostic: ImportDiagnostic): ValidationError {
  return {
    code: diagnostic.code.includes('template')
      ? 'invalid-template'
      : diagnostic.code.includes('url')
        ? 'invalid-url'
        : 'unsafe-html',
    message: diagnostic.actual,
    location: diagnostic.sourceRange,
  };
}

export function validateHtmlSource(source: string): HtmlValidation {
  const result = parseHtmlAuthoring(source, '<inline>.ui.html');
  const blocking = result.diagnostics.find((entry) => entry.severity === 'error');
  return blocking ? { ok: false, error: toLegacyError(blocking) } : { ok: true, value: source };
}

/** Return local URL references in author HTML, excluding fragment links. */
export function htmlAssetUrls(source: string): readonly string[] {
  return parseHtmlAuthoring(source, '<inline>.ui.html').references.map((entry) => entry.value);
}
