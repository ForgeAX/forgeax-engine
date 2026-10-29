#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../..', import.meta.url));
const outputName = /^out(?:$|[A-Z_0-9])/u;
const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

export function isImplementationSource(file) {
  return (
    /^packages\/[^/]+\/src\/.+\.tsx?$/u.test(file) &&
    !/(?:\/__(?:tests|fixtures)__\/|\.test\.|\.d\.ts$)/u.test(file)
  );
}

function unwrap(node) {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
}

function containsNullish(type) {
  return type.isUnion() ? type.types.some(containsNullish) : (type.flags & nullish) !== 0;
}

function storageType(type) {
  if (type.isUnion()) return type.types.some(storageType);
  return (
    (type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.ESSymbolLike |
        nullish |
        ts.TypeFlags.Never)) ===
    0
  );
}

function bodyNodes(fn) {
  const nodes = [];
  function visit(node) {
    if (ts.isFunctionLike(node)) return;
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  if (fn.body) visit(fn.body);
  return nodes;
}

function outputAliases(parameter, nodes, checker) {
  const aliases = new Set([checker.getSymbolAtLocation(parameter.name)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) continue;
      const value = unwrap(node.initializer);
      if (!value || !ts.isIdentifier(value) || !aliases.has(checker.getSymbolAtLocation(value)))
        continue;
      const symbol = checker.getSymbolAtLocation(node.name);
      if (!aliases.has(symbol)) {
        aliases.add(symbol);
        changed = true;
      }
    }
  }
  return aliases;
}

function isOutput(node, aliases, checker) {
  node = unwrap(node);
  return (
    node !== undefined && ts.isIdentifier(node) && aliases.has(checker.getSymbolAtLocation(node))
  );
}

function nullishOperands(output, sentinel, aliases, checker) {
  output = unwrap(output);
  sentinel = unwrap(sentinel);
  if (ts.isTypeOfExpression(output))
    return (
      isOutput(output.expression, aliases, checker) &&
      ts.isStringLiteral(sentinel) &&
      sentinel.text === 'undefined'
    );
  return (
    isOutput(output, aliases, checker) &&
    (sentinel.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(sentinel) && sentinel.text === 'undefined'))
  );
}

function nullishTest(node, aliases, checker) {
  node = unwrap(node);
  if (isOutput(node, aliases, checker)) return { present: true };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const test = nullishTest(node.operand, aliases, checker);
    return test === undefined ? undefined : { present: !test.present };
  }
  if (!ts.isBinaryExpression(node)) return undefined;
  if (
    !nullishOperands(node.left, node.right, aliases, checker) &&
    !nullishOperands(node.right, node.left, aliases, checker)
  )
    return undefined;
  if (
    [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
      node.operatorToken.kind,
    )
  )
    return { present: false };
  if (
    [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
      node.operatorToken.kind,
    )
  )
    return { present: true };
  return undefined;
}

function replacementValue(expression, aliases, type, checker) {
  if (isOutput(expression, aliases, checker)) return false;
  if (!expression || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  const candidate = checker.getTypeAtLocation(expression);
  return (
    !(candidate.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
    storageType(candidate) &&
    checker.isTypeAssignableTo(candidate, checker.getNonNullableType(type))
  );
}

function hasAbsentReplacement(statement, aliases, type, checker) {
  if (!statement) return false;
  const nodes = [];
  function visit(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && replacementValue(node.expression, aliases, type, checker))
      nodes.push(node);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isOutput(node.left, aliases, checker) &&
      replacementValue(node.right, aliases, type, checker)
    )
      nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return nodes.length > 0;
}

function fallbackNodes(nodes, aliases, type, checker) {
  return nodes.filter((node) => {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
      ].includes(node.operatorToken.kind)
    )
      return isOutput(node.left, aliases, checker) && !isOutput(node.right, aliases, checker);
    if (ts.isConditionalExpression(node)) {
      const test = nullishTest(node.condition, aliases, checker);
      return (
        test !== undefined &&
        replacementValue(test.present ? node.whenFalse : node.whenTrue, aliases, type, checker)
      );
    }
    if (!ts.isIfStatement(node)) return false;
    const test = nullishTest(node.expression, aliases, checker);
    if (!test) return false;
    if (!test.present) return hasAbsentReplacement(node.thenStatement, aliases, type, checker);
    if (node.elseStatement) return hasAbsentReplacement(node.elseStatement, aliases, type, checker);
    if (!ts.isBlock(node.parent)) return false;
    const following = node.parent.statements.slice(node.parent.statements.indexOf(node) + 1);
    return following.some((statement) => hasAbsentReplacement(statement, aliases, type, checker));
  });
}

/** Positional output convention; no ban on returning the supplied output or independent status. */
export function inspectRequiredOutputs(program, files, repository) {
  const checker = program.getTypeChecker();
  const violations = [];
  for (const file of files) {
    const path = relative(repository, file).replaceAll('\\', '/');
    if (!isImplementationSource(path)) continue;
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing program source: ${path}`);
    function visit(node) {
      if (
        ts.isFunctionLike(node) &&
        node.parameters?.some(
          (parameter) => ts.isIdentifier(parameter.name) && outputName.test(parameter.name.text),
        )
      ) {
        const nodes = bodyNodes(node);
        for (const parameter of node.parameters) {
          if (!ts.isIdentifier(parameter.name) || !outputName.test(parameter.name.text)) continue;
          const type = checker.getTypeAtLocation(parameter);
          if (!storageType(type)) continue;
          const entry = {
            file: path,
            function:
              node.name?.getText(source) ?? node.parent.name?.getText(source) ?? '<anonymous>',
            parameter: parameter.name.text,
          };
          const add = (location, code) =>
            violations.push({
              ...entry,
              line: source.getLineAndCharacterOfPosition(location.getStart()).line + 1,
              code,
            });
          if (
            parameter.questionToken ||
            parameter.initializer ||
            parameter.dotDotDotToken ||
            containsNullish(type)
          )
            add(parameter, 'optional-output');
          for (const fallback of fallbackNodes(
            nodes,
            outputAliases(parameter, nodes, checker),
            type,
            checker,
          ))
            add(fallback, 'implicit-output-fallback');
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return violations;
}

export function createOutputProgram(repository, files) {
  const raw = ts.readConfigFile(resolve(repository, 'tsconfig.base.json'), ts.sys.readFile);
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, repository);
  return ts.createProgram(files, {
    ...config.options,
    noEmit: true,
    baseUrl: repository,
    paths: {
      '@forgeax/engine-math': ['packages/math/src/index.ts'],
      '@forgeax/engine-math/*': ['packages/math/src/*'],
      '@forgeax/engine-types': ['packages/types/src/index.ts'],
      '@forgeax/engine-types/*': ['packages/types/src/*'],
    },
  });
}

function main() {
  const files = execFileSync('git', ['ls-files', '-z', 'packages'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(isImplementationSource)
    .map((file) => resolve(root, file));
  const violations = inspectRequiredOutputs(createOutputProgram(root, files), files, root);
  for (const entry of violations)
    process.stderr.write(
      `REQUIRED_OUTPUT ${entry.file}:${entry.line}: ${entry.function}(${entry.parameter}): ${entry.code}; require supplied storage without an implicit replacement\n`,
    );
  if (violations.length) process.exitCode = 1;
  else process.stdout.write(`Required output PASS (${files.length} implementation sources)\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
