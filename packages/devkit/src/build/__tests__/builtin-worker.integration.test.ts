import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('bundles the public builtin entry in a default IIFE Worker and executes it', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-builtin-worker-')));
  try {
    const repository = resolve(import.meta.dirname, '../../../../..');
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(repository, 'packages/engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'junction',
    );
    await writeFile(resolve(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await writeFile(
      resolve(root, 'main.js'),
      "new Worker(new URL('./worker.js', import.meta.url));",
    );
    await writeFile(
      resolve(root, 'worker.js'),
      `import { BUILTIN_MESH_ASSETS, deriveBuiltin } from '@forgeax/engine/pack/builtin';
       self.postMessage({ guids: BUILTIN_MESH_ASSETS.map(row => row.guid),
         synchronous: deriveBuiltin('HANDLE_CUBE') instanceof Uint8Array });`,
    );
    const output = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, minify: false, target: 'es2022' },
    });
    if ('close' in output) throw new Error('unexpected Vite watch build');
    const emitted = (Array.isArray(output) ? output : [output]).flatMap((item) => item.output);
    const worker = emitted.find(
      (item) => item.type === 'asset' && /worker-.*\.js$/.test(item.fileName),
    );
    if (worker?.type !== 'asset') throw new Error('Vite did not emit the Worker');
    let result: unknown;
    runInNewContext(
      typeof worker.source === 'string' ? worker.source : new TextDecoder().decode(worker.source),
      {
        TextEncoder,
        Uint8Array,
        self: {
          postMessage(value: unknown) {
            result = value;
          },
        },
      },
    );
    expect(result).toEqual({
      synchronous: true,
      guids: [
        'cbe42beb-8975-5096-b3a1-3dda4cb4c077',
        '22592f07-d967-5116-b29c-fa9781929ba8',
        '339338aa-a338-581c-9fc5-744267ef8a51',
        '95730fd2-9846-5f84-8658-0b3c971eb263',
        '692d38b4-8cac-5fb2-9dcf-f389e076d6bf',
        'ab20af21-0764-55be-a7f2-b80ab3d46a0a',
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
