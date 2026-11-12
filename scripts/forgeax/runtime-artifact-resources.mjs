import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import * as ts from 'typescript';

function isModuleUrl(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function staticModuleResources(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const resources = [];
  function visit(node) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isModuleUrl(node.arguments[1])
    ) {
      const specifier = node.arguments[0].text;
      if (
        /^\.\.?\//.test(specifier) &&
        /\.(?:[cm]?js|wasm|bytes|json|wgsl|bin)(?:[?#]|$)/.test(specifier)
      )
        resources.push({
          specifier,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return resources;
}

/** Package-owned static resources must be produced before artifact publication. */
export async function checkRuntimeArtifactResources({ source, file, packageRoot, root }) {
  const violations = [];
  for (const { specifier, line } of staticModuleResources(source, file)) {
    const target = resolve(dirname(file), specifier.split(/[?#]/)[0]);
    const inside = relative(packageRoot, target);
    if (/^\.\.(?:[\\/]|$)/.test(inside) || isAbsolute(inside)) continue;
    try {
      if ((await stat(target)).isFile()) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    violations.push({
      file: relative(root, file).replaceAll('\\', '/'),
      line,
      code: 'runtime-resource-missing',
      message: `The package producer must emit module-relative resource ${specifier} before publication.`,
    });
  }
  return violations;
}
