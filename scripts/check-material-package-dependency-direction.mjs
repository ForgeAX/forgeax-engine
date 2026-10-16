#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scopeIndex = process.argv.indexOf('--scope');
const scope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : 'vite-plugin-pack';
if (!['vite-plugin-pack', 'gltf'].includes(scope)) {
  throw new Error(`unsupported material package scope: ${scope}`);
}

if (scope === 'gltf') {
  const manifest = JSON.parse(
    await readFile(new URL('../packages/gltf/package.json', import.meta.url), 'utf8'),
  );
  const tsconfig = JSON.parse(
    await readFile(new URL('../packages/gltf/tsconfig.json', import.meta.url), 'utf8'),
  );
  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};
  const references = new Set((tsconfig.references ?? []).map((reference) => reference.path));

  if (!dependencies['@forgeax/engine-import']) {
    throw new Error('gltf must depend on @forgeax/engine-import in production');
  }
  if (!devDependencies['@forgeax/engine-assets-runtime']) {
    throw new Error('gltf must keep @forgeax/engine-assets-runtime test-only');
  }
  if (!devDependencies['@forgeax/engine-render']) {
    throw new Error('gltf must keep @forgeax/engine-render test-only');
  }
  if (dependencies['@forgeax/engine-assets-runtime'] || dependencies['@forgeax/engine-render']) {
    throw new Error('gltf test-only runtime packages must not be production dependencies');
  }
  if (!references.has('../import')) {
    throw new Error('gltf must reference import in tsconfig');
  }

  async function sourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
      else if (entry.name.endsWith('.ts') && !path.includes('/__tests__/')) files.push(path);
    }
    return files;
  }

  for (const file of await sourceFiles(
    fileURLToPath(new URL('../packages/gltf/src', import.meta.url)),
  )) {
    const source = await readFile(file, 'utf8');
    if (source.includes('@forgeax/engine-assets-runtime')) {
      throw new Error(`gltf production source imports test-only assets-runtime: ${file}`);
    }
    if (source.includes('@forgeax/engine-render')) {
      throw new Error(`gltf production source imports test-only render: ${file}`);
    }
  }

  console.log(`material package dependency direction: ${scope} OK`);
  process.exit(0);
}

const manifest = JSON.parse(
  await readFile(new URL('../packages/vite-plugin-pack/package.json', import.meta.url), 'utf8'),
);
const tsconfig = JSON.parse(
  await readFile(new URL('../packages/vite-plugin-pack/tsconfig.json', import.meta.url), 'utf8'),
);
const dependencies = manifest.dependencies ?? {};
const references = new Set((tsconfig.references ?? []).map((reference) => reference.path));

if (!dependencies['@forgeax/engine-pack']) {
  throw new Error('vite-plugin-pack must depend on @forgeax/engine-pack in production');
}
const forbiddenProducerDependencies = Object.keys(dependencies).filter((name) =>
  /^@forgeax\/engine-(animation|material|render|scene|shader|ui|vfx)/.test(name),
);
if (forbiddenProducerDependencies.length > 0) {
  throw new Error(
    `vite-plugin-pack must receive producer cookers from its Host, found production dependencies: ${forbiddenProducerDependencies.join(', ')}`,
  );
}
if (references.has('../shader-compiler')) {
  throw new Error('vite-plugin-pack must not reference shader-compiler in tsconfig');
}
if (
  manifest.peerDependencies?.['@forgeax/engine-pack'] ||
  manifest.devDependencies?.['@forgeax/engine-pack']
) {
  throw new Error('engine-pack must not be peer-only or dev-only');
}

console.log(`material package dependency direction: ${scope} OK`);
