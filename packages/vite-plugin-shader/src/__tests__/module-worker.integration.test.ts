import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

it('builds module Workers with lazy runtime imports without per-app Worker configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-module-worker-'));
  try {
    await Promise.all([
      writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>'),
      writeFile(
        join(root, 'main.js'),
        "new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }).postMessage('load');",
      ),
      writeFile(
        join(root, 'worker.js'),
        "self.onmessage = async () => self.postMessage((await import('./runtime.js')).answer);",
      ),
      writeFile(join(root, 'runtime.js'), 'export const answer = 42;'),
    ]);
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [forgeaxShader({ engineEntries: false })],
      build: { write: false, minify: false },
    });
    if (Array.isArray(result) || !('output' in result)) throw new Error('expected one app build');
    const worker = result.output.find((file) => /^assets\/worker-.*\.js$/.test(file.fileName));
    const runtime = result.output.find((file) => /^assets\/runtime-.*\.js$/.test(file.fileName));
    expect(worker).toBeDefined();
    expect(runtime).toBeDefined();
    expect(worker?.type === 'asset' ? worker.source : worker?.code).toMatch(/import\(/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
