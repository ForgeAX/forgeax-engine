#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../..', import.meta.url));

export function isEngineSource(file) {
  return (
    /^packages\/[^/]+\/src\/.+\.tsx?$/u.test(file) &&
    !/(?:\/__(?:tests|fixtures)__\/|\.test\.|\.d\.ts$)/u.test(file)
  );
}

function isEcsQuery(checker, type, repository) {
  if (type.isUnion()) return type.types.some((part) => isEcsQuery(checker, part, repository));
  return (
    checker
      .getPropertyOfType(type, 'spans')
      ?.declarations?.some((declaration) =>
        /^packages\/ecs\/(?:src|dist)\//u.test(
          relative(repository, declaration.getSourceFile().fileName).replaceAll('\\', '/'),
        ),
      ) ?? false
  );
}

/** Preserve source identity through casts and local aliases that erase Query's type. */
function isEcsInput(checker, expression, repository, seen = new Set()) {
  if (isEcsQuery(checker, checker.getTypeAtLocation(expression), repository)) return true;
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return isEcsInput(checker, expression.expression, repository, seen);
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return (
    symbol.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        isEcsInput(checker, declaration.initializer, repository, seen),
    ) ?? false
  );
}

function iterationInput(node, checker) {
  if (ts.isForOfStatement(node)) return node.expression;
  if (ts.isSpreadElement(node)) return node.expression;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === 'Array' &&
    node.expression.name.text === 'from'
  ) {
    const receiver = checker.getSymbolAtLocation(node.expression.expression);
    if (receiver?.declarations?.some((declaration) => !declaration.getSourceFile().hasNoDefaultLib))
      return undefined;
    return node.arguments[0];
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression.getText() === 'Symbol.iterator')
    return node.expression;
  return undefined;
}

/** Identity/membership reads reuse the facade without component snapshots. */
function isIdentityTraversal(node, checker) {
  if (!ts.isForOfStatement(node) || !ts.isVariableDeclarationList(node.initializer)) return false;
  const binding = node.initializer.declarations[0]?.name;
  if (binding === undefined || !ts.isIdentifier(binding)) return false;
  const symbol = checker.getSymbolAtLocation(binding);
  let safe = true;
  function visit(current) {
    if (ts.isIdentifier(current) && checker.getSymbolAtLocation(current) === symbol) {
      const access = current.parent;
      if (
        !ts.isPropertyAccessExpression(access) ||
        access.expression !== current ||
        (access.name.text !== 'entity' && access.name.text !== 'has')
      )
        safe = false;
      else if (
        access.name.text === 'has' &&
        (!ts.isCallExpression(access.parent) || access.parent.expression !== access)
      )
        safe = false;
      for (
        let parent = current.parent;
        parent !== node && parent !== undefined;
        parent = parent.parent
      )
        if (ts.isFunctionLike(parent)) safe = false;
    }
    ts.forEachChild(current, visit);
  }
  visit(node.statement);
  return safe;
}

/** Type ownership distinguishes ECS queries from arrays and unrelated iterables. */
export function inspectEcsIteration(program, files, repository) {
  const checker = program.getTypeChecker();
  const violations = [];
  for (const file of files) {
    const path = relative(repository, file).replaceAll('\\', '/');
    if (!isEngineSource(path)) continue;
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing program source: ${path}`);
    function visit(node) {
      const input = iterationInput(node, checker);
      if (input && isEcsInput(checker, input, repository) && !isIdentityTraversal(node, checker)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const entry = { file: path, line, expression: input.getText(source) };
        violations.push(entry);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { violations };
}

export function createEngineProgram(repository, files) {
  const configFile = ts.readConfigFile(resolve(repository, 'tsconfig.base.json'), ts.sys.readFile);
  if (configFile.error)
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repository);
  if (config.errors.length > 0)
    throw new Error(ts.flattenDiagnosticMessageText(config.errors[0].messageText, '\n'));
  return ts.createProgram(files, {
    ...config.options,
    noEmit: true,
    baseUrl: repository,
    paths: {
      '@forgeax/engine-ecs': ['packages/ecs/src/index.ts'],
      '@forgeax/engine-ecs/*': ['packages/ecs/src/*'],
    },
  });
}

function main() {
  const files = execFileSync('git', ['ls-files', '-z', 'packages'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(isEngineSource)
    .map((file) => resolve(root, file));
  const result = inspectEcsIteration(createEngineProgram(root, files), files, root);
  if (result.violations.length > 0) {
    for (const entry of result.violations)
      process.stderr.write(
        `ECS_ROW_ITERATION ${entry.file}:${entry.line}: ${entry.expression}; use existing spans/batches, numeric field probes or semantic owner APIs; comments cannot waive this gate\n`,
      );
    process.exitCode = 1;
  } else
    process.stdout.write(
      `Engine ECS iteration PASS (${files.length} sources, no comment waivers)\n`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
