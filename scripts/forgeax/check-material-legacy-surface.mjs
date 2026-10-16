import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const MATERIAL_LEGACY_PATTERNS = [
  { id: 'shader-asset', expression: /\bShaderAsset\b/ },
  { id: 'material-shader-registration', expression: /\bregisterMaterialShader\s*\(/ },
  { id: 'material-artifact-installation', expression: /\binstallMaterialArtifact\s*\(/ },
  { id: 'wgsl-sidecar', expression: /\.wgsl\.meta\.json/ },
  { id: 'param-values', expression: /\bparamValues\b/ },
  { id: 'global-uv-set', expression: /\buvSet\b/ },
  {
    id: 'pass-shader',
    expression:
      /\bpass(?:es)?\s*:\s*(?:\[\s*\{[\s\S]{0,160}?\bshader\s*:|\{\s*[\s\S]{0,160}?\bshader\s*:)/i,
  },
];

const CHANNELS = [
  { id: 'typescript-import', matches: (path) => /\.(?:ts|tsx|mts|cts)$/.test(path) },
  {
    id: 'script-fixture-literal',
    matches: (path) =>
      /\.(?:mjs|cjs)$/.test(path) ||
      /(?:^|\/)scripts(?:\/|$)/.test(path) ||
      /(?:^|\/)fixtures(?:\/|$)/.test(path),
  },
  {
    id: 'json-asset-literal',
    matches: (path) => /(?:\.pack|\.meta|\.config)\.json$/.test(path),
  },
];

const SKIPPED_DIRECTORIES = new Set(['.git', '.forgeax-harness', 'dist', 'node_modules']);
const INVENTORY_FILES = new Set([
  'scripts/check-material-contract-inventory.mjs',
  'scripts/material-contract-inventory.json',
  'scripts/forgeax/check-material-legacy-surface.mjs',
  'scripts/__tests__/material-legacy-inventory.test.mjs',
  'scripts/__tests__/material-legacy-zero.test.mjs',
  'scripts/__tests__/material-app-legacy-negative.test.mjs',
  'scripts/__tests__/catalog-documentation-material.test.mjs',
  'scripts/forgeax/check-catalog-docs.mjs',
]);

const ENGINE_REGISTRY_PATHS = [
  'packages/render/',
  'packages/shader/',
  'packages/vite-plugin-shader/',
  'packages/assets-runtime/',
];

export const CORE_SURFACE_PATHS = [
  'packages/types',
  'packages/render',
  'packages/shader',
  'packages/shader-compiler',
  'packages/pack',
  'packages/vite-plugin-pack',
  'packages/vite-plugin-shader',
  'packages/assets-runtime',
  'packages/runtime',
  'templates/game-3d',
  'scripts',
];

function walkFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, absolute, files);
    else if (entry.isFile()) files.push(relative(root, absolute).split('\\').join('/'));
  }
  return files;
}

function findPatternIds(source) {
  return MATERIAL_LEGACY_PATTERNS.filter(({ expression }) => expression.test(source)).map(
    ({ id }) => id,
  );
}

function isConsumerSource(file) {
  return /(?:^|\/)src\//.test(file) && !/(?:^|\/)__tests__(?:\/|$)/.test(file);
}

function isEngineRegistryPath(file) {
  return ENGINE_REGISTRY_PATHS.some((prefix) => file.startsWith(prefix));
}

export function scanMaterialLegacySurface(root = process.cwd(), options = {}) {
  const repoRoot = resolve(root);
  const hits = [];
  const channelFiles = new Map(CHANNELS.map(({ id }) => [id, []]));
  const scopePaths = options.paths ?? undefined;
  const scanRoots =
    scopePaths === undefined ? [repoRoot] : scopePaths.map((path) => resolve(repoRoot, path));

  const files = scanRoots.flatMap((scanRoot) => walkFiles(repoRoot, scanRoot));
  for (const file of [...new Set(files)].sort()) {
    if (INVENTORY_FILES.has(file)) continue;
    if (options.consumerOnly === true && !isConsumerSource(file)) continue;
    const channel = CHANNELS.find(({ matches }) => matches(file));
    if (channel === undefined) continue;
    const source = readFileSync(join(repoRoot, file), 'utf8');
    let patternIds = findPatternIds(source);
    if (options.allowInternalRegistry === true && isEngineRegistryPath(file)) {
      patternIds = patternIds.filter(
        (pattern) =>
          pattern !== 'material-shader-registration' &&
          pattern !== 'material-artifact-installation',
      );
    }
    if (patternIds.length === 0) continue;
    channelFiles.get(channel.id).push(file);
    hits.push({ channel: channel.id, path: file, patterns: patternIds });
  }

  for (const files of channelFiles.values()) files.sort();
  hits.sort((a, b) => a.path.localeCompare(b.path) || a.channel.localeCompare(b.channel));
  return {
    ok: hits.length === 0,
    channels: CHANNELS.map(({ id }) => [id, channelFiles.get(id)]),
    hits,
  };
}

if (import.meta.main) {
  const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  const report = scanMaterialLegacySurface(rootArg ?? process.cwd(), {
    ...(process.argv.includes('--core') ? { paths: CORE_SURFACE_PATHS } : {}),
    ...(process.argv.includes('--core') ? { allowInternalRegistry: true } : {}),
    // Core census covers the production consumer surface. Test fixtures keep
    // their explicit legacy registry setup so they can continue to exercise
    // the compatibility boundary without being mistaken for authoring code.
    ...(process.argv.includes('--core') ? { consumerOnly: true } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
