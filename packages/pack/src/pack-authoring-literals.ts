import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@forgeax/engine-types';
import ts from 'typescript';
import { PackageId } from './guid.js';
import {
  type PackAuthoringError,
  type PackParameterDefinition,
  validateParameterDefinitions,
} from './pack-authoring.js';

export interface PackAuthoringLiteral {
  readonly path: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly value: unknown;
  readonly location: { readonly line: number; readonly column: number };
}

export interface PackAuthoringDeclaration {
  readonly source: string;
  readonly sourcePath: string;
  readonly revision: string;
  readonly packageId: string;
  readonly parameters: readonly PackParameterDefinition[];
  readonly defaults: ReadonlyMap<string, PackAuthoringLiteral>;
  /** Generation source excludes live descriptors, including their default values. */
  readonly generationSource: string;
}

export function packSourceRevision(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

export function packSourceFailure(sourcePath: string, reason: string): PackAuthoringError {
  return {
    code: 'pack-source-mutation-unsupported',
    expected: 'a statically editable Pack declaration',
    hint: 'use literal parameter descriptors in definePack to enable source drafts; existing builds remain available',
    detail: { sourcePath, reason },
  };
}

function expression(node: ts.Node): ts.Node {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  throw new TypeError('computed property names cannot be edited');
}

export function readPackLiteral(node: ts.Node): unknown {
  node = expression(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const value = readPackLiteral(node.operand);
    if (typeof value === 'number')
      return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(readPackLiteral);
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property))
        throw new TypeError('only literal properties can be edited');
      const name = propertyName(property.name);
      if (Object.hasOwn(value, name) || ['__proto__', 'constructor', 'prototype'].includes(name))
        throw new TypeError('duplicate or unsafe property');
      value[name] = readPackLiteral(property.initializer);
    }
    return value;
  }
  throw new TypeError('computed values cannot be edited');
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  const matches = object.properties.filter(
    (entry) => entry.name && propertyName(entry.name) === name,
  );
  if (matches.length > 1) throw new TypeError(`duplicate ${name}`);
  const value = matches[0];
  if (value === undefined) return undefined;
  if (!ts.isPropertyAssignment(value)) throw new TypeError(`${name} must be a literal property`);
  return value;
}

/** Resolve only file-local const aliases for identity; never evaluate imports or user code. */
function packageIdentity(file: ts.SourceFile, object: ts.ObjectLiteralExpression): unknown {
  const members = object.properties.filter(
    (entry) => entry.name && propertyName(entry.name) === 'packageId',
  );
  if (members.length !== 1) throw new TypeError('expected one packageId');
  const member = members[0];
  let value: ts.Node | undefined =
    member && ts.isShorthandPropertyAssignment(member)
      ? member.name
      : member && ts.isPropertyAssignment(member)
        ? member.initializer
        : undefined;
  const visited = new Set<string>();
  while (value && ts.isIdentifier(expression(value))) {
    const name = (expression(value) as ts.Identifier).text;
    if (visited.has(name) || visited.size >= 32)
      throw new TypeError('cyclic or too deeply aliased packageId');
    visited.add(name);
    const declarations = file.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
        ? statement.declarationList.declarations.filter(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
          )
        : [],
    );
    if (declarations.length !== 1)
      throw new TypeError('packageId must be a literal UUID or a file-local const');
    value = declarations[0]?.initializer;
  }
  if (!value) throw new TypeError('packageId is absent');
  value = expression(value);
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'definePackageId'
  )
    value = value.arguments[0];
  return value && readPackLiteral(value);
}

function location(file: ts.SourceFile, node: ts.Node) {
  const at = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { line: at.line + 1, column: at.character + 1 };
}

/** Parsing never imports or executes user code, including module initialization. */
export function readPackAuthoringDeclaration(
  sourcePath: string,
  source: string,
): Result<PackAuthoringDeclaration, PackAuthoringError> {
  try {
    const file = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const syntax = (file as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics;
    if (syntax[0])
      throw new TypeError(ts.flattenDiagnosticMessageText(syntax[0].messageText, '\n'));
    const exportNode = file.statements.find(ts.isExportAssignment);
    const call = exportNode && expression(exportNode.expression);
    if (
      !call ||
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== 'definePack'
    )
      throw new TypeError('expected export default definePack({...})');
    const object = call.arguments[0] && expression(call.arguments[0]);
    if (
      !object ||
      !ts.isObjectLiteralExpression(object) ||
      object.properties.some(ts.isSpreadAssignment)
    )
      throw new TypeError('Pack definition must be an object literal without spreads');
    const packageId = packageIdentity(file, object);
    if (typeof packageId !== 'string' || !PackageId.parse(packageId).ok)
      throw new TypeError('packageId must be a literal UUID');
    const parametersNode = property(object, 'parameters');
    const array = parametersNode && expression(parametersNode.initializer);
    if (array && !ts.isArrayLiteralExpression(array))
      throw new TypeError('parameters must be an array literal');
    const parameters = array
      ? validateParameterDefinitions(readPackLiteral(array))
      : ok([] as readonly PackParameterDefinition[]);
    if (!parameters.ok) {
      const path = String(parameters.error.detail?.propertyPath ?? '');
      const match = /^\$\.parameters\[(\d+)\](?:\.(\w+))?/.exec(path);
      const descriptor =
        match && array && ts.isArrayLiteralExpression(array)
          ? array.elements[Number(match[1])]
          : undefined;
      const field =
        descriptor && ts.isObjectLiteralExpression(expression(descriptor)) && match?.[2]
          ? property(expression(descriptor) as ts.ObjectLiteralExpression, match[2])?.initializer
          : undefined;
      return err({
        ...parameters.error,
        hint: 'fix the declaration at the reported source location, then inspect parameters again',
        detail: {
          ...parameters.error.detail,
          sourcePath,
          location: location(file, field ?? descriptor ?? array ?? object),
        },
      });
    }
    const defaults = new Map<string, PackAuthoringLiteral>();
    const generationDescriptors: string[] = [];
    if (array && ts.isArrayLiteralExpression(array)) {
      for (const [index, element] of array.elements.entries()) {
        const descriptor = expression(element);
        if (!ts.isObjectLiteralExpression(descriptor))
          throw new TypeError('parameter must be an object literal');
        const parameter = parameters.value[index];
        const value = property(descriptor, 'default')?.initializer;
        if (!parameter || !value) throw new TypeError('Parameter default is absent');
        defaults.set(parameter.name, {
          path: ['parameters', String(index), 'default'],
          start: value.getStart(file),
          end: value.end,
          value: parameter.default,
          location: location(file, value),
        });
        if (typeof parameter.apply !== 'object') generationDescriptors.push(element.getText(file));
      }
    }
    const hasLive = parameters.value.some((parameter) => typeof parameter.apply === 'object');
    let generationSource = source;
    if (hasLive && array && parametersNode) {
      // Retain an empty generation context without introducing an empty parameter declaration.
      if (generationDescriptors.length > 0)
        generationSource =
          source.slice(0, array.getStart(file)) +
          `[${generationDescriptors.join(',')}]` +
          source.slice(array.end);
      else {
        let end = parametersNode.end;
        while (/\s/.test(source[end] ?? '') && end < source.length) end++;
        if (source[end] === ',') end++;
        generationSource = source.slice(0, parametersNode.getStart(file)) + source.slice(end);
      }
    }
    return ok({
      source,
      sourcePath,
      revision: packSourceRevision(source),
      packageId,
      parameters: parameters.value,
      defaults,
      generationSource,
    });
  } catch (cause) {
    return err(
      packSourceFailure(sourcePath, cause instanceof Error ? cause.message : String(cause)),
    );
  }
}

/** Replace exact literal spans, preserving surrounding code and comments. */
export function writePackAuthoringDefaults(
  declaration: PackAuthoringDeclaration,
  changes: ReadonlyMap<string, unknown>,
): Result<string, PackAuthoringError> {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const [name, value] of changes) {
    const target = declaration.defaults.get(name);
    if (!target)
      return err(packSourceFailure(declaration.sourcePath, `parameter ${name} no longer exists`));
    const text = JSON.stringify(value);
    if (text === undefined)
      return err(
        packSourceFailure(declaration.sourcePath, `parameter ${name} is not serializable`),
      );
    edits.push({ ...target, text });
  }
  let source = declaration.source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  const checked = readPackAuthoringDeclaration(declaration.sourcePath, source);
  return checked.ok ? ok(source) : checked;
}
