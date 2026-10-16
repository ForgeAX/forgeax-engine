import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('validates a persisted large JSON array within its reader heap without a second array', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-readback-'));
  try {
    // Run the actual current DdcEntryStore in a bounded fresh Node process,
    // independently of Vite's instrumented heap and package dist freshness.
    const moduleRoot = join(root, 'modules');
    await mkdir(moduleRoot);
    await writeFile(join(moduleRoot, 'package.json'), '{"type":"module"}');
    for (const name of ['entry-store', 'canonical-json', 'key', 'errors']) {
      const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8');
      await writeFile(
        join(moduleRoot, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      );
    }
    const key = 'a'.repeat(64);
    const values = 8_000_000;
    const directory = join(root, 'entries', key);
    await mkdir(join(directory, 'artifacts'), { recursive: true });
    // Prepare ordinary persisted JSON outside the reader's heap. All field
    // orders are canonical; the read must validate every existing identity.
    const payload = `{"values":[${'0,'.repeat(values - 1)}0]}`;
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const guid = 'owned-array-memory';
    const output = `{"artifacts":{},"guid":"${guid}","payload":${payload},"refs":[]}`;
    const receipt = {
      guid,
      inputFingerprint: 'fixed-input',
      key,
      outputDigest: `sha256:${hash(output)}`,
      producer: 'readback-regression',
    };
    const receiptJson = JSON.stringify(receipt);
    const entry = `{"artifacts":{},"guid":"${guid}","key":"${key}","payload":${payload},"receipt":${receiptJson},"refs":[]}`;
    for (const [name, text] of Object.entries({
      payload,
      refs: '[]',
      receipt: receiptJson,
      artifacts: '{}',
      integrity: JSON.stringify({
        artifacts: {},
        entry: hash(entry),
        payload: hash(payload),
        receipt: hash(receiptJson),
        refs: hash('[]'),
      }),
    })) {
      await writeFile(join(directory, `${name}.json`), text);
    }
    const script = join(root, 'read.mjs');
    await writeFile(
      script,
      `
      import assert from 'node:assert/strict';
      import { DdcEntryStore } from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'entry-store.js')).href)};
      const result = await new DdcEntryStore(${JSON.stringify(root)}).readChecked(${JSON.stringify(key)});
      assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
      assert.notEqual(result.value, null);
      assert.deepEqual(result.value.receipt, ${JSON.stringify(receipt)});
      assert.equal(result.value.payload.values.length, ${values});
      assert.equal(result.value.payload.values.every(value => value === 0), true);
      console.log('complete integrity accepted');
    `,
    );
    // Keep transient nursery allocations bounded as well as the 96 MiB reader
    // heap. A duplicated eight-million-element array still exhausts this bound.
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=96', '--max-semi-space-size=1', script],
      {
        encoding: 'utf8',
        timeout: 25_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('complete integrity accepted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
