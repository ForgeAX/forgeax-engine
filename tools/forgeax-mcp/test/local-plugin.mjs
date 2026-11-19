import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { APP_VERSION } from '../src/contract.ts';

const temp = await mkdtemp(join(tmpdir(), 'forgeax-view-local-plugin-'));
const engine = resolve(process.env.FORGEAX_PLUGIN_SOURCE ?? resolve(import.meta.dirname, '../../..'));
const root = join(temp, 'backend');
const marketplace = join(temp, 'marketplace');
const generator = resolve(import.meta.dirname, '../codex/create-local-plugin.mjs');
try {
  const generated = JSON.parse(execFileSync(process.execPath, [generator, engine, marketplace, '--root', root], { encoding: 'utf8' }));
  const canonicalRoot = await realpath(root);
  assert.equal(generated.root, canonicalRoot);
  assert.equal(generated.projectRoot, undefined);
  const plugin = join(marketplace, 'plugins', 'forgeax-view-codex');
  const manifest = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(plugin, 'mcp.json'), 'utf8'));
  const binding = JSON.parse(await readFile(join(plugin, 'hosting.json'), 'utf8'));
  assert.equal(binding.root, canonicalRoot);
  assert.equal(binding.project, undefined);
  const catalog = JSON.parse(await readFile(join(marketplace, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(manifest.name, 'forgeax-view-codex');
  assert.equal(manifest.version, APP_VERSION);
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['forgeax-tools', 'forgeax-view']);

  assert.equal(mcp.mcpServers['forgeax-tools'].type, 'stdio');
  assert.equal(mcp.mcpServers['forgeax-tools'].command,
    process.platform === 'win32' ? 'node' : './node-launcher');
  assert.deepEqual(mcp.mcpServers['forgeax-tools'].args, ['${PLUGIN_ROOT}/mcp-stdio.mjs', '${PLUGIN_ROOT}/hosting.json']);
  assert.equal(catalog.name, generated.marketplaceName);
  assert.equal(catalog.plugins[0].source.path, './plugins/forgeax-view-codex');
  assert.throws(() => execFileSync(process.execPath, [generator, engine, marketplace, '--root', root], { stdio: 'ignore' }));

  const client = new Client({ name: 'local-plugin-smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.platform === 'win32' ? process.execPath : join(plugin, 'node-launcher'),
    args: [join(plugin, 'mcp-stdio.mjs'), join(plugin, 'hosting.json')] });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, 'forgeax-tools');
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 6);
    const status = (await client.callTool({ name: 'forgeax_view_status', arguments: {} })).structuredContent;
    assert.equal(status?.error?.code, 'backend-not-ready');
  } finally {
    await client.close();
  }
  const appEntry = mcp.mcpServers['forgeax-view'];
  assert.equal(appEntry?.type, 'stdio');
  const appClient = new Client({ name: 'portable-app-smoke', version: '0.0.0' });
  await appClient.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, 'src/codex-app-server.mjs'), join(plugin, 'hosting.json')], cwd: temp }));
  try {
    assert.equal(appClient.getServerVersion().name, 'forgeax-view');
    const tools = (await appClient.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(),
      ['forgeax_view_file_open', 'forgeax_view_resource_card',
        'forgeax_view_resource_card_2', 'forgeax_view_resource_card_3', 'forgeax_view_resource_open',
        'forgeax_view_resource_select', 'forgeax_view_start', 'forgeax_view_transport']);
    const fileEntry = tools.find(tool => tool.name === 'forgeax_view_file_open');
    assert.equal(fileEntry.title, 'ForgeAX View');
    assert.deepEqual(fileEntry._meta['openai/ui'].entrypoints,
      [{ type: 'file', extensions: ['.pack.json', '.pack.ts'] }]);
    assert.equal(fileEntry._meta.ui.resourceUri, 'ui://forgeax/file.html?version=' + manifest.version);
    assert.deepEqual(fileEntry._meta.ui.visibility, ['app']);
    const openingTool = tools.find(tool => tool.name === 'forgeax_view_start');
    assert.equal(openingTool.title, 'ForgeAX View');
    const listedResource = (await appClient.listResources()).resources[0];
    assert.equal(listedResource.name, 'ForgeAX View');
    assert.equal(listedResource.uri, openingTool._meta.ui.resourceUri);
    assert.equal(new URL(listedResource.uri).searchParams.get('version'), manifest.version);
    const opened = await appClient.callTool({ name: 'forgeax_view_start', arguments: {} });
    assert.equal(opened.isError, undefined);
    assert.ok(opened.structuredContent.url);
    const bootstrap = await fetch(new URL('/__forgeax/view/bootstrap', opened.structuredContent.url)).then(r => r.json());
    assert.equal(bootstrap.phase, 'preparing');
    assert.equal(bootstrap.token, undefined);
    const document = await appClient.callTool({ name: 'forgeax_view_transport', arguments: { action: 'view-document' } });
    assert.equal(document.isError, undefined);
    assert.ok(document.structuredContent.bytes > 0);
    const resource = await appClient.readResource({ uri: listedResource.uri });
    assert.ok(resource.contents[0].text.includes(`data-forgeax-app-version="${APP_VERSION}"`));
    assert.match(resource.contents[0].text, /<title>ForgeAX View<\/title>/);
    assert.match(await readFile(join(plugin, 'dist/full-view.html'), 'utf8'), /__FX_VIEW_CONFIG__/);
    const filePage = await appClient.readResource({ uri: fileEntry._meta.ui.resourceUri });
    assert.match(filePage.contents[0].text, /id="fx-entry-kind"[^>]*>"file"/);
    assert.match(filePage.contents[0].text, /id="fx-entry-scope"[^>]*>"workspace"/);
    assert.match(filePage.contents[0].text, /id="view"/);
    assert.match(filePage.contents[0].text, /ontoolinput/);
    for (const removed of ['resource-link.mjs', 'dist/resource.html', 'src/codex-resource-server.mjs'])
      await assert.rejects(access(join(plugin, removed)), { code: 'ENOENT' });
    for (const source of ['templates/empty/assets/world/world.scene.pack.json', 'templates/game-3d/assets/scene.pack.ts']) {
      const selected = await appClient.callTool({ name: 'forgeax_view_transport',
        arguments: { action: 'file-context', payload: { path: '/fake.pack.json' } },
        _meta: { 'openai/resource': { path: join(engine, source) } } });
      assert.equal(selected.structuredContent.ok, true, JSON.stringify(selected.structuredContent));
      assert.equal(selected.structuredContent.value.sourcePath, source.split('/assets/')[1] === 'scene.pack.ts'
        ? 'assets/scene.pack.ts' : 'assets/world/world.scene.pack.json');
    }
    assert.match(await readFile(join(plugin, 'dist/preview-runtime.mjs'), 'utf8'), /preparePlatform/);
    // A packaged compiler must load outside the checkout and build real source.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `const {build}=await import(${JSON.stringify(pathToFileURL(join(plugin,'node_modules/vite/dist/node/index.js')).href)});
       const result=await build({configFile:false,logLevel:'silent',build:{write:false,
         rolldownOptions:{input:'virtual-entry'},},plugins:[{name:'fixture',resolveId:id=>id==='virtual-entry'?id:null,
         load:id=>id==='virtual-entry'?'export const value = 42':null}]});
       if(!result.output.some(item=>item.type==='chunk'))throw new Error('No compiled output');
       const {build:buildProgram}=await import(${JSON.stringify(pathToFileURL(join(plugin,'node_modules/esbuild/lib/main.js')).href)});
       const program=await buildProgram({stdin:{contents:'export const nativeProgram = 42;'},bundle:true,
         platform:'browser',format:'esm',write:false});
       if(!program.outputFiles[0].text.includes('nativeProgram'))throw new Error('No native program output');
       const {bundlePackProgram}=await import(${JSON.stringify(pathToFileURL(join(plugin,'src/app/program-bundler.mjs')).href)});
       const source=await bundlePackProgram({program:${JSON.stringify(preparePackProgram({entry:'entry.mjs',export:'value',modules:{'entry.mjs':'export const value = 42;'}}).unwrap())},imports:{},exports:{},bindingId:'package-smoke'});
       const compiled=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
       if(compiled.load('entry.mjs').value!==42)throw new Error('Packaged program did not execute');`], {cwd:temp,stdio:'pipe'});
  } finally { await appClient.close(); }
  console.log(JSON.stringify({ toolServerTools: 6, appServerTools: 7, marketplaceName: generated.marketplaceName }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
