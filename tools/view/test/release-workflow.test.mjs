import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
test('Engine owns the install graph and official product publisher', () => {
 for (const path of ['../pnpm-lock.yaml','../pnpm-workspace.yaml','../.github/workflows/release.yml','../scripts/release-npm.mjs']) assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
 const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
 assert.equal(manifest.scripts.release, undefined);
 assert.equal(manifest.private, true);
 assert.equal(manifest.publishConfig, undefined);
 assert.equal(manifest.exports['./host.pack.json'], './host.pack.json');
 assert.equal(manifest.dependencies['@forgeax/engine'], 'workspace:*');
 for (const path of ['../.changeset/README.md', '../.changeset/config.json']) {
  assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
 }
});
