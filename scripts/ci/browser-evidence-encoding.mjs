import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

/** Follow the actual Browser fixture imports; protocol acceptance owns raw encoding. */
export function browserFixtureSources(root, owners) {
  const sources = new Map();
  const pending = owners.map((owner) => resolve(root, owner));
  while (pending.length > 0) {
    const file = pending.pop();
    if (sources.has(file) || !existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    sources.set(file, text);
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const follow = (specifier) => {
      if (!specifier.startsWith('.')) return;
      const base = resolve(dirname(file), specifier).replace(/\.js$/, '');
      const imported = [base, `${base}.ts`, `${base}.mjs`, resolve(base, 'index.ts')].find(
        (path) => existsSync(path) && /\.(?:ts|mjs)$/.test(path),
      );
      if (imported && (imported.includes('/__tests__/') || imported.includes('/scripts/test/')))
        pending.push(imported);
    };
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
        follow(node.moduleSpecifier.text);
      if (
        ((ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
          (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL')) &&
        node.arguments?.[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        follow(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return sources;
}

export function uncompressedFixtureEncodings(file, text) {
  if (file.replaceAll('\\', '/').includes('/packages/rhi-debug/')) return [];
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'encodeTape') {
      const options = node.arguments[1];
      const compression =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) && property.name.getText(ast) === 'compression',
            )
          : undefined;
      if (
        !compression ||
        !ts.isStringLiteral(compression.initializer) ||
        compression.initializer.text !== 'gzip'
      )
        violations.push(
          `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}
