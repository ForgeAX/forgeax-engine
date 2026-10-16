#!/usr/bin/env node
/**
 * Inventory the symbols which moved out of engine-runtime during the
 * decomposition. The package remains the concrete renderer assembly entry;
 * therefore this gate checks authority symbols, rather than banning every
 * runtime import (createRenderer and EngineEnvironmentError are retained).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const legacyCreateOptionType = ['Renderer', 'CreateOptions'].join('');
const legacyBackendType = ['Renderer', 'Backend'].join('');

export const LEGACY_AUTHORITY = new Set([
  'ChildOf',
  'Children',
  'Name',
  'Transform',
  'scenePlugin',
  'propagateTransforms',
  'Skin',
  'resolveSkinJoints',
  'AnimationPlayer',
  'animationPlugin',
  'defineAnimationGraph',
  'describeAnimationGraph',
  'serializeAnimationGraph',
  'evaluateAnimationGraph',
  'advanceAnimationPlayer',
  'AdvanceAnimationPlayer',
  'EvaluateAnimationGraph',
  'Camera',
  'MeshFilter',
  'MeshRenderer',
  'DirectionalLight',
  'PointLight',
  'SpotLight',
  'Layer',
  'SortKey',
  'Instances',
  'PostProcessParams',
  'Renderer',
  legacyCreateOptionType,
  legacyBackendType,
  'RendererLostInfo',
  'RendererLostListener',
  'RenderError',
  'RenderErrorCode',
]);

const SKIP = new Set(['node_modules', '.git', 'dist', '.forgeax-harness', 'report']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);

const DOMAIN_DEPENDENCY = new Map([
  ...['ChildOf', 'Children', 'Name', 'Transform', 'scenePlugin', 'propagateTransforms'].map(
    (symbol) => [symbol, '@forgeax/engine-scene'],
  ),
  ...['Skin', 'resolveSkinJoints'].map((symbol) => [symbol, '@forgeax/engine-skinning']),
  ...[
    'AnimationPlayer',
    'animationPlugin',
    'defineAnimationGraph',
    'describeAnimationGraph',
    'serializeAnimationGraph',
    'evaluateAnimationGraph',
    'advanceAnimationPlayer',
    'AdvanceAnimationPlayer',
    'EvaluateAnimationGraph',
  ].map((symbol) => [symbol, '@forgeax/engine-animation']),
  ...[
    'Camera',
    'MeshFilter',
    'MeshRenderer',
    'DirectionalLight',
    'PointLight',
    'SpotLight',
    'Layer',
    'SortKey',
    'Instances',
    'PostProcessParams',
    'Renderer',
    legacyCreateOptionType,
    legacyBackendType,
    'RendererLostInfo',
    'RendererLostListener',
    'RenderError',
    'RenderErrorCode',
  ].map((symbol) => [symbol, '@forgeax/engine-render']),
]);

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else if (EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) out.push(path);
  }
  return out;
}

function symbolsInBindings(bindings) {
  const symbols = [];
  for (const token of bindings.split(',')) {
    const match = token.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)/);
    if (match && LEGACY_AUTHORITY.has(match[1])) symbols.push(match[1]);
  }
  return symbols;
}

function add(rows, root, file, channel, symbol, line) {
  rows.push({ file: relative(root, file), channel, symbol, line });
}

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function readPackageManifest(root, file) {
  let directory = file;
  while (directory.startsWith(root)) {
    const candidate = join(directory, 'package.json');
    try {
      return { path: candidate, package: JSON.parse(readFileSync(candidate, 'utf8')) };
    } catch {
      const parent = directory.slice(0, directory.lastIndexOf('/'));
      if (parent === directory) break;
      directory = parent;
    }
  }
  return undefined;
}

export function inventory(rootDirectory) {
  const root = resolve(rootDirectory);
  const rows = [];
  const manifests = [];
  for (const file of walk(root)) {
    // These files contain fixture strings that exercise this scanner; they are
    // not repository consumers and must not inflate the source inventory.
    if (
      file.endsWith('/scripts/check-runtime-cutover.mjs') ||
      file.endsWith('/scripts/__tests__/check-runtime-cutover.unit.test.ts')
    )
      continue;
    const text = withoutComments(readFileSync(file, 'utf8'));
    const lines = text.split(/\r?\n/);
    const lineOf = (offset) => text.slice(0, offset).split(/\r?\n/).length;

    const staticPattern =
      /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s*['"]@forgeax\/engine-runtime['"]/g;
    for (const match of text.matchAll(staticPattern)) {
      const channel = match[0].startsWith('export') ? 're-export' : 'static';
      for (const symbol of symbolsInBindings(match[1]))
        add(rows, root, file, channel, symbol, lineOf(match.index));
    }

    const dynamicPattern =
      /import\(\s*['"]@forgeax\/engine-runtime['"]\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g;
    for (const match of text.matchAll(dynamicPattern)) {
      if (LEGACY_AUTHORITY.has(match[1]))
        add(rows, root, file, 'dynamic', match[1], lineOf(match.index));
    }
    const erasedPattern =
      /import\(\s*['"]@forgeax\/engine-runtime['"]\s*\s*\)\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
    for (const match of text.matchAll(erasedPattern)) {
      if (LEGACY_AUTHORITY.has(match[1]))
        add(rows, root, file, 'type-erased', match[1], lineOf(match.index));
    }
    const destructuredPattern =
      /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]@forgeax\/engine-runtime['"]\s*\)/g;
    for (const match of text.matchAll(destructuredPattern)) {
      for (const symbol of symbolsInBindings(match[1]))
        add(rows, root, file, 'dynamic', symbol, lineOf(match.index));
    }
    if (
      file !== join(root, 'package.json') &&
      file.endsWith('/package.json') &&
      text.includes('"@forgeax/engine-runtime"')
    ) {
      manifests.push(file);
    }
    // Catch the common `const runtime = await import(...); runtime.Transform`
    // form used by smoke fixtures without treating retained factory members as
    // legacy authority.
    const namespacePattern = /(?:runtime|engine|pkg)\s*\.\s*([A-Za-z_$][\w$]*)/g;
    if (
      text.includes("import('@forgeax/engine-runtime')") ||
      text.includes('import("@forgeax/engine-runtime")')
    ) {
      for (const match of text.matchAll(namespacePattern)) {
        if (LEGACY_AUTHORITY.has(match[1]))
          add(rows, root, file, 'dynamic', match[1], lineOf(match.index));
      }
    }
    void lines;
  }
  for (const file of manifests) {
    const manifest = readPackageManifest(root, file)?.package;
    if (!manifest) continue;
    const packageRoot = file.slice(0, -'/package.json'.length);
    const sourceRows = rows.filter((row) => {
      const absolute = join(root, row.file);
      return (
        absolute.startsWith(`${packageRoot}/`) &&
        row.channel !== 'manifest' &&
        row.channel !== 'template-manifest'
      );
    });
    const declared = new Set(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      }),
    );
    for (const dependency of new Set(
      sourceRows
        .map((row) => DOMAIN_DEPENDENCY.get(row.symbol))
        .filter((dependency) => dependency && !declared.has(dependency)),
    )) {
      add(
        rows,
        root,
        file,
        file.includes('/templates/') ? 'template-manifest' : 'manifest',
        dependency,
        1,
      );
    }
  }
  return rows;
}

export function formatInventory(rows) {
  if (!rows.length) return '[ok] runtime authority cutover inventory clean (0 findings)\n';
  const grouped = new Map();
  for (const row of rows) {
    const key = row.channel;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  let output = `[fail] runtime authority cutover inventory: ${rows.length} finding(s)\n`;
  for (const [channel, findings] of grouped) {
    output += `\n[${channel}] ${findings.length}\n`;
    for (const row of findings) output += `- ${row.file}:${row.line} ${row.symbol}\n`;
  }
  return output;
}

/**
 * Produce the M6 hand-off checklist before the destructive consumer cutover.
 * This is intentionally a preflight (it reports current findings instead of
 * claiming the final gate): the migration task owns the findings, while the
 * final inventory remains the proof after all consumers move.
 */
export function preflight(rootDirectory) {
  const root = resolve(rootDirectory);
  const rows = inventory(root);
  const channelCounts = Object.fromEntries(
    [...new Set(rows.map((row) => row.channel))]
      .sort()
      .map((channel) => [channel, rows.filter((row) => row.channel === channel).length]),
  );
  const packageNames = ['scene', 'skinning', 'animation', 'render'];
  const packageChecks = packageNames.map((name) => {
    const path = join(root, 'packages', name, 'package.json');
    return {
      package: name,
      present: statSafe(path),
      hasMetrics: statSafe(path) && /"metrics"/.test(readFileSync(path, 'utf8')),
    };
  });
  let references = [];
  try {
    const config = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
    references = (config.references ?? [])
      .map((entry) => entry.path)
      .filter((path) => packageNames.some((name) => path.endsWith(`/packages/${name}`)));
  } catch {
    references = [];
  }
  return {
    inventory: { total: rows.length, channels: Object.keys(channelCounts), channelCounts },
    packageChecks,
    tsconfigReferences: references.sort(),
    metricsSchema: statSafe(join(root, 'schemas/forgeax-metrics.schema.json')),
    followUp: [
      'm6t5 consumer cutover',
      'm6t6 documentation and routing',
      'm6t8 governance lock',
      'm6t10 final sweep',
    ],
  };
}

function statSafe(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const preflightMode = process.argv.includes('--preflight');
  const rootIndex = process.argv.indexOf('--root');
  const rootArg = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
  if (preflightMode) {
    process.stdout.write(`${JSON.stringify(preflight(rootArg), null, 2)}\n`);
    process.exitCode = 0;
  } else {
    const rows = inventory(rootArg);
    process.stdout.write(formatInventory(rows));
    process.exitCode = rows.length ? 1 : 0;
  }
}
