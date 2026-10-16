import { initSync, parse } from 'es-module-lexer';
import ts from 'typescript';

initSync();

/** Locate literal ESM edits so callers can preserve their source-map chain. */
export function moduleSpecifierEdits(
  source: string,
  filename: string,
  resolve: (specifier: string, kind: 'static' | 'dynamic') => string | undefined,
): { start: number; end: number; text: string }[] {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const edge of parse(source, filename)[0]) {
    if (edge.d === -2) continue; // import.meta is not a module edge.
    let specifier = edge.n;
    if (specifier === undefined && source[edge.s] === '`') {
      // The lexer leaves template expressions undecoded. Preserve support for
      // no-substitution literals without parsing the surrounding module.
      const literal = ts.createSourceFile(
        filename,
        source.slice(edge.s, edge.e),
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
      ).statements[0];
      if (
        literal &&
        ts.isExpressionStatement(literal) &&
        ts.isNoSubstitutionTemplateLiteral(literal.expression)
      )
        specifier = literal.expression.text;
    }
    if (specifier === undefined) continue;
    const next = resolve(specifier, edge.d === -1 ? 'static' : 'dynamic');
    if (next !== undefined && next !== specifier)
      edits.push({
        start: edge.d === -1 ? edge.s - 1 : edge.s,
        end: edge.d === -1 ? edge.e + 1 : edge.e,
        text: JSON.stringify(next),
      });
  }
  return edits;
}

/** Relocate literal ESM edges without converting or evaluating the module. */
export function rewriteModuleSpecifiers(
  source: string,
  filename: string,
  resolve: (specifier: string, kind: 'static' | 'dynamic') => string | undefined,
): string {
  for (const edit of moduleSpecifierEdits(source, filename, resolve).sort(
    (a, b) => b.start - a.start,
  ))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
