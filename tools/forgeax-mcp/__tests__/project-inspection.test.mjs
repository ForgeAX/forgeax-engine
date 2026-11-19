import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dispatch } from '../src/bridge.mjs';

test('Pack inspection follows the admitted game rather than the backend directory', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-mcp-project-inspection-')));
  const host = join(directory, 'host');
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  const worker = join(directory, 'inspect.mjs');
  await Promise.all([host, first, second].map(path => mkdir(path)));
  await Promise.all([first, second].map(path => writeFile(join(path, 'scene.pack.json'), '{}')));
  await writeFile(worker, "console.log(JSON.stringify({ok:true,value:{root:process.argv[2]}}));");
  let project = { id: 'first', root: first };
  const api = {
    list: () => [{ callable: true, descriptor: { id: 'view.workspace.call' }, owner: {} }],
    run(operation, args) {
      assert.equal(operation, 'view.workspace.call');
      assert.equal(args.operation, 'summary.get');
      return { terminal: Promise.resolve({ outcome: 'succeeded', result: { project } }) };
    },
  };
  try {
    const inspect = args => dispatch(api, host, 'asset.inspect', args, undefined, worker);
    assert.equal((await inspect({ subject: join(first, 'scene.pack.json') })).error.code, 'project-id-required');
    assert.equal((await inspect({ projectId: 'first', subject: join(first, 'scene.pack.json') })).value.root, first);
    assert.equal((await inspect({ projectId: 'first', subject: join(second, 'scene.pack.json') })).error.code, 'root-mismatch');
    project = { id: 'second', root: second };
    assert.equal((await inspect({ projectId: 'first', subject: join(first, 'scene.pack.json') })).error.code, 'engine-workspace-project-mismatch');
    assert.equal((await inspect({ projectId: 'second', subject: join(second, 'scene.pack.json') })).value.root, second);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
