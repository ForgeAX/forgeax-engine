#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { checkRuntimeArtifactResources } from './runtime-artifact-resources.mjs';
import {
  isBuildTool,
  isPackToolSpecifier,
  MIXED_TOOL_DEPENDENCIES,
  sourceAuthority,
  TOOL_OWNERS,
} from './runtime-boundary-policy.mjs';

const EXTENSIONS = /\.[cm]?[jt]sx?$/;
const IGNORED_DIRS = new Set(['__tests__', '__fixtures__', 'tests', 'fixtures', 'node_modules']);
const TEST_EXPORT = /ForTests$|^__test(?:_|$)|^__resetForTests$/i;
const TOOL_HINT =
  /\b(?:vite|vitest|esbuild|rollup|rolldown|webpack|parcel|tsup)\b|@forgeax\/engine-vite-plugin-/i;
const TOOL_RESOURCE = /[?&](?:raw|url|worker|sharedworker|inline)(?:[=&]|$)/;
const TOOL_RESOURCE_URL_PATH =
  /^(?:\.{1,2}\/|\/)[^?#]+\.(?:[cm]?[jt]sx?|wasm|wgsl|glsl|vert|frag|spv|bin|json|css|html|svg|png|jpe?g|webp|gif|avif|ktx2?|hdr|exr|mp3|wav|ogg|woff2?|ttf|otf)(?=[?#]|$)/i;
const TOOL_GLOBAL = /^(?:__DEV__|__PROD__|__VITE_\w*|__webpack_\w*)$/;
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];
const SOURCE_EXTENSION_BY_OUTPUT = new Map([
  ['.js', '.ts'],
  ['.jsx', '.tsx'],
  ['.mjs', '.mts'],
  ['.cjs', '.cts'],
]);

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function scopesFor(source) {
  const scopes = new WeakMap();
  const root = { parent: undefined, bindings: new Map(), function: true };
  function bind(name, value, scope, projection = [], ambient = false) {
    if (ts.isIdentifier(name)) {
      scope.bindings.set(name.text, { value, scope, projection, ambient });
      return;
    }
    for (const [index, element] of name.elements.entries()) {
      if (ts.isOmittedExpression(element)) continue;
      const property = element.propertyName ?? element.name;
      const key = ts.isArrayBindingPattern(name)
        ? String(index)
        : ts.isComputedPropertyName(property)
          ? constantText(property.expression, scope)
          : property.text;
      bind(element.name, value, scope, [...projection, key], ambient);
    }
  }
  function visit(node, scope) {
    if (ts.isFunctionDeclaration(node) && node.name) bind(node.name, undefined, scope);
    if (ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node))
      scope = { parent: scope, bindings: new Map(), function: ts.isFunctionLike(node) };
    scopes.set(node, scope);
    if (ts.isParameter(node)) bind(node.name, undefined, scope);
    if (ts.isVariableDeclaration(node)) {
      let target = scope;
      if (
        ts.isVariableDeclarationList(node.parent) &&
        !(node.parent.flags & ts.NodeFlags.BlockScoped)
      )
        while (target.parent && !target.function) target = target.parent;
      const ambient = node.parent.parent.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
      );
      bind(node.name, node.initializer, target, [], ambient);
    }
    if (ts.isImportClause(node) && node.name) bind(node.name, undefined, scope);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(node.name, undefined, scope);
    if (ts.isCatchClause(node) && node.variableDeclaration)
      bind(node.variableDeclaration.name, undefined, scope);
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(source, root);
  return scopes;
}

function lookup(name, scope) {
  while (scope) {
    if (scope.bindings.has(name)) return scope.bindings.get(name);
    scope = scope.parent;
  }
  return undefined;
}

function constantText(node, scope, seen = new Set()) {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isIdentifier(node) || seen.has(node.text)) return undefined;
  const binding = lookup(node.text, scope);
  if (!binding?.value) return undefined;
  return constantText(binding.value, binding.scope, new Set([...seen, node.text]));
}

function accessPath(node, scope, seen = new Set()) {
  node = unwrap(node);
  if (ts.isMetaProperty(node)) return ['import.meta'];
  if (ts.isIdentifier(node)) {
    const binding = lookup(node.text, scope);
    if (binding) {
      if (!binding.value || seen.has(binding)) return undefined;
      const base = accessPath(binding.value, binding.scope, new Set([...seen, binding]));
      return base && [...base, ...binding.projection];
    }
    if (['process', 'globalThis', 'window', 'self'].includes(node.text)) return [node.text];
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const base = accessPath(node.expression, scope, seen);
    const key = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression && constantText(node.argumentExpression, scope);
    if (base && key) return [...base, key];
  }
  return undefined;
}

function isEnvironment(path) {
  if (!path) return false;
  const normalized = ['globalThis', 'window', 'self'].includes(path[0]) ? path.slice(1) : path;
  return normalized[0] === 'process' && normalized[1] === 'env';
}

function runtimeImports(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
    return [node.moduleSpecifier];
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return [node.argument.literal];
  if (
    ts.isCallExpression(node) &&
    node.arguments[0] &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
  )
    return [node.arguments[0]];
  return [];
}

function isTypeOnlyPackContract(node, specifier) {
  if (!isPackToolSpecifier(specifier)) return false;
  if (ts.isImportTypeNode(node)) return true;
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return true;
    return (
      !clause?.name &&
      clause?.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    );
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    return (
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly)
    );
  }
  return false;
}

function exportedNames(node) {
  if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) return [node.expression];
  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
    return node.exportClause.elements.flatMap((entry) =>
      entry.propertyName ? [entry.propertyName, entry.name] : [entry.name],
    );
  if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (ts.isVariableStatement(node))
    return node.declarationList.declarations.flatMap((entry) => bindingIdentifiers(entry.name));
  return node.name ? [node.name] : [];
}

function inspectEnvironment(node, scope, add) {
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isEnvironment(accessPath(node, scope))
  )
    add(
      node,
      'runtime-host-environment',
      'Pass host configuration explicitly; runtime must not infer process.env.',
    );
  if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
    for (const name of bindingNames(node.name)) {
      const binding = lookup(name, scope);
      if (
        binding?.value &&
        isEnvironment(accessPath(binding.value, binding.scope)?.concat(binding.projection))
      )
        add(
          node,
          'runtime-host-environment',
          'Environment destructuring belongs to an explicit host adapter.',
        );
    }
  }
}

function isLocalToolEdge(file, specifier) {
  if (!specifier.startsWith('.')) return false;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return [target, `${target}.ts`, `${target}/index.ts`].some(
    (candidate) => sourceAuthority(candidate).tools,
  );
}

function inspectImports(node, scope, authority, mode, file, add) {
  for (const imported of runtimeImports(node)) {
    const specifier = constantText(imported, scope);
    if (
      specifier &&
      !authority.tools &&
      !isTypeOnlyPackContract(node, specifier) &&
      (isBuildTool(specifier) || isLocalToolEdge(file, specifier))
    )
      add(
        imported,
        'runtime-tool-import',
        `Build-tool import ${specifier} belongs to its tool adapter.`,
      );
    if (!authority.environment && ['process', 'node:process'].includes(specifier))
      add(
        imported,
        'runtime-host-environment',
        'Node process imports belong to an explicit host adapter.',
      );
    if (
      specifier &&
      TOOL_RESOURCE.test(specifier) &&
      (mode === 'dist' || !authority.assets) &&
      !authority.tools
    )
      add(
        imported,
        'runtime-tool-resource',
        `Tool resource import ${specifier} must be consumed by its owning producer.`,
      );
  }
}

function inspectToolResourceUrl(node, scope, authority, mode, add) {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'URL' ||
    lookup('URL', scope)
  )
    return;
  const resourceNode = node.arguments?.[0];
  if (!resourceNode) return;
  const resource = constantText(resourceNode, scope);
  if (
    resource &&
    TOOL_RESOURCE_URL_PATH.test(resource) &&
    TOOL_RESOURCE.test(resource) &&
    !authority.tools &&
    (mode === 'dist' || !authority.assets)
  )
    add(
      node,
      'runtime-tool-resource',
      `Tool URL transform ${resource} must be consumed by its producer and removed from dist.`,
    );
}

function inspectHint(node, authority, add) {
  if (
    !authority.tools &&
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
    node.name.text === 'hint' &&
    TOOL_HINT.test(node.initializer.getText())
  )
    add(
      node,
      'runtime-tool-hint',
      'Report the missing runtime contract; tool-specific recovery belongs to the adapter.',
    );
}

function inspectToolGlobal(node, scope, authority, add) {
  if (authority.tools) return;
  const path = accessPath(node, scope);
  if (
    path?.length === 2 &&
    ['globalThis', 'window', 'self'].includes(path[0]) &&
    TOOL_GLOBAL.test(path[1])
  ) {
    add(
      node,
      'runtime-tool-global',
      'Build-time global switches belong to an explicit tool adapter.',
    );
    return;
  }
  if (!ts.isIdentifier(node) || !TOOL_GLOBAL.test(node.text)) return;
  const binding = lookup(node.text, scope);
  if (binding && !binding.ambient) return;
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === node
  )
    return;
  add(
    node,
    'runtime-tool-global',
    'Build-time global switches belong to an explicit tool adapter.',
  );
}

export function analyzeRuntimeSource(
  source,
  { file = 'packages/fixture/src/index.ts', mode = 'source', publicEntry = false } = {},
) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const scopes = scopesFor(parsed);
  const authority = sourceAuthority(file);
  const findings = [];
  function add(node, code, message) {
    const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    findings.push({ file, line: position.line + 1, column: position.character + 1, code, message });
  }
  function visit(node) {
    const scope = scopes.get(node);
    inspectMetadata(node, scope, authority, add);
    if (!authority.environment) inspectEnvironment(node, scope, add);
    inspectImports(node, scope, authority, mode, file, add);
    inspectToolResourceUrl(node, scope, authority, mode, add);
    inspectToolGlobal(node, scope, authority, add);
    if (mode === 'source') inspectHint(node, authority, add);
    if (publicEntry)
      for (const name of exportedNames(node))
        if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && TEST_EXPORT.test(name.text))
          add(
            name,
            'runtime-test-export',
            `Test-only API ${name.text} must not be exported by a public entry.`,
          );
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.line}:${finding.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function variableInitializerDeclaration(node) {
  let outer = node;
  while (outer.parent && unwrap(outer.parent) === node) outer = outer.parent;
  return ts.isVariableDeclaration(outer.parent) && outer.parent.initializer === outer
    ? outer.parent
    : undefined;
}

function isExportedVariable(node) {
  const statement = node.parent?.parent;
  return (
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function bindingRootKeys(name, scope) {
  if (ts.isIdentifier(name)) return [];
  const keys = [];
  for (const [index, element] of name.elements.entries()) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.dotDotDotToken) {
      keys.push(undefined);
      continue;
    }
    const property = element.propertyName ?? element.name;
    keys.push(
      ts.isArrayBindingPattern(name)
        ? String(index)
        : ts.isComputedPropertyName(property)
          ? constantText(property.expression, scope)
          : property.text,
    );
  }
  return keys;
}

function metadataKeyCode(key, authority) {
  if (['resolve', 'dirname', 'filename'].includes(key)) {
    return authority.environment || authority.tools ? undefined : 'runtime-host-metadata';
  }
  return key === 'url' ? undefined : 'runtime-tool-metadata';
}

function reportMetadataKey(key, node, authority, add) {
  const code = metadataKeyCode(key, authority);
  if (!code) return;
  const message =
    code === 'runtime-host-metadata'
      ? 'Module-location introspection requires an explicit Node/tool entry; portable runtime uses import.meta.url.'
      : 'Only standard import.meta resource/location properties belong in runtime modules.';
  add(node, code, message);
}

function inspectMetadataAccess(node, scope, authority, add) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const path = accessPath(node, scope);
    if (path?.[0] === 'import.meta') reportMetadataKey(path[1], node, authority, add);
  }
}

function inspectMetadataDeclaration(node, scope, authority, add) {
  if (!ts.isVariableDeclaration(node) || !node.initializer) return;
  const path = accessPath(node.initializer, scope);
  if (path?.length !== 1 || path[0] !== 'import.meta') return;
  if (ts.isIdentifier(node.name) && !isExportedVariable(node)) return;
  if (ts.isIdentifier(node.name)) {
    add(
      node.initializer,
      'runtime-tool-metadata',
      'Only standard import.meta resource/location properties belong in runtime modules.',
    );
    return;
  }
  const keys = bindingRootKeys(node.name, scope);
  const invalidIndex = keys.findIndex((key) => metadataKeyCode(key, authority));
  if (invalidIndex >= 0) reportMetadataKey(keys[invalidIndex], node.initializer, authority, add);
}

function inspectMetadataProperty(node, scope, authority, add) {
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
    let outer = node;
    while (outer.parent && unwrap(outer.parent) === node) outer = outer.parent;
    const parent = outer.parent;
    const key =
      parent &&
      (ts.isPropertyAccessExpression(parent)
        ? parent.name.text
        : ts.isElementAccessExpression(parent) && parent.argumentExpression
          ? constantText(parent.argumentExpression, scope)
          : undefined);
    if (key !== undefined) reportMetadataKey(key, node, authority, add);
    else if (!variableInitializerDeclaration(node))
      add(
        node,
        'runtime-tool-metadata',
        'Only standard import.meta resource/location properties belong in runtime modules.',
      );
  }
}

function isBindingIdentifier(node) {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node)
  );
}

function inspectMetadataAlias(node, scope, add) {
  if (!ts.isIdentifier(node) || accessPath(node, scope)?.join('.') !== 'import.meta') return;
  if (isBindingIdentifier(node)) return;
  const parent = node.parent;
  const isPropertyBase =
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node;
  if (isPropertyBase || variableInitializerDeclaration(node)) return;
  add(
    node,
    'runtime-tool-metadata',
    'Only standard import.meta resource/location properties belong in runtime modules.',
  );
}

function inspectMetadata(node, scope, authority, add) {
  if (authority.metadata || isInsideTypeQuery(node)) return;
  inspectMetadataAccess(node, scope, authority, add);
  inspectMetadataDeclaration(node, scope, authority, add);
  inspectMetadataProperty(node, scope, authority, add);
  inspectMetadataAlias(node, scope, add);
}

function isInsideTypeQuery(node) {
  let parent = node.parent;
  while (parent) {
    if (ts.isTypeQueryNode(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

async function filesUnder(directory, mode) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || IGNORED_DIRS.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path, mode)));
    else if (
      EXTENSIONS.test(path) &&
      !/\.d\.[cm]?ts$/.test(path) &&
      !/\.(?:test|spec|bench)\.[cm]?[jt]sx?$/.test(path) &&
      (mode !== 'dist' || /\.[cm]?js$/.test(path))
    )
      files.push(path);
  }
  return files.sort();
}

function exportedTargets(value, key = '.') {
  if (typeof value === 'string') return key.includes('internal') ? [] : [value];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, target]) =>
    name === 'types' ? [] : exportedTargets(target, name.startsWith('.') ? name : key),
  );
}

function isPublicTarget(file, manifest, packageRoot) {
  return exportedTargets(manifest.exports ?? manifest.main).some((target) => {
    const normalized = relative(packageRoot, file).replaceAll('\\', '/');
    const pattern = target.replace(/^\.\//, '').split('*');
    return pattern.length === 1
      ? normalized === pattern[0]
      : normalized.startsWith(pattern[0]) && normalized.endsWith(pattern.at(-1));
  });
}

function isPublicSourceEntry(file, manifest, packageRoot) {
  const normalized = relative(packageRoot, file).replaceAll('\\', '/');
  return (
    /^src\/index\.[cm]?[jt]sx?$/.test(normalized) || isPublicTarget(file, manifest, packageRoot)
  );
}

function isPackagePublicEntry(file, manifest, packageRoot, mode) {
  return mode === 'source'
    ? isPublicSourceEntry(file, manifest, packageRoot)
    : isPublicTarget(file, manifest, packageRoot);
}

function localModuleCandidates(file, specifier) {
  if (!specifier.startsWith('.')) return [];
  const base = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (base === '..' || base.startsWith('../') || base.split('/').includes('node_modules'))
    return [];
  const extension = posix.extname(base);
  if (extension) {
    const sourceExtension = SOURCE_EXTENSION_BY_OUTPUT.get(extension);
    return sourceExtension
      ? [base, `${base.slice(0, -extension.length)}${sourceExtension}`]
      : [base];
  }
  return [
    ...MODULE_EXTENSIONS.map((suffix) => `${base}${suffix}`),
    ...MODULE_EXTENSIONS.map((suffix) => `${base}/index${suffix}`),
  ];
}

async function resolveLocalModule(file, specifier, loadModule) {
  for (const candidate of localModuleCandidates(file, specifier))
    if ((await loadModule(candidate)) !== undefined) return candidate;
  return undefined;
}

function testExportCandidate(source, node, name, testName = name) {
  const matchedName = TEST_EXPORT.test(testName)
    ? testName
    : TEST_EXPORT.test(name)
      ? name
      : undefined;
  if (!matchedName) return undefined;
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return {
    name,
    testName: matchedName,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function declarationTestExports(statement, source) {
  if (ts.isExportDeclaration(statement)) return [];
  const isDefault =
    ts.isExportAssignment(statement) ||
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  return exportedNames(statement).flatMap((name) => {
    if (!ts.isIdentifier(name)) return [];
    const candidate = testExportCandidate(
      source,
      name,
      isDefault ? 'default' : name.text,
      name.text,
    );
    return candidate ? [candidate] : [];
  });
}

async function namedTestReexports(statement, source, loadModule, ancestry, parsed, target) {
  if (!ts.isNamedExports(statement.exportClause)) return [];
  const findings = [];
  for (const element of statement.exportClause.elements) {
    const publicName = element.name.text;
    const original = element.propertyName?.text ?? publicName;
    const direct = testExportCandidate(source, element.name, publicName, original);
    if (direct) findings.push(direct);
    if (!target) continue;
    for (const candidate of await collectPublicTestExports(target, loadModule, ancestry, parsed)) {
      if (candidate.name !== original) continue;
      const reexport = testExportCandidate(source, statement, publicName, candidate.testName);
      if (reexport) findings.push(reexport);
    }
  }
  return findings;
}

async function namespaceTestReexports(statement, source, target, loadModule, ancestry, parsed) {
  if (!ts.isNamespaceExport(statement.exportClause) || !target) return [];
  return (await collectPublicTestExports(target, loadModule, ancestry, parsed)).flatMap(
    (candidate) => {
      const reexport = testExportCandidate(
        source,
        statement,
        statement.exportClause.name.text,
        candidate.testName,
      );
      return reexport ? [reexport] : [];
    },
  );
}

async function starTestReexports(statement, source, target, loadModule, ancestry, parsed) {
  if (statement.exportClause || !target) return [];
  return (await collectPublicTestExports(target, loadModule, ancestry, parsed)).flatMap(
    (candidate) => {
      if (candidate.name === 'default') return [];
      const reexport = testExportCandidate(source, statement, candidate.name, candidate.testName);
      return reexport ? [reexport] : [];
    },
  );
}

async function exportDeclarationTestExports(
  statement,
  source,
  loadModule,
  ancestry,
  parsed,
  target,
) {
  if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
  if (ts.isNamedExports(statement.exportClause))
    return namedTestReexports(statement, source, loadModule, ancestry, parsed, target);
  if (ts.isNamespaceExport(statement.exportClause))
    return namespaceTestReexports(statement, source, target, loadModule, ancestry, parsed);
  return [];
}

async function collectPublicTestExports(file, loadModule, ancestry = [], parsed = new Map()) {
  if (ancestry.includes(file)) return [];
  let source = parsed.get(file);
  if (!source) {
    const sourceText = await loadModule(file);
    if (sourceText === undefined) return [];
    source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    parsed.set(file, source);
  }
  const nextAncestry = [...ancestry, file];
  const findings = [];
  for (const statement of source.statements) {
    findings.push(...declarationTestExports(statement, source));
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier && constantText(statement.moduleSpecifier);
    const target = specifier && (await resolveLocalModule(file, specifier, loadModule));
    if (statement.exportClause)
      findings.push(
        ...(await exportDeclarationTestExports(
          statement,
          source,
          loadModule,
          nextAncestry,
          parsed,
          target,
        )),
      );
    else
      findings.push(
        ...(await starTestReexports(statement, source, target, loadModule, nextAncestry, parsed)),
      );
  }
  return findings;
}

function packageModuleLoader(directory, mode) {
  const cache = new Map();
  return async (file) => {
    if (cache.has(file)) return cache.get(file) ?? undefined;
    if (file.split('/').includes('node_modules')) return undefined;
    const isSource = EXTENSIONS.test(file) && !/\.d\.[cm]?ts$/.test(file);
    const isRuntime = mode !== 'dist' || /\.[cm]?js$/.test(file);
    if (!isSource || !isRuntime) return undefined;
    try {
      const source = await readFile(resolve(directory, file), 'utf8');
      cache.set(file, source);
      return source;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cache.set(file, null);
      return undefined;
    }
  };
}

async function publicTestExportFindings(file, packageName, loadModule) {
  const parsed = new Map();
  return (await collectPublicTestExports(file, loadModule, [], parsed)).map((candidate) => ({
    file: `packages/${packageName}/${file}`,
    line: candidate.line,
    column: candidate.column,
    code: 'runtime-test-export',
    message: `Test-only API ${candidate.testName} must not be exported by a public entry.`,
  }));
}

async function mergePackageTestExportFindings(findings, file, packageName, loadModule) {
  const seen = new Set(findings.map((finding) => `${finding.line}:${finding.code}`));
  const additional = (await publicTestExportFindings(file, packageName, loadModule)).filter(
    (finding) => {
      const key = `${finding.line}:${finding.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
  return [...findings, ...additional];
}

function missingExportTargets(files, manifest, packageRoot) {
  const names = files.map((file) => relative(packageRoot, file).replaceAll('\\', '/'));
  return exportedTargets(manifest.exports ?? manifest.main).filter((target) => {
    if (!target.startsWith('./dist/') || !/\.[cm]?js$/.test(target)) return false;
    const pattern = target.slice(2).split('*');
    return !names.some((name) =>
      pattern.length === 1
        ? name === pattern[0]
        : name.startsWith(pattern[0]) && name.endsWith(pattern.at(-1)),
    );
  });
}

async function checkPackage(root, directory, manifest, mode) {
  const violations = [];
  const name = relative(resolve(root, 'packages'), directory).replaceAll('\\', '/');
  if (mode === 'source' && !TOOL_OWNERS.has(name) && name !== 'engine') {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      for (const dependency of Object.keys(manifest[field] ?? {}))
        if (
          isBuildTool(dependency) &&
          !MIXED_TOOL_DEPENDENCIES.get(name)?.dependencies.has(dependency)
        )
          violations.push({
            file: `packages/${name}/package.json`,
            line: 1,
            code: 'runtime-tool-dependency',
            message: `${dependency} must not be a runtime dependency of ${manifest.name}.`,
          });
  }
  let files;
  try {
    files = await filesUnder(resolve(directory, mode === 'source' ? 'src' : 'dist'), mode);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (mode === 'dist' && manifest.private !== true)
      violations.push({
        file: `packages/${name}/dist`,
        line: 1,
        code: 'runtime-dist-missing',
        message: 'Build the package before checking its published runtime boundary.',
      });
    return { files: 0, violations };
  }
  const hasPublicEntries = files.some((file) =>
    isPackagePublicEntry(file, manifest, directory, mode),
  );
  const loadModule = hasPublicEntries ? packageModuleLoader(directory, mode) : undefined;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const publicEntry = isPackagePublicEntry(file, manifest, directory, mode);
    let findings = analyzeRuntimeSource(source, {
      file: relative(root, file).replaceAll('\\', '/'),
      mode,
      publicEntry,
    });
    if (publicEntry)
      findings = await mergePackageTestExportFindings(
        findings,
        relative(directory, file).replaceAll('\\', '/'),
        name,
        loadModule,
      );
    violations.push(...findings);
    if (mode === 'dist')
      violations.push(
        ...(await checkRuntimeArtifactResources({ source, file, packageRoot: directory, root })),
      );
  }
  if (mode === 'dist')
    for (const target of missingExportTargets(files, manifest, directory))
      violations.push({
        file: `packages/${name}/${target.slice(2)}`,
        line: 1,
        code: 'runtime-dist-entry-missing',
        message: 'The declared runtime export has no built JavaScript output.',
      });
  return { files: files.length, violations };
}

export async function checkRuntimeBoundaries({ root = process.cwd(), mode = 'source' } = {}) {
  if (!['source', 'dist'].includes(mode)) throw new Error('mode must be source or dist');
  const result = { mode, packages: 0, files: 0, violations: [] };
  for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = resolve(root, 'packages', entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const checked = await checkPackage(root, directory, manifest, mode);
    result.packages++;
    result.files += checked.files;
    result.violations.push(...checked.violations);
  }
  return result;
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--dist', '--json'].includes(arg)))
    throw new Error('usage: check-runtime-boundaries.mjs [--dist] [--json]');
  const mode = args.includes('--dist') ? 'dist' : 'source';
  const result = await checkRuntimeBoundaries({ mode });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const violation of result.violations)
      console.error(`${violation.file}:${violation.line}: ${violation.code}: ${violation.message}`);
    console.log(
      `runtime boundaries (${mode}): ${result.packages} packages, ${result.files} files, ${result.violations.length} violations`,
    );
  }
  if (result.violations.length) process.exitCode = 1;
}
