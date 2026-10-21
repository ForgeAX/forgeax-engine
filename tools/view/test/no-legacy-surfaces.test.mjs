import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const productionRoots = ['src', 'packages'];
const forbiddenFiles = [
  'src/backend/page-broker.mjs',
  'src/engine-devkit-host-adapter.mjs',
  'src/engine/carrier-adapter.mjs',
  'src/plugins/frontend.mjs',
  'src/plugins/identity.mjs',
  'src/plugins/inspector.mjs',
  'src/shared/carrier-contract.mjs',
  'src/shared/effects.mjs',
  'src/shell/registry.mjs',
  'packages/view-plugin-asset-references/src/runtime/program.ts',
  'packages/view-plugin-asset-references/src/runtime/query.ts',
  'scripts/asset-reference-program.mjs',
];
const forbiddenExports = [
  './backend/page-broker',
  './frontend',
  './plugins/identity',
  './plugins/inspector',
  './plugins/asset-references/runtime',
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    // Skip dependency and generated-bundle directories; the scan covers sources only.
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'storybook-static') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:mjs|js|ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function assertCurrentSource(source, name) {
  // Check concrete retired contracts, not prose such as an API's @deprecated tag.
  assert.doesNotMatch(source, /\b(?:viewWorkspaceClient|viewShell|workspaceConnection|revokeClient)\b/, name);
  assert.doesNotMatch(source, /(?:provide|get)\(\s*['"]viewWorkspace['"]/, name);
  assert.doesNotMatch(source, /view\.asset-references\.get|forgeax:view-asset-reference-query|__FORGEAX_(?:VIEW_)?ASSET_REFERENCE_PROGRAM__/, name);
  if (name.startsWith('packages/')) {
    assert.doesNotMatch(source, /(?:from\s*|import\s*(?:\(\s*)?)['"](?:\.\.\/)+src\//, name);
  }
}

describe('current architecture surfaces', () => {
  it('contains no retired services or root-source penetration', async () => {
    const files = (
      await Promise.all(productionRoots.map((directory) => sourceFiles(join(root, directory))))
    ).flat();
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const name = relative(root, file).replaceAll('\\', '/');
      assertCurrentSource(source, name);
    }
  });

  it('permits API migration documentation but rejects concrete retired contracts', () => {
    assert.doesNotThrow(() => assertCurrentSource('/** @deprecated compatibility alias for a legacy caller */', 'src/example.mjs'));
    for (const source of [
      'ctx.viewWorkspaceClient.call()', 'ctx.viewShell.mount()', 'workspaceConnection.close()',
      'revokeClient()', 'ctx.provide("viewWorkspace", {})', 'ctx.get("viewWorkspace")',
      'import "../../../src/private.mjs"',
    ]) {
      assert.throws(() => assertCurrentSource(source, 'packages/example/src/index.mjs'), { code: 'ERR_ASSERTION' });
    }
  });

  it('has removed facade files and retired package exports', async () => {
    const sourceFiles = await readdir(join(root, 'src', 'workspace')).catch(() => []);
    assert.deepEqual(sourceFiles, []);
    for (const path of forbiddenFiles.flatMap(path => [path, path.replace(/\.mjs$/, '.ts')])) {
      await assert.rejects(readFile(join(root, path), 'utf8'), { code: 'ENOENT' });
    }
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    for (const subpath of forbiddenExports) assert.equal(metadata.exports[subpath], undefined);
  });
});
