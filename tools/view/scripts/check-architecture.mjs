import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, resolve, relative, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const core = '@forgeax/view-workspace-core';
const components = '@forgeax/view-components';
const viewer = '@forgeax/view-viewer';
const extensions = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.css', '.json'];
const uiRuntime = /^(?:react(?:-dom)?|dockview)(?:\/|$)/;
const internal = name => name === '@forgeax/view' || name.startsWith('@forgeax/view-');
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
const within = (directory, file) => file === directory || file.startsWith(directory + sep);
const slash = file => file.split(sep).join('/');
const hostPrefix = 'packages/viewer/src/host/';
const sharedCatalog = 'packages/viewer/src/catalog-shared.ts';
const frontendCatalog = 'packages/viewer/src/frontend-catalog.ts';

// The existing browser bundle bridge is the only non-static module seam.
// Keep the exemption at one call site, not at file/package or comment level.
function panelBundleImport(file, node) {
  if (file !== `${hostPrefix}panel-bridge.ts` || node.getText() !== 'import(/* @vite-ignore */ href)') return false;
  let parent = node.parent;
  while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
  return Boolean(parent) && ts.isFunctionDeclaration(parent) && parent.name?.text === 'loadViewPanels' &&
    parent.body.statements.some(statement => ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(declaration =>
        declaration.name.getText() === 'href' && declaration.initializer?.getText() ===
          "globalThis.__forgeaxViewPanelsUrl ?? '/panels.js'"));
}

export function parseImports(file, source) {
  if (file.endsWith('.json')) return { imports: [], diagnostics: [] };
  if (file.endsWith('.css')) {
    // Strip comments without losing diagnostic line numbers.
    const css = source.replace(/\/\*[\s\S]*?\*\//g, text => text.replace(/[^\n]/g, ' '));
    return { imports: [...css.matchAll(/@import\s+(?:url\(\s*(?:['"]([^'"]+)['"]|([^\s)]+))\s*\)|['"]([^'"]+)['"])/gi)]
      .map(match => ({ specifier: match[1] ?? match[2] ?? match[3], line: css.slice(0, match.index).split('\n').length })), diagnostics: [] };
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  let bundleImports = 0;
  const line = node => ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  function visit(node) {
    let literal;
    let moduleLoad = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal = node.moduleReference.expression;
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText() === 'require' || node.expression.getText() === 'require.resolve')) {
      literal = node.arguments[0];
      moduleLoad = true;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    if (literal && ts.isStringLiteralLike(literal)) imports.push({ specifier: literal.text, line: line(node),
      ...((ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && node.isTypeOnly) || ts.isImportTypeNode(node) ? { typeOnly: true } : {}) });
    else if (moduleLoad) {
      const bridge = panelBundleImport(file, node) && ++bundleImports === 1;
      imports.push({ specifier: undefined, bridge, line: line(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports, diagnostics: ast.parseDiagnostics.map(diagnostic => ({
    line: ast.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  })) };
}

function dependencyError(owner, name, typeOnly = false) {
  if (name === '@forgeax/view') return 'source cannot import the aggregate composition';
  if (owner === '@forgeax/view' || owner === name) return;
  if (owner === core && uiRuntime.test(name)) return 'workspace core cannot depend on a UI runtime';
  if (owner === core && typeOnly && name === '@forgeax/engine') return;
  if (owner === core && /^@forgeax\/engine(?:-|$)/.test(name) &&
      !['@forgeax/engine-host', '@forgeax/engine-plugin', '@forgeax/engine-tool-runtime'].includes(name)) {
    return 'workspace core uses Engine Host/tool contracts, not domain implementation packages';
  }
  if (owner === components && /^@forgeax\/engine(?:-|$)/.test(name)) return 'components cannot depend on Engine';
  if (!internal(name)) return;
  if (owner === core || owner === components) return 'foundations cannot depend on another View layer';
  if (owner.startsWith('@forgeax/view-plugin-') && name !== core && name !== components) {
    return 'features cannot depend on Viewer or sibling features';
  }
}

/** Check source and manifests without loading product code or requiring Engine builds. */
export function checkArchitecture(root) {
  root = resolve(root);
  const errors = [];
  const files = new Map();
  const packages = new Map();
  const report = (file, rule, message, line = 1) => errors.push({ file: slash(relative(root, file)), line, rule, message });
  function collect(directory, owner) {
    if (lstatSync(directory).isSymbolicLink()) {
      report(directory, 'source-symlink', 'source directories cannot be symlinked across layers');
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) report(file, 'source-symlink', 'source symlinks can hide cross-layer imports');
      else if (entry.isDirectory()) collect(file, owner);
      else if (extensions.includes(extname(file))) {
        if (/\.(?:[cm]?js|jsx)$/.test(entry.name) && !entry.name.endsWith('.test.mjs')) {
          report(file, 'typescript-source', 'product source uses .ts/.tsx; .mjs is reserved for tests and build output');
        }
        files.set(file, { owner, edges: [] });
      }
    }
  }
  function addPackage(directory, aggregate = false) {
    const manifestFile = resolve(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const owner = { ...manifest, directory, source: resolve(directory, 'src'), manifestFile, aggregate };
    if (packages.has(owner.name)) report(manifestFile, 'package-layer', `duplicate package ${owner.name}`);
    if (!aggregate && ![core, components, viewer].includes(owner.name) && !owner.name.startsWith('@forgeax/view-plugin-')) {
      report(manifestFile, 'package-layer', `unclassified package ${owner.name}; define its architectural role`);
    }
    const expected = owner.name === viewer ? 'viewer' : owner.name.replace('@forgeax/', '');
    if (!aggregate && directory !== resolve(root, 'packages', expected)) {
      report(manifestFile, 'package-layer', `${owner.name} must use packages/${expected}`);
    }
    packages.set(owner.name, owner);
    collect(owner.source, owner);
  }
  addPackage(root, true);
  for (const entry of readdirSync(resolve(root, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory()) addPackage(resolve(root, 'packages', entry.name));
    else if (entry.isSymbolicLink()) report(resolve(root, 'packages', entry.name), 'source-symlink', 'package symlinks are not permitted');
  }

  function resolveSource(target) {
    if (files.has(target)) return target;
    for (const extension of extensions) if (files.has(target + extension)) return target + extension;
    for (const extension of extensions) if (files.has(resolve(target, `index${extension}`))) return resolve(target, `index${extension}`);
  }
  function exportLeaves(value) {
    if (typeof value === 'string') return [value];
    if (value === null) return [];
    if (value && typeof value === 'object') return Object.values(value).flatMap(exportLeaves);
    return [];
  }
  function exportTargets(owner, value) {
    return exportLeaves(value).map(target => resolveSource(resolve(owner.directory, target))).filter(Boolean);
  }
  for (const owner of packages.values()) {
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      for (const [name, version] of Object.entries(owner[kind] ?? {})) {
        const reason = dependencyError(owner.name, name, kind === 'devDependencies');
        if (reason) report(owner.manifestFile, 'dependency-direction', `${kind}: ${name}: ${reason}`);
        if (internal(name) && !packages.has(name)) report(owner.manifestFile, 'unknown-package', name);
        if (typeof version === 'string' && /npm:(?:@forgeax\/view-|forgeax-view)/.test(version)) {
          report(owner.manifestFile, 'package-alias', 'internal packages must use their canonical names');
        }
      }
    }
    if (owner.imports) report(owner.manifestFile, 'package-alias', 'package import aliases require an explicit resolver policy');
    if (owner.aggregate) continue; // Published aggregate exports point into generated dist/.
    for (const [subpath, value] of Object.entries(owner.exports ?? {})) {
      const leaves = exportLeaves(value);
      if (!subpath.startsWith('.') || subpath.includes('*')) report(owner.manifestFile, 'package-export', `use explicit public subpaths: ${subpath}`);
      for (const target of leaves) {
        const path = resolve(owner.directory, target);
        if (!target.startsWith('./') || !within(owner.source, path) || !resolveSource(path)) {
          report(owner.manifestFile, 'package-export', `${subpath} must resolve to owned source: ${target}`);
        }
      }
    }
  }

  for (const [file, record] of files) {
    const { owner } = record;
    const local = slash(relative(root, file));
    if ((owner.name === core || local.startsWith(hostPrefix) || owner.aggregate) && /\.(?:tsx|jsx|css)$/.test(file)) {
      report(file, 'no-ui-source', 'UI source belongs to components, Shell or a product plugin');
    }
    const parsed = parseImports(local, readFileSync(file, 'utf8'));
    if (local === 'packages/view-workspace-core/src/scene-entity-classification.ts' && parsed.imports.length > 0) {
      report(file, 'scene-classification-purity', 'the shared presentation helper must have no imports or re-exports');
    }
    for (const diagnostic of parsed.diagnostics) report(file, 'source-syntax', diagnostic.message, diagnostic.line);
    for (const reference of parsed.imports) {
      const { specifier, line, bridge } = reference;
      if (specifier === undefined) {
        if (!bridge) report(file, 'computed-import', 'module loads must be statically resolvable', line);
        continue;
      }
      let targets = [];
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        if (!within(owner.source, target)) report(file, 'relative-boundary', `${specifier} leaves owned src/; use a public package export`, line);
        else {
          const resolved = resolveSource(target);
          if (!resolved) report(file, 'unresolved-import', specifier, line);
          else targets = [resolved];
        }
      } else {
        const name = packageName(specifier);
        const reason = dependencyError(owner.name, name, reference.typeOnly && specifier === '@forgeax/engine/app');
        if (reason) report(file, 'dependency-direction', `${specifier}: ${reason}`, line);
        if (/^(?:[/.#]|file:|https?:|data:)/.test(specifier)) report(file, 'import-alias', `${specifier}: use relative source or canonical package imports`, line);
        if (!internal(name) && !isBuiltin(specifier) &&
            !['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'].some(kind => Object.hasOwn(owner[kind] ?? {}, name))) {
          report(file, 'undeclared-dependency', `${specifier}: undeclared external package or unresolved alias`, line);
        }
        if (internal(name)) {
          const target = packages.get(name);
          const declared = ['dependencies', 'peerDependencies', 'optionalDependencies', ...(owner.aggregate ? ['devDependencies'] : [])]
            .some(kind => Object.hasOwn(owner[kind] ?? {}, name));
          if (name !== owner.name && !declared) report(file, 'undeclared-dependency', specifier, line);
          if (!target) report(file, 'unknown-package', specifier, line);
          else if (!target.aggregate) {
            const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
            const value = target.exports?.[subpath];
            targets = exportTargets(target, value);
            if (!targets.length) report(file, 'private-import', `${specifier} is not an exported source subpath`, line);
          }
        }
      }
      record.edges.push({ ...reference, targets });
    }
  }

  // Follow every conditional export and re-export, not just the first import's spelling.
  function walk(entry, rule, accept, stop = () => false) {
    const seen = new Set();
    function visit(file, chain) {
      if (seen.has(file)) return;
      seen.add(file);
      for (const edge of files.get(file).edges) {
        if (edge.typeOnly) continue; // Erased contracts do not enter runtime closure.
        const destinations = edge.targets.length ? edge.targets : [undefined];
        for (const target of destinations) {
          const next = [...chain, target ? slash(relative(root, target)) : edge.specifier];
          if (stop(file, target)) continue;
          if (!accept(target, edge.specifier)) report(file, rule, next.join(' -> '), edge.line);
          else if (target) visit(target, next);
        }
      }
    }
    visit(entry, [slash(relative(root, entry))]);
  }
  for (const [file, { owner }] of files) {
    const local = slash(relative(root, file));
    if (local.startsWith(hostPrefix)) {
      walk(file, 'host-isolation', (target, specifier) => target
        ? slash(relative(root, target)).startsWith(hostPrefix) || files.get(target).owner.name === core
        : !uiRuntime.test(specifier) && !internal(packageName(specifier)) &&
          (!specifier.startsWith('@forgeax/engine') || /^@forgeax\/engine-host(?:\/|$)/.test(specifier)),
      (from, to) => slash(relative(root, from)) === `${hostPrefix}frontend.ts` &&
        to === resolve(root, 'packages/viewer/src/frontend-root.ts'));
    }
    if (local === sharedCatalog) {
      walk(file, 'metadata-only', target => Boolean(target) &&
        (files.get(target).owner.name === core || /(?:^|\/)\w[\w-]*identity\.ts$|\/identity\.ts$/.test(slash(target))));
    }
    if (owner.aggregate && local !== 'src/index.ts' && local !== 'src/browser.ts') {
      walk(file, 'root-composition', (target, specifier) => target
        ? !files.get(target).owner.name.startsWith('@forgeax/view-plugin-') && files.get(target).owner.name !== components
        : !uiRuntime.test(specifier),
      // Explicit composition seams; a new public export is not automatically a seam.
      (from, to) => files.get(from).owner.aggregate && to &&
        (slash(relative(root, to)).startsWith(hostPrefix) || [
          sharedCatalog, frontendCatalog, 'packages/viewer/src/backend-catalog.ts',
          'packages/viewer/src/catalog.ts', 'packages/viewer/src/cli/index.ts',
        ].includes(slash(relative(root, to)))));
    }
  }
  return { errors, packages: packages.size, files: files.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkArchitecture(process.argv[2] ?? resolve(import.meta.dirname, '..'));
    for (const error of result.errors) console.error(`${error.file}:${error.line} [${error.rule}] ${error.message}`);
    console.log(`Architecture: ${result.packages} packages, ${result.files} source files, ${result.errors.length} violations`);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Architecture check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
