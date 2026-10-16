import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { operationCommandPath, operationMcpName } from '@forgeax/engine-tool-runtime';

const exec = promisify(execFile);
const engine = resolve(import.meta.dirname, '../../..');
const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-operation-cli-')));
const client = new Client({ name: 'operation-parity', version: '0.0.0' });
const cli = async (path, args = {}) => {
  try {
    return JSON.parse((await exec(process.execPath, [join(engine, 'packages/devkit/dist/cli.mjs'),
      ...path, '--root', root, '--input', JSON.stringify(args), '--json'], { timeout: 180_000 })).stdout);
  } catch (error) {
    if (typeof error.stdout !== 'string' || !error.stdout.trim()) throw error;
    return JSON.parse(error.stdout);
  }
};
let started = false;
try {
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'forge.json'), JSON.stringify({ schemaVersion: '3.0.0', id: 'names', name: 'Names', roots: {} }));
  await writeFile(join(root, 'package.json'), '{"name":"names","type":"module"}');
  await copyFile(join(engine, 'apps/hello/deep-agent-feedback/assets/scene.pack.json'), join(root, 'assets/scene.pack.json'));
  const ordinary = await cli(['backend', 'start']);
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
  started = true;
  const ordinaryTree = await cli(['help', ...operationCommandPath('engine.scene.tree.get')]);
  assert.equal(ordinaryTree.ok, true, JSON.stringify(ordinaryTree));
  assert.ok(ordinaryTree.value.leaf);
  assert.equal((await cli(['backend', 'stop'])).ok, true);
  started = false;
  const stopped = await cli(['help', ...operationCommandPath('engine.scene.tree.get')]);
  assert.equal(stopped.error.code, 'tool-command-not-found');
  assert.equal((await cli(['backend', 'status'])).value.phase, 'stopped');
  const startup = await cli(['backend', 'start'], { hostPack: join(engine, 'tools/forgeax-mcp/host.pack.json') });
  assert.equal(startup.ok, true, JSON.stringify(startup));
  started = true;
  assert.equal((await cli(['view', 'start'])).ok, true);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(engine, 'tools/forgeax-mcp/src/mcp-stdio.mjs'), root] }));
  const listed = (await client.listTools()).tools;
  const inspect = await cli(operationCommandPath('asset.inspect'), { subject: 'assets/scene.pack.json' });
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  const queries = [
    ['view.status', {}, {}],
    ['asset.inspect', { subject: 'assets/scene.pack.json' }, { subject: join(root, 'assets/scene.pack.json') }],
    ['view.workspace.pack.reveal', { projectId: 'names', sourcePath: 'assets/scene.pack.json', revision: inspect.value.revision }],
    ['engine.asset.inspect', { projectId: 'names', targetId: 'absent', guid: inspect.value.assets[0].guid }],
    ['engine.scene.tree.get', { targetId: 'absent', targetGeneration: 1 }],
    ['engine.entity.inspect', { targetId: 'absent', targetGeneration: 1, entityId: 'absent' }],
  ];
  assert.deepEqual(listed.map(tool => tool.name).sort(), queries.map(([id]) => operationMcpName(id)).sort());
  const results = [];
  for (const [id, args, mcpArgs = args] of queries) {
    const path = operationCommandPath(id);
    const help = await cli(['help', ...path]);
    assert.equal(help.ok, true, JSON.stringify(help));
    assert.ok(help.value.leaf, `${id} must be a discovered command`);
    const command = await cli(path, args);
    const mcp = (await client.callTool({ name: operationMcpName(id), arguments: mcpArgs })).structuredContent;
    if (id === 'view.status') {
      assert.equal(command.value.phase, 'ready');
      assert.equal(mcp.value.phase, 'ready');
    } else if (id === 'asset.inspect') {
      assert.equal(command.value.revision, mcp.value.revision);
      assert.equal(command.value.packageId, mcp.value.packageId);
      assert.deepEqual(mcp.value.assets.map(({ guid, kind, sourceKey }) => ({ guid, kind, sourceKey })),
        command.value.assets.map(({ guid, kind, sourceKey }) => ({ guid, kind, sourceKey })));
      assert.equal(Object.hasOwn(mcp.value, 'outputs'), false);
    } else if (id === 'view.workspace.pack.reveal') {
      assert.equal(command.value.code, 'view-page-unavailable');
      assert.equal(mcp.error.code, command.value.code);
    } else {
      assert.equal(command.ok, false, JSON.stringify(command));
      assert.match(JSON.stringify(command.error), /engine-workspace-(target|project)-mismatch/);
      assert.match(mcp.error.code, /^engine-workspace-(target|project)-mismatch$/);
    }
    results.push({ operation: id, cli: path.join(' '), mcp: operationMcpName(id) });
  }
  console.log(JSON.stringify({ publicOwnerParity: results }));
} finally {
  await client.close();
  if (started) assert.equal((await cli(['backend', 'stop'])).ok, true);
  await rm(root, { recursive: true, force: true });
}
