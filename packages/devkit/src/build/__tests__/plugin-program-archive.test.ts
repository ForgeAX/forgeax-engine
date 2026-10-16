import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { BrowserPluginProgramArchive } from '../plugin-programs-browser.js';

it.each([
  'image',
  'public-image',
  'css',
  'worker',
  'worker-url',
] as const)('refuses a partial portable program when Vite emits a %s resource', async (kind) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-resource-')));
  try {
    await mkdir(resolve(root, 'public'));
    await writeFile(resolve(root, 'public/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(
      resolve(root, 'main.js'),
      "import plugin from './plugin.js'; globalThis.plugin = plugin;",
    );
    await writeFile(
      resolve(root, 'image.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
    );
    await writeFile(resolve(root, 'style.css'), 'body { color: red; }');
    await writeFile(resolve(root, 'worker.js'), 'self.onmessage = () => self.postMessage(42);');
    await writeFile(
      resolve(root, 'plugin.js'),
      {
        image: "import image from './image.svg?url'; export default { image };",
        'public-image': "import image from '/image.svg?url'; export default { image };",
        css: "import './style.css'; export default { apply() {} };",
        worker: "import Worker from './worker.js?worker'; export default () => new Worker();",
        'worker-url':
          "export default () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
      }[kind],
    );
    const archive = new BrowserPluginProgramArchive();
    archive.entries.set('plugin', resolve(root, 'plugin.js'));
    let captured: unknown;
    let failure: unknown;
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'archive-probe',
          moduleParsed() {
            archive.preserveModules(this);
          },
          generateBundle: {
            order: 'post',
            handler(_options, bundle) {
              try {
                captured = archive.capture(this, bundle, 'engine');
              } catch (cause) {
                failure = cause;
              }
            },
          },
        },
      ],
      build: {
        write: false,
        assetsInlineLimit: 0,
        minify: false,
        modulePreload: false,
        rollupOptions: { input: resolve(root, 'main.js') },
      },
    });
    expect(captured).toBeUndefined();
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain('resource requires a portable producer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
