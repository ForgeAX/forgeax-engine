import { dirname, resolve } from 'node:path';
import ts from 'typescript';

/** Literal sibling resources belong to the loaded module, not its whole directory. */
export function moduleUrlResources(code: string, filename: string): readonly string[] {
  if (!code.includes('new URL(')) return [];
  const source = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const resources: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL') {
      const [path, base] = node.arguments ?? [];
      if (
        path &&
        ts.isStringLiteralLike(path) &&
        /^\.{1,2}\//.test(path.text) &&
        base?.getText(source) === 'import.meta.url'
      )
        resources.push(resolve(dirname(filename), path.text.split(/[?#]/)[0] ?? path.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return resources;
}
