import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build, normalizePath, type Rollup } from 'vite';
import { expect, it } from 'vitest';
import { type ExecutionWorkerEntriesApi, executionWorkerEntries } from '../execution-workers.js';
import { BrowserPluginProgramArchive } from '../plugin-programs-browser.js';

const capabilities = Array.from({ length: 12 }, (_, index) => `cap${index}`);

it.each([
  'javascript',
  'html',
])('keeps the %s host entry static closure small while programs keep public facades', async (kind) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-host-closure-')));
  try {
    await writeFile(resolve(root, 'package.json'), '{"name":"consumer","type":"module"}');
    for (const [index, name] of capabilities.entries()) {
      const engine = resolve(root, `node_modules/@forgeax/engine-${name}`);
      await mkdir(engine, { recursive: true });
      await writeFile(
        resolve(engine, 'package.json'),
        JSON.stringify({ name: `@forgeax/engine-${name}`, type: 'module', exports: './index.js' }),
      );
      // Each capability has private code plus a varying set of siblings, the
      // shape that splits a bundle into one chunk per facade dependency set.
      const siblings = capabilities
        .slice(0, index)
        .filter((_, sibling) => (index + sibling) % 3 === 0)
        .map((sibling) => `@forgeax/engine-${sibling}`);
      await writeFile(
        resolve(engine, 'index.js'),
        [
          ...siblings.map((sibling, at) => `import * as s${at} from '${sibling}';`),
          `export const ${name} = { name: '${name}', siblings: [${siblings.map((_, at) => `s${at}`).join(', ')}] };`,
        ].join('\n'),
      );
    }
    const host = resolve(root, 'host');
    await mkdir(host);
    await writeFile(
      resolve(host, 'main.js'),
      [
        ...capabilities.map((name) => `import { ${name} } from '@forgeax/engine-${name}';`),
        `globalThis.capabilities = [${capabilities.join(', ')}];`,
        "globalThis.program = () => import('../game.js');",
      ].join('\n'),
    );
    await writeFile(
      resolve(root, 'game.js'),
      "import { cap3 } from '@forgeax/engine-cap3'; import { cap7 } from '@forgeax/engine-cap7'; export default { cap3, cap7 };",
    );
    const entry = resolve(host, kind === 'html' ? 'index.html' : 'main.js');
    if (kind === 'html')
      await writeFile(
        entry,
        '<!doctype html><script type="module">await new Promise(resolve => requestAnimationFrame(resolve));await import("./main.js");</script>',
      );
    const archive = new BrowserPluginProgramArchive();
    archive.entries.set('game', resolve(root, 'game.js'));
    const workers = executionWorkerEntries([], 'browser', host);
    const facades = (workers.api as ExecutionWorkerEntriesApi).facadeModules;
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        workers,
        {
          name: 'host-closure-probe',
          moduleParsed() {
            archive.preserveModules(this);
          },
          buildEnd() {
            archive.prepareGroups(this, facades);
          },
          outputOptions(output) {
            return archive.groupedOutput(output);
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        modulePreload: false,
        rollupOptions: {
          preserveEntrySignatures: 'allow-extension',
          input: { [kind === 'html' ? 'index' : 'main']: entry },
        },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
    const chunks = new Map(
      output.output
        .filter((chunk): chunk is Rollup.OutputChunk => chunk.type === 'chunk')
        .map((chunk) => [chunk.fileName, chunk]),
    );
    const html = output.output.find(
      (chunk) => chunk.type === 'asset' && chunk.fileName.endsWith('index.html'),
    );
    const htmlSource = html?.type === 'asset' ? String(html.source) : '';
    if (kind === 'html') expect(htmlSource).toMatch(/src="\/assets\/index-[^/]+\.js"/);
    const htmlEntry = htmlSource.match(/src="\/(assets\/index-[^"]+\.js)"/)?.[1];
    const main =
      kind === 'html'
        ? chunks.get(htmlEntry ?? '')
        : [...chunks.values()].find((chunk) => chunk.facadeModuleId === normalizePath(entry));
    if (!main) throw new Error('missing host entry');
    if (kind === 'html') {
      expect(main.fileName).toMatch(/^assets\/index-[^/]+\.js$/);
    }
    const closure = new Set<string>();
    const visit = (file: string) => {
      if (closure.has(file)) return;
      closure.add(file);
      for (const dependency of chunks.get(file)?.imports ?? []) visit(dependency);
    };
    visit(main.fileName);
    expect(closure.size).toBeLessThanOrEqual(4);
    // Every capability is still published as its own facade for programs.
    const published = [...chunks.values()].filter((chunk) =>
      capabilities.some((name) => chunk.exports.includes(name) && chunk.isEntry),
    );
    expect(published).toHaveLength(capabilities.length);
    for (const file of closure)
      expect(published.map((chunk) => chunk.fileName)).not.toContain(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps distinct groups for HTML pages with the same basename', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-page-groups-')));
  try {
    await mkdir(resolve(root, 'other'));
    for (const page of ['index.html', 'other/index.html'])
      await writeFile(
        resolve(root, page),
        '<!doctype html><script type="module">await Promise.resolve();globalThis.page = import.meta.url;</script>',
      );
    const archive = new BrowserPluginProgramArchive();
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'page-groups-probe',
          buildEnd() {
            archive.prepareGroups(this);
          },
          outputOptions(output) {
            return archive.groupedOutput(output);
          },
        },
      ],
      build: {
        write: false,
        modulePreload: false,
        rollupOptions: {
          preserveEntrySignatures: 'allow-extension',
          input: { index: resolve(root, 'index.html'), other: resolve(root, 'other/index.html') },
        },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
    const entries = output.output
      .filter((chunk) => chunk.type === 'asset' && chunk.fileName.endsWith('index.html'))
      .map((chunk) =>
        chunk.type === 'asset'
          ? String(chunk.source).match(/src="\/(assets\/index-[^"]+\.js)"/)?.[1]
          : undefined,
      );
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry !== undefined)).toBe(true);
    expect(new Set(entries).size).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
