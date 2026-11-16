import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createHostAssembly } from '@forgeax/engine-host/protocol';
import type { Plugin } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('keeps captured WGSL edits in asset publication under an immutable external frontend', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-gpu-shader-hmr-')));
  const backend = await createBackendHost();
  let lifecycle: Plugin | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'gpu-shader-hmr',
        name: 'GPU shader HMR',
        roots: {},
      }),
    );
    const shader = resolve(root, 'assets/paint.wgsl');
    await writeFile(
      shader,
      '#define_import_path fixture::paint\n@fragment fn paint() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
    );
    const frontend = resolve(root, 'frontend.mjs');
    await writeFile(frontend, 'export default { apply() {} };');
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve', '/', {
      host: {
        backend,
        frontendModule: { specifier: pathToFileURL(frontend).href },
        frontendAssembly: createHostAssembly({
          root: { program: 'fixture:frontend#root', codeRevision: 'immutable-one' },
        }),
      },
    });
    lifecycle = config.plugins
      ?.flat()
      .find(
        (plugin): plugin is Plugin =>
          !!plugin &&
          typeof plugin === 'object' &&
          'name' in plugin &&
          plugin.name === 'forgeax:project-session',
      );
    if (typeof lifecycle?.hotUpdate !== 'function') throw new Error('Project HMR owner missing');
    await writeFile(shader, 'invalid shader candidate');
    await expect(
      lifecycle.hotUpdate.call(
        { environment: { name: 'client' } } as never,
        { file: shader, server: { moduleGraph: { getModulesByFile: () => [] } } } as never,
      ),
    ).resolves.toEqual([]);
  } finally {
    if (typeof lifecycle?.closeBundle === 'function') await lifecycle.closeBundle.call({} as never);
    await backend.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
