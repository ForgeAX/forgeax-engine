import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { expect, it } from 'vitest';

it('final release does not retain externally disposed payloads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-shared-ref-lifetime-'));
  try {
    await build({
      entry: { store: fileURLToPath(new URL('../shared-ref-store.ts', import.meta.url)) },
      outDir: directory,
      format: ['esm'],
      platform: 'node',
      noExternal: ['@forgeax/engine-types'],
      config: false,
      dts: false,
      silent: true,
      outExtension: () => ({ js: '.mjs' }),
    });
    const output = execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import { SharedRefStore } from ${JSON.stringify(pathToFileURL(join(directory, 'store.mjs')).href)};
      const store = new SharedRefStore();
      const refs = [];
      function releasePayload() {
        const payload = { bytes: new Uint8Array(4096) };
        const handle = store.alloc('MeshAsset', payload);
        refs.push(new WeakRef(payload));
        assert.equal(store.release(handle).unwrap().payload, payload);
      }
      for (let i = 0; i < 32; i++) releasePayload();
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
      }
      assert.equal(store._liveCount(), 0);
      console.log(JSON.stringify({ retained: refs.filter(ref => ref.deref()).length }));
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(JSON.parse(output)).toEqual({ retained: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
