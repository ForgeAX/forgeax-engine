import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readSdkNpmArtifacts } from '../../../packages/audio-webaudio/bench/music/sdk-package-registry.mjs';

const version = '0.0.0-pr.bundle-fixture';
async function fixture(options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'roi23-bundle-regression-'));
  const source = resolve(root, 'source'),
    packages = resolve(root, 'npm/packages');
  await mkdir(resolve(source, 'package/node_modules/@forgeax/engine-audio'), { recursive: true });
  await mkdir(packages, { recursive: true });
  const name = '@forgeax/engine-audio';
  const manifest = {
    name: '@forgeax/engine',
    version,
    dependencies: { [name]: options.edgeVersion ?? version },
    bundledDependencies: options.unbundled ? [] : [name],
  };
  await writeFile(resolve(source, 'package/package.json'), JSON.stringify(manifest));
  await writeFile(
    resolve(source, 'package/index.mjs'),
    "export { identity } from './node_modules/@forgeax/engine-audio/index.mjs';",
  );
  if (!options.missing) {
    await writeFile(
      resolve(source, 'package/node_modules/@forgeax/engine-audio/package.json'),
      JSON.stringify({ name, version, type: 'module' }),
    );
    await writeFile(
      resolve(source, 'package/node_modules/@forgeax/engine-audio/index.mjs'),
      'export const identity = 7;',
    );
  }
  const archive = resolve(packages, 'engine.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, 'package']);
  const sha = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const checksums = resolve(root, 'SHA256SUMS');
  await writeFile(
    checksums,
    `${options.badChecksum ? '0'.repeat(64) : sha}  npm/packages/engine.tgz\n`,
  );
  return {
    root,
    source,
    archive,
    input: { packageArchives: packages, checksumsFile: checksums, expectedVersion: version },
  };
}
test('admits a real umbrella bundle and consumes its focused owner from freshly unpacked bytes', async () => {
  const f = await fixture();
  try {
    const rows = await readSdkNpmArtifacts(f.input);
    assert.deepEqual(
      rows.map((row) => row.name),
      ['@forgeax/engine'],
    );
    const consumer = resolve(f.root, 'fresh-consumer');
    await mkdir(consumer);
    execFileSync('tar', ['-xzf', f.archive, '-C', consumer]);
    assert.equal(
      (await import(pathToFileURL(resolve(consumer, 'package/index.mjs')).href)).identity,
      7,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
for (const [name, options, error] of [
  ['missing physical bundle', { missing: true }, /sdk-npm-bundled-package-missing/],
  ['unbundled unpublished owner', { unbundled: true }, /sdk-npm-artifact-closure-mismatch/],
  ['wrong pinned edge', { edgeVersion: '0.0.0-wrong' }, /sdk-npm-artifact-closure-mismatch/],
  ['changed archive bytes', { badChecksum: true }, /sdk-npm-artifact-checksum-mismatch/],
])
  test(`rejects ${name}`, async () => {
    const f = await fixture(options);
    try {
      await assert.rejects(readSdkNpmArtifacts(f.input), error);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
