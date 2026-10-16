// @perf-budget-skip: resolves the generated native module closure through Vite.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { gameVfxSource } from '../../game-vfx-source.js';
import { createViteConfig } from '../../host.js';
import { readProjectFacts } from '../../project.js';

it('includes and bundles the shared VFX module from the ordinary WeChat generated entry', async () => {
  const root = await mkdtemp(resolve(import.meta.dirname, '../../../..', '.wechat-vfx-fixture-'));
  let config: Awaited<ReturnType<typeof createViteConfig>> | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"wechat-vfx","type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'wechat-vfx',
        name: 'WeChat VFX',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    config = await createViteConfig(facts.value, 'build', './', {
      target: 'wechat',
    });
    const generated = config.root ?? '';
    const host = await readFile(resolve(generated, 'wechat-main.ts'), 'utf8');
    const shared = await readFile(resolve(generated, 'game-vfx.ts'), 'utf8');
    expect(shared).toBe(gameVfxSource);
    const imported = host.match(/^import \{ createGameVfx \} from '\.\/game-vfx';$/m)?.[0];
    expect(imported).toBeDefined();
    const entry = resolve(generated, 'wechat-vfx-entry.ts');
    await writeFile(entry, `${imported}\nexport { createGameVfx };`);
    const target = config.build?.target;
    if (target === undefined) throw new Error('Expected an explicit native syntax target');
    const result = await build({
      configFile: false,
      root: generated,
      ...(config.resolve === undefined ? {} : { resolve: config.resolve }),
      logLevel: 'silent',
      build: {
        target,
        write: false,
        minify: false,
        rollupOptions: {
          input: entry,
          preserveEntrySignatures: 'strict',
          output: { format: 'cjs' },
        },
      },
    });
    if (Array.isArray(result) || !('output' in result))
      throw new Error('Expected one native bundle');
    const chunk = result.output.find((item) => item.type === 'chunk' && item.isEntry);
    if (chunk?.type !== 'chunk') throw new Error('Missing bundled native VFX entry');
    const output = resolve(root, 'vfx-bundle');
    await mkdir(output);
    await writeFile(resolve(output, 'package.json'), '{"type":"commonjs"}');
    for (const item of result.output) {
      const path = resolve(output, item.fileName);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, item.type === 'chunk' ? item.code : item.source);
    }
    const exports = createRequire(import.meta.url)(resolve(output, chunk.fileName)) as {
      createGameVfx(): { feature: { identity: string }; plugin: { name: string } };
    };
    const first = exports.createGameVfx();
    const second = exports.createGameVfx();
    expect(first.plugin.name).toBe('forgeax:game-vfx');
    expect(first.feature.identity).toBe('forgeax.vfx-render.gpu-particles');
    expect(second.feature).not.toBe(first.feature);
  } finally {
    for (const plugin of config?.plugins ?? []) {
      if (
        plugin &&
        typeof plugin === 'object' &&
        'closeBundle' in plugin &&
        typeof plugin.closeBundle === 'function'
      )
        await plugin.closeBundle.call({} as never);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
