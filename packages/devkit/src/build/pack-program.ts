import {
  type PackProgram,
  type PackProgramError,
  type PackProgramSource,
  preparePackProgram,
} from '@forgeax/engine-pack/runtime';
import { err, ok, type Result } from '@forgeax/engine-types';
import ts from 'typescript';

function outputPath(path: string): string {
  return path.replace(/\.mts$/, '.mjs').replace(/\.ts$/, '.js');
}

/** Producer-only TS conversion; JavaScript takes the compiler-free Pack path. */
export function preparePackProgramSource(
  input: PackProgramSource,
): Result<PackProgram, PackProgramError> {
  if (
    !input ||
    typeof input.entry !== 'string' ||
    typeof input.export !== 'string' ||
    !input.modules ||
    typeof input.modules !== 'object' ||
    Object.values(input.modules).some((source) => typeof source !== 'string')
  )
    return err({
      code: 'pack-program-invalid',
      expected: 'an entry and text source modules',
      hint: 'repair the program source record',
      detail: { module: '', reason: 'malformed program source' },
    });
  const modules: Record<string, string> = {};
  for (const [filename, source] of Object.entries(input.modules)) {
    const target = outputPath(filename);
    if (Object.hasOwn(modules, target))
      return err({
        code: 'pack-program-invalid',
        expected: 'unique emitted module paths',
        hint: 'rename the colliding source module before preparing this program',
        detail: { module: filename, reason: `duplicate output ${target}` },
      });
    if (!/\.(?:ts|mts)$/.test(filename)) {
      modules[target] = source;
      continue;
    }
    const transformed = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        rewriteRelativeImportExtensions: true,
        verbatimModuleSyntax: true,
      },
      reportDiagnostics: true,
    });
    const errors =
      transformed.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ??
      [];
    if (errors.length)
      return err({
        code: 'pack-program-invalid',
        expected: 'TypeScript source that converts to target JavaScript',
        hint: 'repair the source diagnostics and prepare the program again',
        detail: {
          module: filename,
          reason: errors
            .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
            .join('\n'),
        },
      });
    modules[target] = transformed.outputText;
  }
  return preparePackProgram({ ...input, entry: outputPath(input.entry), modules });
}

/** Preserve agent-created TS originals beside their executable JavaScript closure. */
export function prepareRuntimePackProgram(
  input: PackProgramSource,
): Result<import('@forgeax/engine-import').RuntimePackProgram, PackProgramError> {
  const result = preparePackProgramSource(input);
  if (!result.ok) return result;
  return ok({
    artifact: result.value,
    ...(Object.keys(input.modules).some((path) => /\.(?:ts|mts)$/.test(path))
      ? { source: structuredClone(input) }
      : {}),
  });
}
