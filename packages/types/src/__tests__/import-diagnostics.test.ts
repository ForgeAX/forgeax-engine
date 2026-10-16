import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ImportDiagnostic, ImportErrorCode, ImportSourceRange } from '../index.js';
import { IMPORT_ERROR_HINTS, ImportError } from '../index.js';

const sourceRange: ImportSourceRange = {
  start: 12,
  end: 18,
  line: 2,
  column: 4,
};

const diagnostic: ImportDiagnostic = {
  code: 'unsafe-html',
  severity: 'error',
  sourcePath: 'ui/panel.html',
  sourceRange,
  rule: 'html.no-script',
  expected: 'no script elements',
  actual: '<script>',
  hint: 'Remove the script element and move behavior into a scenario module.',
  relatedLocations: [
    {
      sourcePath: 'ui/panel.css',
      sourceRange: { start: 0, end: 8, line: 1, column: 1 },
    },
  ],
};

function hintFor(code: ImportErrorCode): string {
  switch (code) {
    case 'importer-not-registered':
    case 'source-read-failed':
    case 'import-produced-no-assets':
    case 'guid-mismatch':
    case 'mesh-material-slot-topology-change':
    case 'mesh-lod-contract-invalid':
    case 'mesh-lod-topology-change':
    case 'mesh-lod-authority-conflict':
    case 'import-internal-error':
    case 'source-validation-failed':
    case 'unknown-source-key':
    case 'duplicate-source-key':
    case 'invalid-source-overrides':
    case 'invalid-source-override-payload':
      return IMPORT_ERROR_HINTS[code];
  }
  const exhaustive: never = code;
  return exhaustive;
}

function validationError(): InstanceType<typeof ImportError> {
  return new ImportError({
    code: 'source-validation-failed',
    expected: 'author source to satisfy the UI profile',
    hint: hintFor('source-validation-failed'),
    detail: { diagnostics: [diagnostic] },
  });
}

describe('structured import diagnostics', () => {
  it('narrows source-validation-failed detail to diagnostics without message parsing', () => {
    const error = validationError();

    expect(error.code).toBe('source-validation-failed');
    if (error.code === 'source-validation-failed' && 'diagnostics' in error.detail) {
      expect(error.detail.diagnostics[0]?.sourcePath).toBe('ui/panel.html');
      expect(error.detail.diagnostics[0]?.sourceRange).toEqual(sourceRange);
      expect(error.detail.diagnostics[0]?.relatedLocations?.[0]?.sourcePath).toBe('ui/panel.css');
    }
  });

  it('serializes the diagnostic detail with stable fields', () => {
    const error = validationError();

    expect(JSON.stringify(error.detail)).toBe(JSON.stringify({ diagnostics: [diagnostic] }));
    expect(error.message).not.toContain('ui/panel.html');
  });

  it('keeps diagnostic fields typed and complete', () => {
    expectTypeOf<ImportDiagnostic['code']>().toEqualTypeOf<string>();
    expectTypeOf<ImportDiagnostic['severity']>().toEqualTypeOf<'error' | 'warning'>();
    expectTypeOf<ImportDiagnostic['sourcePath']>().toEqualTypeOf<string>();
    expectTypeOf<ImportDiagnostic['sourceRange']>().toEqualTypeOf<ImportSourceRange>();
    expectTypeOf<ImportDiagnostic['rule']>().toEqualTypeOf<string>();
    expectTypeOf<ImportDiagnostic['expected']>().toEqualTypeOf<string>();
    expectTypeOf<ImportDiagnostic['actual']>().toEqualTypeOf<string>();
    expectTypeOf<ImportDiagnostic['hint']>().toEqualTypeOf<string>();
  });
});
