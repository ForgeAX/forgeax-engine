import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { APP_VERSION } from '../src/contract.ts';

const temp = await mkdtemp(join(tmpdir(), 'forgeax-view-local-plugin-'));
const project = join(temp, 'project');
const marketplace = join(temp, 'marketplace');
const generator = resolve(import.meta.dirname, '../codex/create-local-plugin.mjs');
try {
  await mkdir(project);
  await writeFile(join(project, 'forge.json'), JSON.stringify({ id: 'local-plugin-fixture', schemaVersion: '3.0.0' }));
  const generated = JSON.parse(execFileSync(process.execPath, [generator, project, marketplace], { encoding: 'utf8' }));
  const canonicalProject = await realpath(project);
  assert.equal(generated.projectRoot, canonicalProject);
  const plugin = join(marketplace, 'plugins', 'forgeax-view-codex');
  const manifest = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(plugin, 'mcp.json'), 'utf8'));
  const catalog = JSON.parse(await readFile(join(marketplace, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(manifest.name, 'forgeax-view-codex');
  assert.equal(manifest.version, APP_VERSION);
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['forgeax-tools', 'forgeax-view']);

  assert.equal(mcp.mcpServers['forgeax-tools'].type, 'stdio');
  assert.equal(mcp.mcpServers['forgeax-tools'].command,
    process.platform === 'win32' ? 'node' : './node-launcher');
  assert.deepEqual(mcp.mcpServers['forgeax-tools'].args, ['${PLUGIN_ROOT}/mcp-stdio.mjs', canonicalProject]);
  assert.equal(catalog.name, generated.marketplaceName);
  assert.equal(catalog.plugins[0].source.path, './plugins/forgeax-view-codex');
  assert.throws(() => execFileSync(process.execPath, [generator, project, marketplace], { stdio: 'ignore' }));

  const client = new Client({ name: 'local-plugin-smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.platform === 'win32' ? process.execPath : join(plugin, 'node-launcher'),
    args: [join(plugin, 'mcp-stdio.mjs'), project] });
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
    args: [join(plugin, 'src/codex-app-server.mjs'), canonicalProject], cwd: temp }));
  try {
    assert.equal(appClient.getServerVersion().name, 'forgeax-view');
    const tools = (await appClient.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(),
      ['forgeax_view_start', 'forgeax_view_transport']);
    const openingTool = tools.find(tool => tool.name === 'forgeax_view_start');
    assert.equal(openingTool.title, 'ForgeAX View');
    const listedResource = (await appClient.listResources()).resources[0];
    assert.equal(listedResource.name, 'ForgeAX View');
    assert.equal(listedResource.uri, openingTool._meta.ui.resourceUri);
    assert.equal(new URL(listedResource.uri).searchParams.get('version'), manifest.version);
    const resource = await appClient.readResource({ uri: listedResource.uri });
    assert.ok(resource.contents[0].text.includes(`data-forgeax-app-version="${APP_VERSION}"`));
    assert.match(resource.contents[0].text, /<title>ForgeAX View<\/title>/);
    assert.match(await readFile(join(plugin, 'dist/full-view.html'), 'utf8'), /__FX_VIEW_CONFIG__/);
    assert.match(await readFile(join(plugin, 'dist/preview-runtime.mjs'), 'utf8'), /preparePlatform/);
    // A packaged compiler must load outside the checkout and build real source.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `const {build}=await import(${JSON.stringify(join(plugin,'node_modules/vite/dist/node/index.js'))});
       const result=await build({configFile:false,logLevel:'silent',build:{write:false,
         rolldownOptions:{input:'virtual-entry'},},plugins:[{name:'fixture',resolveId:id=>id==='virtual-entry'?id:null,
         load:id=>id==='virtual-entry'?'export const value = 42':null}]});
       if(!result.output.some(item=>item.type==='chunk'))throw new Error('No compiled output');
       const {build:buildProgram}=await import(${JSON.stringify(join(plugin,'node_modules/esbuild/lib/main.js'))});
       const program=await buildProgram({stdin:{contents:'export const nativeProgram = 42;'},bundle:true,
         platform:'browser',format:'esm',write:false});
       if(!program.outputFiles[0].text.includes('nativeProgram'))throw new Error('No native program output');
       const {bundlePackProgram}=await import(${JSON.stringify(join(plugin,'src/app/program-bundler.mjs'))});
       const source=await bundlePackProgram({program:${JSON.stringify(preparePackProgram({entry:'entry.mjs',export:'value',modules:{'entry.mjs':'export const value = 42;'}}).unwrap())},imports:{},exports:{},bindingId:'package-smoke'});
       const compiled=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
       if(compiled.load('entry.mjs').value!==42)throw new Error('Packaged program did not execute');`], {cwd:temp,stdio:'pipe'});
  } finally { await appClient.close(); }
  console.log(JSON.stringify({ packagedTools: 8, marketplaceName: generated.marketplaceName }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
