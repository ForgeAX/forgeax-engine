import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { zstdCompressSync } from 'node:zlib';
import { prepareLodIncrementalInputs } from '../prepare-lod-incremental-inputs.mjs';
import { loadLodProducerInputs } from '../load-lod-producer-inputs.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('LOD producer admits plain and zstd publications with the same original program closure', {
  timeout: 30000,
}, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'forgeax-lod-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = await prepareLodIncrementalInputs({ output: resolve(directory, 'initial') });
  const programs = initial.shaderClosure.programs;
  assert.ok(programs.length > 0);
  const plain = Buffer.from(JSON.stringify({
    entries: [], materialShaders: programs.map((identifier) => ({ identifier })),
  }));
  for (const [id, bytes] of [['plain', plain], ['zstd', zstdCompressSync(plain)]]) {
    const manifestPath = resolve(directory, `${id}.json`);
    const output = resolve(directory, id);
    await writeFile(manifestPath, bytes);
    const prepared = await prepareLodIncrementalInputs({ output, shaderManifest: manifestPath });
    assert.deepEqual(prepared.roles, initial.roles);
    assert.equal(prepared.assets.length, 5);
    assert.deepEqual(prepared.shaderClosure.programs, programs);
    assert.equal(prepared.shaderClosure.status, 'cpu-publication-verified');
    assert.equal(prepared.shaderClosure.gpuReadiness, 'unverified');
    assert.equal(prepared.shaderClosure.publication.sha256, digest(bytes));
    assert.equal(prepared.shaderClosure.publication.byteLength, bytes.byteLength);
    assert.deepEqual(await readFile(resolve(output, 'shaders/manifest.json')), bytes);
    const loaded = await loadLodProducerInputs(output, { shaderManifest: manifestPath });
    assert.deepEqual(loaded.shaderBytes, bytes);
  }
  const incomplete = resolve(directory, 'missing.json');
  await writeFile(incomplete, zstdCompressSync(Buffer.from('{"entries":[],"materialShaders":[]}')));
  const rejected = resolve(directory, 'rejected');
  await assert.rejects(
    prepareLodIncrementalInputs({ output: rejected, shaderManifest: incomplete }),
    /missing an original material program/,
  );
  await assert.rejects(readFile(resolve(rejected, 'manifest.json')), { code: 'ENOENT' });
});

test('LOD runtime carries the verified publication bytes intact in its data URL', async () => {
  const source = await readFile(new URL('../smoke-dawn.mjs', import.meta.url), 'utf8');
  const expression = source.match(/const shaderManifestUrl = (.+);/)[1];
  const bytes = zstdCompressSync(Buffer.from('{"entries":[]}'));
  const url = runInNewContext(expression, { shaderBytes: bytes, Buffer });
  assert.match(url, /^data:application\/octet-stream;base64,/);
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), bytes);
  assert.match(source, /shaderManifestUrl,/);
});
