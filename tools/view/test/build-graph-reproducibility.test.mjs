import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('panel graph bytes survive workspace relocation, including external and virtual modules', async (t) => {
  const temporary = await realpath(await mkdtemp(resolve(tmpdir(), 'view-panel-graph-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const environment = ['FORGEAX_VIEW_PANELS_ENTRY', 'FORGEAX_VIEW_FRONTEND_PLUGINS_ENTRY', 'FORGEAX_VIEW_INPUT_ROOTS'];
  const saved = environment.map((name) => process.env[name]);
  environment.forEach((name) => delete process.env[name]);
  t.after(() => environment.forEach((name, index) => {
    if (saved[index] === undefined) delete process.env[name];
    else process.env[name] = saved[index];
  }));

  async function graph(workspace) {
    const root = resolve(workspace, 'tools/view');
    for (const directory of ['scripts', 'src', 'packages/viewer/src']) {
      await mkdir(resolve(root, directory), { recursive: true });
    }
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(resolve(root, 'src/index.ts'), 'export {};');
    await writeFile(resolve(root, 'packages/viewer/src/panels-entry.tsx'), 'export {};');
    await copyFile(new URL('../scripts/build-inputs.mjs', import.meta.url), resolve(root, 'scripts/build-inputs.mjs'));
    const { panelsEntry, revisionPlugin } = await import(pathToFileURL(resolve(root, 'scripts/build-inputs.mjs')));
    const external = resolve(workspace, 'node_modules/.pnpm/react@19/node_modules/react/index.js');
    const otherExternal = resolve(workspace, 'node_modules/.pnpm/react@18/node_modules/react/index.js');
    const virtual = '\0view-build-revision';
    const virtualExternal = `\0${external}?commonjs-proxy`;
    const modules = [panelsEntry, external, otherExternal, virtual, virtualExternal];
    const info = new Map(modules.map((id) => [id, { importedIds: [], dynamicallyImportedIds: [] }]));
    info.get(panelsEntry).importedIds = [external, virtual, virtualExternal];
    info.get(panelsEntry).dynamicallyImportedIds = [otherExternal];
    let emitted;
    revisionPlugin.generateBundle.call({
      getModuleInfo: (id) => info.get(id),
      emitFile: (asset) => { emitted = asset; },
    }, {}, {
      'panels.js': { type: 'chunk', modules: { [panelsEntry]: {}, [external]: {}, [virtual]: {} }, imports: [], dynamicImports: ['lazy.js'] },
      'lazy.js': { type: 'chunk', modules: { [otherExternal]: {}, [virtualExternal]: {} }, imports: ['panels.js'], dynamicImports: [] },
    });
    assert.equal(emitted.fileName, 'panel-graph.json');
    return emitted.source;
  }

  const first = await graph(resolve(temporary, 'runner-a'));
  const second = await graph(resolve(temporary, 'runner-b'));
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.deepEqual(parsed.modules, parsed.sourceModules);
  assert.equal(parsed.modules.length, 5);
  assert.ok(parsed.modules.includes('<view>/packages/viewer/src/panels-entry.tsx'));
  assert.ok(parsed.modules.includes('\0view-build-revision'));
  assert.ok(parsed.modules.includes('<view>/../../node_modules/.pnpm/react@19/node_modules/react/index.js'));
  assert.ok(parsed.modules.includes('<view>/../../node_modules/.pnpm/react@18/node_modules/react/index.js'));
  assert.ok(parsed.modules.includes('\0<view>/../../node_modules/.pnpm/react@19/node_modules/react/index.js?commonjs-proxy'));
  assert.ok(!first.includes(temporary));
});
