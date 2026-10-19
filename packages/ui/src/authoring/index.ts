import { type ImportDiagnostic, ImportError } from '@forgeax/engine-types';
import type { UiBrowserExtension } from '../browser-extensions.js';
import { uiResourcePath } from '../resources.js';
import { parseCssAuthoring } from './css.js';
import { hasBlockingDiagnostics } from './diagnostics.js';
import { parseHtmlAuthoring } from './html.js';
import { pickAuthoringCategory, type UiAuthoringCategory } from './profile.js';

export { type CssAuthoringOptions, parseCssAuthoring } from './css.js';
export { serializeDiagnostics, type UiAuthoringParse } from './diagnostics.js';
export { type HtmlAuthoringOptions, parseHtmlAuthoring } from './html.js';
export {
  UI_AUTHORING_PROFILE,
  type UiAuthoringCategory,
  type UiAuthoringProfile,
} from './profile.js';

export interface UiAuthoringInput {
  readonly browserExtensions?: readonly UiBrowserExtension[];
  readonly sourcePath: string;
  readonly html: string;
  readonly css: string;
  readonly readCompanion?: (
    path: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly path: string; readonly reason: string }
  >;
}

export interface UiAuthoringValue {
  readonly html: string;
  readonly css: string;
  readonly category: UiAuthoringCategory;
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly references: readonly string[];
}

export type UiAuthoringResult =
  | { readonly ok: true; readonly value: UiAuthoringValue }
  | { readonly ok: false; readonly error: ImportError };

export interface UiAuthoringClassification {
  readonly category: UiAuthoringCategory;
  readonly blocking: boolean;
  readonly diagnostics: readonly ImportDiagnostic[];
}

function parseAuthoring(input: Omit<UiAuthoringInput, 'readCompanion'>) {
  const options = { browserExtensions: input.browserExtensions ?? [] };
  const html = parseHtmlAuthoring(input.html, input.sourcePath, options);
  const css = parseCssAuthoring(input.css, input.sourcePath.replace(/\.html?$/i, '.css'), options);
  return {
    category: pickAuthoringCategory(html.category, css.category),
    diagnostics: [...html.diagnostics, ...css.diagnostics],
    references: [...html.references, ...css.references],
  };
}

export function classifyUiAuthoring(
  input: Omit<UiAuthoringInput, 'readCompanion'>,
): UiAuthoringClassification {
  const { category, diagnostics } = parseAuthoring(input);
  return { category, blocking: hasBlockingDiagnostics(diagnostics), diagnostics };
}

export async function validateUiAuthoring(input: UiAuthoringInput): Promise<UiAuthoringResult> {
  const { category, diagnostics, references } = parseAuthoring(input);
  if (input.readCompanion) {
    for (const reference of references) {
      if (reference.value.startsWith('#')) continue;
      const path = uiResourcePath(reference.value);
      if (!path) {
        diagnostics.push({
          code: 'companion-url-invalid',
          severity: 'error',
          sourcePath: input.sourcePath,
          sourceRange: reference.range,
          rule: 'companion-author-base',
          expected: 'a canonical companion inside the UI author directory',
          actual: reference.value,
          hint: 'Remove remote, absolute, encoded separator or escaping parent references.',
        });
        continue;
      }
      const companion = await input.readCompanion(path);
      if (!companion.ok) {
        diagnostics.push({
          code: 'companion-missing',
          severity: 'error',
          sourcePath: input.sourcePath,
          sourceRange: reference.range,
          rule: 'companion-readable',
          expected: 'a readable package-relative companion',
          actual: path,
          hint: 'Add the companion file at the attempted path and rerun validation.',
          relatedLocations: [
            { sourcePath: path, sourceRange: { start: 0, end: 1, line: 1, column: 1 } },
          ],
        });
      }
    }
  }
  if (hasBlockingDiagnostics(diagnostics)) {
    return {
      ok: false,
      error: new ImportError({
        code: 'source-validation-failed',
        expected: 'HTML, CSS, and companions within the UiAuthoringProfile',
        hint: 'Inspect err.detail.diagnostics and fix each error before importing.',
        detail: { diagnostics },
      }),
    };
  }
  return {
    ok: true,
    value: {
      html: input.html,
      css: input.css,
      category,
      diagnostics,
      references: references.map((entry) => entry.value),
    },
  };
}
