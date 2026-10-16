import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { publishCanonicalKit } from '../../../packages/preview/scripts/build-canonical-kit.mjs';

const root = resolve(import.meta.dirname, '../../..');
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('publishes a public canonical fallback with its own receipt over a previous environment', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'forgeax-canonical-publication-'));
  try {
    const checkout = join(temporary, 'checkout');
    const preview = join(checkout, 'packages/preview');
    const script = join(preview, 'scripts/build-canonical-kit.mjs');
    const packageKit = join(preview, 'assets/canonical-kit');
    const stage = join(temporary, 'stage');
    await mkdir(join(preview, 'scripts'), { recursive: true });
    await mkdir(packageKit, { recursive: true });
    await copyFile(join(root, 'packages/preview/scripts/build-canonical-kit.mjs'), script);
    await copyFile(
      join(root, 'packages/preview/assets/canonical-kit/sky.hdr.meta.json'),
      join(packageKit, 'sky.hdr.meta.json'),
    );
    await writeFile(join(checkout, '.forgeax-public-distribution'), 'public SDK\n');
    await writeFile(join(packageKit, 'cook-receipt.json'), '{"previousEnvironment":true}\n');
    await promisify(execFile)(process.execPath, [script], {
      cwd: checkout,
      env: { ...process.env, FORGEAX_CANONICAL_KIT_OUTPUT: stage, FORGEAX_SDK_BUILD: '1' },
    });

    await publishCanonicalKit(stage, packageKit);

    const receiptBytes = await readFile(join(packageKit, 'cook-receipt.json'));
    assert.deepEqual(receiptBytes, await readFile(join(stage, 'cook-receipt.json')));
    const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.source.sourceKey, 'forgeax-generated://canonical-kit/sky.hdr');
    assert.equal(receipt.source.digest, digest(await readFile(join(packageKit, 'sky.hdr'))));
    assert.equal(
      receipt.source.metaDigest,
      digest(await readFile(join(packageKit, 'sky.hdr.meta.json'))),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
