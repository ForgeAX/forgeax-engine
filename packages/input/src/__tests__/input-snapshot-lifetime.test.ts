import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { expect, it } from 'vitest';

it.each([
  false,
  true,
])('releases previous snapshots with minify=%s while the current snapshot stays readable', async (minify) => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-input-lifetime-'));
  try {
    await build({
      entry: { snapshot: fileURLToPath(new URL('../input-snapshot.ts', import.meta.url)) },
      outDir: directory,
      format: ['esm'],
      platform: 'node',
      config: false,
      dts: false,
      silent: true,
      minify,
      outExtension: () => ({ js: '.mjs' }),
    });
    const output = execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { snapshotFromSample, createEmptyInputBackendSample } from ${JSON.stringify(pathToFileURL(join(directory, 'snapshot.mjs')).href)};
      const refs = [];
      let current;
      for (let i = 0; i < 256; i++) {
        current = snapshotFromSample({ ...createEmptyInputBackendSample(),
          downKeys: new Set(['a']), downCodes: new Set(['KeyA']),
          buttons: [true, false, false] }, undefined, current);
        refs.push(new WeakRef(current));
      }
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
      }
      assert.equal(current.keyboard.down('a'), true);
      assert.equal(current.keyboard.justPressed('a'), false);
      assert.equal(current.keyboard.justPressedCode('KeyA'), false);
      assert.equal(current.mouse.button(0), true);
      assert.equal(current.mouse.justPressed(0), false);
      assert.equal(current.gamepad(0).connected, false);
      const retained = refs.slice(0, -1).filter(ref => ref.deref() !== undefined).length;
      console.log(JSON.stringify({ retained, currentReadable: true }));
    `,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(JSON.parse(output)).toEqual({ retained: 0, currentReadable: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
