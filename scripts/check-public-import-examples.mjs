#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Project, ts } from 'ts-morph';

const root = process.env.FORGEAX_ROOT ?? process.cwd();
const packagesRoot = path.join(root, 'packages');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name.startsWith('.') ||
        ['node_modules', 'dist', 'pkg', 'vendor'].includes(entry.name)
      )
        continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (/\.(md|ts|tsx|js|jsx|mjs)$/.test(entry.name)) files.push(entryPath);
    }
  }
  return files;
}

function packageRecords() {
  const records = new Map();
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesRoot, entry.name);
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest.name?.startsWith('@forgeax/engine-')) continue;
    records.set(manifest.name, {
      dir,
      index: path.join(dir, 'src/index.ts'),
      manifest,
      name: manifest.name,
      exports: new Set(Object.keys(manifest.exports ?? { '.': true })),
    });
  }
  return records;
}

const packages = packageRecords();
const engineDir = path.join(packagesRoot, 'engine');
const engineManifest = JSON.parse(fs.readFileSync(path.join(engineDir, 'package.json'), 'utf8'));
const publicSurfaceFiles = new Set([
  'packages/project/README.md',
  'packages/plugin/README.md',
  'packages/plugin/src/__tests__/public-api.test-d.ts',
]);
const paths = {};
for (const [name, record] of packages) {
  paths[name] = [record.index];
  paths[`${name}/*`] = [path.join(record.dir, 'src/*')];
}
paths['@forgeax/engine'] = [path.join(engineDir, 'dist/index.d.ts')];
paths['@forgeax/engine/*'] = [path.join(engineDir, 'dist/facades/*')];

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    baseUrl: root,
    ignoreDeprecations: '6.0',
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    paths,
    target: ts.ScriptTarget.ESNext,
  },
});

for (const record of packages.values()) {
  if (fs.existsSync(record.index)) project.addSourceFileAtPath(record.index);
}

const consumerProject = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    baseUrl: root,
    ignoreDeprecations: '6.0',
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts'],
    noEmit: true,
    paths,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
    types: ['node'],
  },
});
const consumerSource = consumerProject.createSourceFile(
  '/tmp/forgeax-public-api-consumer.ts',
  `
import { Context, mountPluginAsset, startNativePlugin } from '@forgeax/engine/plugin';
import type { Plugin } from '@forgeax/engine/plugin';
import { GameProjectSchema } from '@forgeax/engine/project';
import { beginLoadSession, beginLoadWork, collectLoadTimeline, markLoadTimeline } from '@forgeax/engine-types';

// Load observers remain usable by native consumers with only the ES library.
void beginLoadSession;
void beginLoadWork;
void collectLoadTimeline;
void markLoadTimeline;

const movement: Plugin.Object<{ speed: number }> = {
  name: 'movement',
  apply: (ctx, config) => ctx.provide('movementSpeed', config.speed),
};
const context = new Context();
const root: Plugin.Object<{ speed: number }> = {
  apply(ctx, config) { ctx.plugin(movement, { speed: config.speed }); },
};
// @ts-expect-error Native Plugin.Object rejects a string speed.
context.plugin(movement, { speed: 'not-a-number' });
const project = GameProjectSchema.parse({
  id: 'game', name: 'Game', schemaVersion: '3.0.0', roots: {},
});
void startNativePlugin(context, root, { speed: 2 });
if (project.roots.engine) void mountPluginAsset(context, project.roots.engine);

`,
);
const consumerDiagnostics = consumerProject.getPreEmitDiagnostics(consumerSource);
const unresolvedImportSource = consumerProject.createSourceFile(
  '/tmp/forgeax-public-api-missing.ts',
  "import '@forgeax/engine/plugin/missing';\n",
);
const unresolvedImportDiagnostics = consumerProject.getPreEmitDiagnostics(unresolvedImportSource);
function diagnosticMessage(diagnostic) {
  if (typeof diagnostic.getMessageText === 'function') {
    return diagnosticMessage(diagnostic.getMessageText());
  }
  if (typeof diagnostic.getCompilerObject === 'function') {
    return diagnosticMessage(diagnostic.getCompilerObject().messageText);
  }
  if (typeof diagnostic === 'string') return diagnostic;
  if (Array.isArray(diagnostic)) {
    return diagnostic.map(diagnosticMessage).join(' ');
  }
  if (diagnostic?.messageText !== undefined) return diagnosticMessage(diagnostic.messageText);
  return String(diagnostic);
}

const exportCache = new Map();
function publicExports(packageName) {
  if (exportCache.has(packageName)) return exportCache.get(packageName);
  const record = packages.get(packageName);
  if (record === undefined) return new Set();
  const sourceFile =
    project.getSourceFile(record.index) ?? project.addSourceFileAtPath(record.index);
  const names = new Set(sourceFile.getExportSymbols().map((symbol) => symbol.getName()));
  exportCache.set(packageName, names);
  return names;
}

const subpathExportCache = new Map();
function exportTargets(record, subpath) {
  const value = record.manifest.exports?.[subpath];
  const targets = [];
  const visit = (candidate) => {
    if (typeof candidate === 'string') {
      if (candidate.startsWith('./')) targets.push(path.resolve(record.dir, candidate));
      return;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    for (const condition of ['types', 'import', 'browser', 'node', 'default']) {
      if (Object.hasOwn(candidate, condition)) visit(candidate[condition]);
    }
  };
  visit(value);
  return [...new Set(targets)];
}

function sourcePathFor(target) {
  const relative = path.relative(path.join(root, 'packages'), target);
  const sourceRelative = relative
    .replace(/(^|\/)dist\//, '$1src/')
    .replace(/\.(?:mjs|cjs|js|d\.ts)$/, '.ts');
  return path.join(packagesRoot, sourceRelative);
}

function sourceExports(record, subpath) {
  const cacheKey = `${record.name}:${subpath}`;
  if (subpathExportCache.has(cacheKey)) return subpathExportCache.get(cacheKey);
  const candidates = exportTargets(record, subpath)
    .map(sourcePathFor)
    .filter((file) => fs.existsSync(file));
  const names = new Set();
  for (const file of candidates) {
    const sourceFile = project.getSourceFile(file) ?? project.addSourceFileAtPathIfExists(file);
    if (sourceFile === undefined) continue;
    for (const symbol of sourceFile.getExportSymbols()) names.add(symbol.getName());
  }
  subpathExportCache.set(cacheKey, names);
  return names;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function regionsFor(file, source) {
  if (file.endsWith('.md')) {
    return [...source.matchAll(/```[\s\S]*?```/g)].map((match) => ({
      offset: match.index,
      text: match[0],
    }));
  }
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(file)) {
    return [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map((match) => ({
      offset: match.index,
      text: match[0],
    }));
  }
  return [];
}

function namesFromList(list) {
  return list
    .split(',')
    .map((entry) => entry.replace(/^\s*\*\s?/, '').trim())
    .map((entry) => entry.replace(/^type\s+/, '').trim())
    .map((entry) => entry.split(/\s+as\s+/)[0].trim())
    .filter((entry) => entry && entry !== '*' && !entry.startsWith('...'));
}

function packageAndSubpath(specifier) {
  if (specifier === '@forgeax/engine' || specifier.startsWith('@forgeax/engine/')) {
    return {
      packageName: '@forgeax/engine',
      subpath: specifier === '@forgeax/engine' ? '.' : specifier.slice('@forgeax/engine'.length),
    };
  }
  const match = specifier.match(/^(@forgeax\/engine-[^/]+)(\/.*)?$/);
  if (match === null) return undefined;
  return {
    packageName: match[1],
    subpath: match[2] === undefined ? '.' : `.${match[2]}`,
  };
}

function resolveTarget(target) {
  if (target.packageName !== '@forgeax/engine') {
    return { record: packages.get(target.packageName), subpath: target.subpath };
  }
  if (target.subpath === '.') {
    return { record: packages.get('@forgeax/engine-runtime'), subpath: '.' };
  }
  const parts = target.subpath.slice(1).split('/');
  const directory = parts.shift();
  if (directory === undefined) return { record: undefined, subpath: '.' };
  return {
    record: packages.get(`@forgeax/engine-${directory}`),
    subpath: parts.length === 0 ? '.' : `./${parts.join('/')}`,
  };
}

function umbrellaManifestAllows(subpath) {
  const specifier = subpath === '.' ? '.' : `.${subpath}`;
  return Object.keys(engineManifest.exports ?? {}).some((key) => {
    if (key === specifier) return true;
    return key.endsWith('/*') && specifier.startsWith(key.slice(0, -1));
  });
}

function umbrellaFacadePaths(subpath) {
  const segments = subpath === '.' ? ['index'] : ['facades', ...subpath.slice(1).split('/')];
  const stem = path.join(engineDir, 'dist', ...segments);
  return { declaration: `${stem}.d.ts`, runtime: `${stem}.mjs` };
}

const facadeExportCache = new Map();
function facadeExports(subpath) {
  if (facadeExportCache.has(subpath)) return facadeExportCache.get(subpath);
  const facade = umbrellaFacadePaths(subpath);
  const names = new Set();
  if (fs.existsSync(facade.declaration)) {
    const sourceFile =
      project.getSourceFile(facade.declaration) ?? project.addSourceFileAtPath(facade.declaration);
    for (const symbol of sourceFile.getExportSymbols()) names.add(symbol.getName());
  }
  facadeExportCache.set(subpath, names);
  return names;
}

function validateUmbrellaTarget(target, resolvedTarget) {
  const failures = [];
  if (!umbrellaManifestAllows(target.subpath)) {
    failures.push(
      `umbrella export ${target.subpath} is not declared by packages/engine/package.json`,
    );
  }
  const facade = umbrellaFacadePaths(target.subpath);
  if (!fs.existsSync(facade.declaration) || !fs.existsSync(facade.runtime)) {
    failures.push(`generated facade is missing for @forgeax/engine${target.subpath}`);
  }
  const expectedSource =
    resolvedTarget.subpath === '.'
      ? resolvedTarget.record.name
      : `${resolvedTarget.record.name}${resolvedTarget.subpath.slice(1)}`;
  const sourceNames = sourceExports(resolvedTarget.record, resolvedTarget.subpath);
  const expectedFacade = `${sourceNames.has('default') ? `export { default } from '${expectedSource}';\n` : ''}export * from '${expectedSource}';\n`;
  for (const artifact of [facade.declaration, facade.runtime]) {
    if (fs.existsSync(artifact)) {
      const content = fs.readFileSync(artifact, 'utf8');
      if (content !== expectedFacade) {
        failures.push(`generated facade is stale or differs from ${expectedSource}`);
        break;
      }
    }
  }
  const facadeNames = facadeExports(target.subpath);
  for (const name of sourceNames) {
    if (!facadeNames.has(name)) {
      failures.push(`generated facade omits source export ${name}`);
    }
  }
  return failures;
}

function hasPublicSubpath(record, subpath) {
  if (subpath === '.') return record.exports.has('.') || record.exports.size === 0;
  if (record.exports.has(subpath)) return true;
  return [...record.exports].some(
    (entry) => entry.endsWith('/*') && subpath.startsWith(entry.slice(0, -1)),
  );
}

const findings = [];
if (
  !unresolvedImportDiagnostics.some((diagnostic) =>
    diagnosticMessage(diagnostic).includes('Cannot find module'),
  )
) {
  findings.push(
    'negative contract failed: TypeScript accepted nonexistent @forgeax/engine/plugin/missing',
  );
}
for (const diagnostic of consumerDiagnostics) {
  findings.push(`public API consumer typecheck: ${diagnosticMessage(diagnostic)}`);
}
const scanFiles = walk(path.join(root, 'packages')).concat(walk(path.join(root, 'apps')));

for (const file of scanFiles) {
  if (file.endsWith('CHANGELOG.md')) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const region of regionsFor(file, source)) {
    for (const match of region.text.matchAll(
      /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g,
    )) {
      const lineStart = region.text.lastIndexOf('\n', match.index) + 1;
      const linePrefix = region.text.slice(lineStart, match.index).trimStart();
      if (linePrefix.startsWith('-') || linePrefix.startsWith('+')) continue;
      const target = packageAndSubpath(match[2]);
      if (target === undefined) continue;
      const location = `${path.relative(root, file)}:${lineAt(source, region.offset + match.index)}`;
      if (target.packageName === '@forgeax/engine' && target.subpath === '.') continue;
      if (
        publicSurfaceFiles.has(path.relative(root, file)) &&
        target.packageName !== '@forgeax/engine'
      ) {
        findings.push(
          `${location}: public examples must import through @forgeax/engine/${target.subpath.slice(2)}`,
        );
        continue;
      }
      const resolvedTarget = resolveTarget(target);
      const record = resolvedTarget.record;
      if (record === undefined) {
        findings.push(`${location}: package ${target.packageName} does not exist in packages/`);
        continue;
      }
      if (!hasPublicSubpath(record, resolvedTarget.subpath)) {
        findings.push(
          `${location}: public subpath ${match[2]} is not declared by ${target.packageName}`,
        );
        continue;
      }
      if (target.packageName === '@forgeax/engine') {
        for (const failure of validateUmbrellaTarget(target, resolvedTarget)) {
          findings.push(`${location}: ${failure}`);
        }
      }
      if (target.packageName === '@forgeax/engine' || resolvedTarget.subpath === '.') {
        const exports =
          target.packageName === '@forgeax/engine'
            ? facadeExports(target.subpath)
            : resolvedTarget.subpath === '.'
              ? publicExports(record.name)
              : sourceExports(record, resolvedTarget.subpath);
        for (const name of namesFromList(match[1])) {
          if (!exports.has(name)) {
            findings.push(`${location}: ${name} is not exported by ${target.packageName}`);
          }
        }
      }
    }
  }
}

const negativeTarget = { packageName: '@forgeax/engine', subpath: '/plugin/missing' };
const negativeResolvedTarget = resolveTarget(negativeTarget);
if (
  negativeResolvedTarget.record !== undefined &&
  hasPublicSubpath(negativeResolvedTarget.record, negativeResolvedTarget.subpath)
) {
  findings.push(
    'negative contract failed: nonexistent @forgeax/engine/plugin/missing was accepted',
  );
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`[public-import-examples] ${finding}`);
  console.error(`[public-import-examples] ${findings.length} finding(s)`);
  process.exitCode = 1;
} else {
  console.log('[public-import-examples] OK');
}
