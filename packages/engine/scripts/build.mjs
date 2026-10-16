import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicEngineFacades, publicEngineMembers } from './public-facades.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const dist = resolve(packageRoot, 'dist');
const check = process.argv.includes('--check');
const members = await publicEngineMembers(repositoryRoot);

const expectedDependencyNames = members.map(({ name }) => name).sort();
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const actualDependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
if (JSON.stringify(expectedDependencyNames) !== JSON.stringify(actualDependencyNames)) {
  throw new Error('engine-facade-dependency-drift: package dependencies must match public members');
}
if (check) process.exit(0);

// Facades are independent forwarding modules. Build their complete inventory
// before publication; replacing each file atomically keeps concurrent readers
// from observing a missing directory or a truncated module.
const outputs = new Map([
  ['index.mjs', "export * from '@forgeax/engine-runtime';\n"],
  ['index.d.ts', "export * from '@forgeax/engine-runtime';\n"],
  ['bin/forgeax.mjs', "#!/usr/bin/env node\nimport '@forgeax/engine-devkit/cli';\n"],
]);
for (const { source, subpath, hasDefault } of publicEngineFacades(members)) {
  const defaultExport = hasDefault ? `export { default } from '${source}';\n` : '';
  const facadeSource = `${defaultExport}export * from '${source}';\n`;
  outputs.set(`facades/${subpath}.mjs`, facadeSource);
  outputs.set(`facades/${subpath}.d.ts`, facadeSource);
}
const staging = await mkdtemp(resolve(packageRoot, '.facade-build-'));
try {
  for (const [path, content] of outputs) {
    const staged = resolve(staging, path);
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, content, { mode: path === 'bin/forgeax.mjs' ? 0o755 : 0o644 });
  }
  for (const [path, content] of outputs) {
    const target = resolve(dist, path);
    const previous = await readFile(target, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (previous === content) continue;
    await mkdir(dirname(target), { recursive: true });
    await rename(resolve(staging, path), target);
  }
  // Retire old public paths only after the new inventory has been published.
  // Empty directories are harmless; leaving them avoids racing another builder.
  async function retire(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await retire(resolve(directory, entry.name), `${path}/`);
      else if (!outputs.has(path)) await rm(resolve(directory, entry.name), { force: true });
    }
  }
  await retire(dist);
} finally {
  await rm(staging, { recursive: true, force: true });
}
