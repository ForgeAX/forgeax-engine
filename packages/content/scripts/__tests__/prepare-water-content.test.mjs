import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseWaterContentArgs, prepareWaterContent } from '../prepare-water-content.mjs';

test('explicit Water source selection retains provenance admission outside the shared checkout', async () => {
  const sourceRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-water-export-source-'));
  const outputRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-water-export-'));
  try {
    const originalRoot = resolve('packages/content/assets/water');
    const provenance = JSON.parse(await readFile(resolve(originalRoot, 'provenance.json'), 'utf8'));
    for (const { file } of provenance.files)
      await copyFile(resolve(originalRoot, file), resolve(sourceRoot, file));
    const options = parseWaterContentArgs(['--source-root', sourceRoot]);
    assert.equal(options.sourceRoot, sourceRoot);
    const inputs = await prepareWaterContent({ ...options, outputRoot });
    assert.equal(inputs.length, 8);
    for (const { file, sha256 } of inputs)
      assert.equal(createHash('sha256').update(await readFile(resolve(outputRoot, file))).digest('hex'), sha256);
    await writeFile(resolve(outputRoot, inputs[0].file), 'altered authored source');
    await assert.rejects(prepareWaterContent({ sourceRoot: outputRoot, outputRoot }), /water-content-source-digest/);
    assert.throws(() => parseWaterContentArgs(['--source-root']), /usage:/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('prepares every original Water source with unchanged provenance bytes', async () => {
  const outputRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-water-content-'));
  try {
    const inputs = await prepareWaterContent({ outputRoot });
    assert.equal(inputs.length, 8);
    for (const { file, sha256 } of inputs) {
      const bytes = await readFile(resolve(outputRoot, file));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
    }
    await writeFile(resolve(outputRoot, inputs[0].file), 'changed source');
    await assert.rejects(prepareWaterContent({ sourceRoot: outputRoot, outputRoot }),
      /water-content-source-digest/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
