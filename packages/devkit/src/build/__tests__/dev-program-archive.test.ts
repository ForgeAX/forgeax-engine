import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPackProgram } from '@forgeax/engine-pack/runtime';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { defined } from '../../__tests__/assert-defined.js';
import { markDevProgramResources } from '../dev-program-resources.js';
import { executionWorkerEntries } from '../execution-workers.js';
import { captureDevPluginPrograms } from '../plugin-programs-dev.js';

const resourceEvidence: Plugin = {
  name: 'test:dev-resource-evidence',
  configureServer(server) {
    markDevProgramResources(defined(server.environments.client).plugins);
  },
};

it.each([
  ['asset URL', "export default new URL('./image.png', import.meta.url).href;", true],
  [
    'Worker URL',
    "export default () => new Worker(new URL('./worker.js', import.meta.url), {type:'module'});",
    true,
  ],
  ['Worker import', "import worker from './worker.js?worker'; export default worker;", true],
  ['audio', "import audio from './sound.mp3'; export default audio;", true],
  ['CSS', "import './style.css'; export default 1;", true],
  ['authored HMR', 'if (import.meta.hot) import.meta.hot.accept(); export default 1;', true],
  ['WASM', "import init from './module.wasm?init'; export default init;", true],
  ['raw text', "import text from './image.svg?raw'; export default text;", false],
  ['plain string', "export default '/fake.svg';", false],
] as const)('uses actual producer evidence for %s', async (_name, source, resource) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-dev-resource-')));
  let server: ViteDevServer | undefined;
  try {
    await writeFile(resolve(root, 'entry.js'), source);
    await writeFile(resolve(root, 'image.png'), 'bytes');
    await writeFile(resolve(root, 'image.svg'), '<svg/>');
    await writeFile(resolve(root, 'sound.mp3'), 'bytes');
    await writeFile(resolve(root, 'style.css'), 'body { color: red; }');
    await writeFile(resolve(root, 'module.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeFile(resolve(root, 'worker.js'), 'self.onmessage = () => self.postMessage(1);');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [resourceEvidence],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    const captured = await captureDevPluginPrograms(
      server,
      new Map([['plugin', '/entry.js']]),
      'engine',
    );
    if (resource) expect(captured.archive.error).toContain('portable producer');
    else {
      expect(captured.archive.error).toBeUndefined();
      const program = defined(captured.archive.programs?.plugin);
      const value = (await loadPackProgram(program, {})).unwrap();
      expect(value).toBe(_name === 'raw text' ? '<svg/>' : '/fake.svg');
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  false,
  true,
])('protects shared Engine modules with Host HMR and resource URL present: %s', async (resource) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-dev-engine-shared-')));
  let server: ViteDevServer | undefined;
  try {
    for (const name of ['@forgeax/engine-extra', 'shared-lib']) {
      const directory = resolve(root, 'node_modules', name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, 'package.json'),
        JSON.stringify({ name, version: '1', type: 'module', exports: './index.js' }),
      );
      await writeFile(
        resolve(directory, 'index.js'),
        name === 'shared-lib'
          ? 'export const token = {};'
          : `${resource ? "export const binary = new URL('./module.wasm', import.meta.url);" : ''} export { token } from 'shared-lib'; if (import.meta.hot) import.meta.hot.accept();`,
      );
      if (resource && name !== 'shared-lib')
        await writeFile(
          resolve(directory, 'module.wasm'),
          new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
        );
    }
    await writeFile(
      resolve(root, 'entry.js'),
      "import { token as host } from '@forgeax/engine-extra'; import { token as direct } from 'shared-lib'; export default () => host === direct;",
    );
    expect((await import(pathToFileURL(resolve(root, 'entry.js')).href)).default()).toBe(true);
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [executionWorkerEntries([]), resourceEvidence],
      base: resource ? '/games/static/' : '/',
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    const captured = await captureDevPluginPrograms(
      server,
      new Map([['plugin', '/entry.js']]),
      'engine',
    );
    expect(captured.archive.error).toContain('Engine dependency');
    await writeFile(
      resolve(root, 'only-engine.js'),
      "import { token } from '@forgeax/engine-extra'; export default () => token;",
    );
    const independent = await captureDevPluginPrograms(
      server,
      new Map([['plugin', '/only-engine.js']]),
      'engine',
    );
    expect(independent.archive.error).toBeUndefined();
    expect(independent.archive.programs?.plugin).toBeDefined();
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
