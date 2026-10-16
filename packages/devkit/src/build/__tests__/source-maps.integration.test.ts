import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../execution-workers.js';
import { pluginRuntimeProjection } from '../plugin-programs.js';

it.each([
  'worker',
  'pack',
] as const)('retains original %s source locations after production transforms', async (kind) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-hidden-map-'));
  const marker = 'authored-location-proof';
  const source =
    kind === 'worker'
      ? `export function probe() { const worker = new Worker(new URL('./engine-worker-runtime.mjs', import.meta.url), { type: 'module' }); return '${marker}'; }\n`
      : `import { definePack } from '@forgeax/engine/pack/source';\nexport default definePack({\n  authoringOnly: true,\n});\nexport function probe() { return '${marker}'; }\n`;
  const filename = kind === 'worker' ? 'entry.mjs' : 'owner.pack.ts';
  try {
    await writeFile(resolve(root, filename), source);
    await writeFile(resolve(root, 'engine-worker-runtime.mjs'), 'export const workerValue = 7;\n');
    if (kind === 'pack')
      await writeFile(
        resolve(root, 'entry.mjs'),
        `export { probe } from ${JSON.stringify(`${resolve(root, 'owner.pack.ts')}?forgeax-plugin-runtime`)};\n`,
      );
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries([]), pluginRuntimeProjection(root)],
      build: {
        outDir: resolve(root, 'dist'),
        target: 'esnext',
        minify: false,
        sourcemap: 'hidden',
        rollupOptions: {
          input: resolve(root, 'entry.mjs'),
          preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'entry.js' },
        },
      },
    });
    const code = await readFile(resolve(root, 'dist/entry.js'), 'utf8');
    const payload = JSON.parse(await readFile(resolve(root, 'dist/entry.js.map'), 'utf8'));
    expect(code).not.toContain('sourceMappingURL=');
    const offset = code.indexOf(marker);
    expect(offset).toBeGreaterThanOrEqual(0);
    const lines = code.slice(0, offset).split('\n');
    const entry = new SourceMap(payload).findEntry(lines.length - 1, lines.at(-1)?.length ?? 0);
    if (!('originalSource' in entry)) throw new Error('authored source mapping is missing');
    expect(entry.originalSource?.split('?')[0]).toMatch(
      new RegExp(`/${filename.replaceAll('.', '\\.')}$`),
    );
    const original = source.slice(0, source.indexOf(marker)).split('\n');
    expect(entry.originalLine).toBe(original.length - 1);
    expect(Math.abs(entry.originalColumn - (original.at(-1)?.length ?? 0))).toBeLessThanOrEqual(1);
    expect(payload.sourcesContent).toContain(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
