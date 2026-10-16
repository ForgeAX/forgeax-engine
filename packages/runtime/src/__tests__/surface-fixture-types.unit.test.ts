import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureFiles = [
  'packages/runtime/src/__tests__/material-publication.fixture.ts',
  'packages/runtime/src/__tests__/surface-standard-pipeline.runtime-fixture.ts',
  'packages/runtime/src/__tests__/surface-msaa-edge-oracle.ts',
].map((relativePath) => `${repositoryRoot}/${relativePath}`);

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => {
    const location = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const file = diagnostic.file?.fileName ?? '<compiler>';
    const suffix = location === undefined ? '' : `:${location.line + 1}:${location.character + 1}`;
    return `${file}${suffix} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
}

describe('Surface runtime fixture semantic contract', () => {
  it('type-checks the fixture and its complete import closure with repository options', () => {
    const config = ts.readConfigFile(`${repositoryRoot}/tsconfig.base.json`, ts.sys.readFile);
    expect(config.error).toBeUndefined();
    if (config.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }

    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);
    const program = ts.createProgram(fixtureFiles, {
      ...parsed.options,
      noEmit: true,
      composite: false,
      incremental: false,
      types: ['node'],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(formatDiagnostics(diagnostics)).toEqual([]);
  }, 30_000);
});
