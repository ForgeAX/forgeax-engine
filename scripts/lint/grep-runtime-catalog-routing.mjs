#!/usr/bin/env node
// Keep app catalog selection and Pack dev routing on one SSOT helper. A Pack
// dev host needs the same scope/generation-bound RuntimeAssetBinding as the
// browser AssetRegistry; a global `/pack-index.json` request is intentionally
// disabled in development and otherwise becomes a noisy 404.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appsRoot = resolve(repoRoot, 'apps');
const violations = [];
// Feature Lab rows that exercise the runtime catalog binding API itself (binding
// construction, scoped refresh, sourceKey-identified texture residency) own a
// standalone binding by design; every other app routes through the shared helper.
const catalogBindingFixtures = new Set([
  'apps/feature-lab/src/features/post-processing/3d-lut-color-grading.ts',
  'apps/feature-lab/src/node-features/asset-identity/hot-content-catalog-refresh.ts',
  'apps/feature-lab/src/node-features/asset-identity/runtime-binding-ssot.ts',
  'apps/feature-lab/src/node-features/import-loading/dev-pack-routes.ts',
]);

function sourceWithoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function visitSourceFiles(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '__tests__'].includes(entry.name)) continue;
      visitSourceFiles(path, files);
      continue;
    }
    if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') files.push(path);
  }
}

function visitAppConfigs(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', 'shared'].includes(entry.name)) continue;
      visitAppConfigs(path);
      continue;
    }
    if (entry.name !== 'vite.config.ts') continue;

    const config = readFileSync(path, 'utf8');
    const packHost = /\b(?:pluginPack|optionalAssetPack)\s*\(/.test(config);
    const appDir = dirname(path);
    const sourceFiles = [];
    const srcDir = resolve(appDir, 'src');
    try {
      visitSourceFiles(srcDir, sourceFiles);
    } catch {
      // A config without a source tree is still checked for Pack host binding.
    }

    if (packHost && !/(?:const|let|var)\s+runtimeBinding\s*=|\bruntimeBinding\s*:/.test(config)) {
      violations.push(`${relative(repoRoot, path)}: Pack dev host must pass runtimeBinding`);
    }

    for (const sourcePath of sourceFiles) {
      const source = sourceWithoutComments(readFileSync(sourcePath, 'utf8'));
      const sourceLabel = relative(repoRoot, sourcePath).replaceAll('\\', '/');
      const hasRuntimeBindingCall = /\bconfigureRuntimeBinding\s*\(/.test(source);
      const hasStaticCatalogCall = /\bconfigurePackIndex\s*\(/.test(source);
      const hasDirectDevTransport = /\bcreateDevImportTransport\s*\(/.test(source);
      const hasStandaloneBindingConstruction = /\bcreateStandaloneRuntimeAssetBinding\s*\(/.test(
        source,
      );
      const bindingFixture = catalogBindingFixtures.has(sourceLabel);
      if (hasRuntimeBindingCall && !bindingFixture) {
        violations.push(
          `${sourceLabel}: call configureRuntimeAssetCatalog(...) instead of configureRuntimeBinding(...)`,
        );
      }
      if (hasStandaloneBindingConstruction && !bindingFixture) {
        violations.push(
          `${sourceLabel}: app source must consume runtimeBinding from @forgeax/apps-shared/asset-runtime-config; do not construct a second binding`,
        );
      }
      if (hasDirectDevTransport) {
        violations.push(
          `${sourceLabel}: app source must use the Pack-owned runtime transport projection; do not import createDevImportTransport directly`,
        );
      }
      const customCatalogFixture = sourceLabel === 'apps/hello/video-texture/src/index.ts';
      if (hasStaticCatalogCall && !customCatalogFixture) {
        violations.push(
          `${sourceLabel}: app source cannot use direct configurePackIndex(...); use configureRuntimeAssetCatalog(...)`,
        );
      }
    }
  }
}

visitAppConfigs(appsRoot);

if (violations.length > 0) {
  console.error('grep-runtime-catalog-routing: FAIL');
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    'Use configureRuntimeAssetCatalog(assets, runtimeBinding) so development selects the scoped binding and production selects the emitted static catalog.',
  );
  process.exit(1);
}

console.log(
  'grep-runtime-catalog-routing: pass (Pack hosts and app registries share scoped catalog routing)',
);
