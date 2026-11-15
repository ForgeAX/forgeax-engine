import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps the Browser prepared-work fixture independent of Node manifest cooking', () => {
  const visited = new Set<string>();
  const forbidden: { file: string; dependency: string }[] = [];
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      if (statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (
        statement.importClause?.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((entry) => entry.isTypeOnly)
      )
        continue;
      const dependency = statement.moduleSpecifier.text;
      if (dependency.startsWith('node:') || dependency === '@forgeax/engine-shader-compiler')
        forbidden.push({ file, dependency });
      if (dependency.startsWith('.'))
        visit(resolve(dirname(file), dependency.endsWith('.ts') ? dependency : `${dependency}.ts`));
    }
  };
  visit(fileURLToPath(new URL('./render-feature-prepared-graphics.fixture.ts', import.meta.url)));
  expect(forbidden).toEqual([]);
});
