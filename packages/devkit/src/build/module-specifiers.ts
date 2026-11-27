import { initSync, parse } from 'es-module-lexer';
import ts from 'typescript';

initSync();

type ModuleEdge = { start: number; end: number; specifier: string; kind: 'static' | 'dynamic' };
type ResolveEdge = (specifier: string, kind: ModuleEdge['kind']) => string | undefined;

/** Read only literal module edges. Resource URLs and import.meta are not module imports. */
export function* readModuleSpecifiers(source: string, filename: string): Generator<ModuleEdge> {
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
    yield {
      start: edge.d === -1 ? edge.s - 1 : edge.s,
      end: edge.d === -1 ? edge.e + 1 : edge.e,
      specifier,
      kind: edge.d === -1 ? 'static' : 'dynamic',
    };
  }
}

function editsFor(edges: Iterable<ModuleEdge>, resolve: ResolveEdge) {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const { start, end, specifier, kind } of edges) {
    const next = resolve(specifier, kind);
    if (next !== undefined && next !== specifier)
      edits.push({ start, end, text: JSON.stringify(next) });
  }
  return edits;
}

/** Locate literal ESM edits so callers can preserve their source-map chain. */
export function moduleSpecifierEdits(source: string, filename: string, resolve: ResolveEdge) {
  return editsFor(readModuleSpecifiers(source, filename), resolve);
}

function applyEdits(code: string, edits: ReturnType<typeof editsFor>): string {
  for (const edit of edits.sort((a, b) => b.start - a.start))
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

/** Reuse one parse when the same module is published to more than one locator. */
export function projectModuleSpecifiers(source: string, filename: string) {
  const edges = [...readModuleSpecifiers(source, filename)];
  return { edges, rewrite: (resolve: ResolveEdge) => applyEdits(source, editsFor(edges, resolve)) };
}

/** Relocate literal ESM edges without converting or evaluating the module. */
export function rewriteModuleSpecifiers(source: string, filename: string, resolve: ResolveEdge) {
  return applyEdits(source, moduleSpecifierEdits(source, filename, resolve));
}

export function literalMarkerSpans(code: string, filename: string, marker: string) {
  const file = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const spans: { start: number; end: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && node.text === marker)
      spans.push({ start: node.getStart(file), end: node.end });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return spans;
}
