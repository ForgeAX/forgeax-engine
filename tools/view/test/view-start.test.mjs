import assert from 'node:assert/strict';
import { it } from 'node:test';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveProjectIntent, resolveProjectRoot, runViewStartInteractive, withProjectIntent } from '../src/view-start.ts';
import { runViewProjectOpen } from '../src/view-project-open.ts';
import { startViewerStaticServer } from '../src/viewer-static-server.ts';
import * as executor from '../src/command-executor.ts';

it('requires a root value and resolves the backend workspace independently of cwd', () => {
  assert.throws(() => resolveProjectRoot(['--root']), /requires/);
  assert.equal(resolveProjectRoot(['--root', '/tmp/workspace']), resolve('/tmp/workspace'));
});

it('exports the View lifecycle executors and project open', () => {
  assert.deepEqual(Object.keys(executor).sort(), ['projectOpen', 'start', 'status', 'stop']);
});

it('infers a known project and lets explicit intent override the backend workspace', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'view-start-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(resolveProjectIntent([], root), undefined);
  await writeFile(resolve(root, 'forge.json'), '{}');
  assert.equal(resolveProjectIntent([], root), await realpath(root));
  assert.equal(resolveProjectIntent(['--project', '/another-game'], root), resolve('/another-game'));
  assert.throws(() => resolveProjectIntent(['--project'], root), /requires/);
  const status = { phase: 'ready', url: 'http://localhost:8000/?existing=1' };
  const result = withProjectIntent(status, root);
  assert.equal(new URL(result.url).searchParams.get('project'), root);
  assert.equal(new URL(result.url).searchParams.get('existing'), '1');
  assert.equal(status.url, 'http://localhost:8000/?existing=1');
});

it('uses the Engine project identity for a symlinked View URL intent', async t => {
  const parent = await mkdtemp(resolve(tmpdir(), 'view-project-alias-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = resolve(parent, 'project');
  const alias = resolve(parent, 'alias');
  await mkdir(project);
  await writeFile(resolve(project, 'forge.json'), '{}');
  await symlink(project, alias, 'dir');
  assert.equal(resolveProjectIntent(['--project', alias]), await realpath(project));
  assert.equal(resolveProjectIntent([], alias), await realpath(project));
});

it('rejects implicit browser execution options before reaching the backend', async () => {
  for (const option of ['--headless', '--software', '--serve']) {
    await assert.rejects(runViewStartInteractive([option]), /does not launch a browser/);
    await assert.rejects(runViewProjectOpen([option, '--project', '/game']), /does not launch a browser/);
  }
});

it('rejects project open without a project path', async () => {
  const result = await executor.projectOpen({ root: '/tmp/workspace' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'view-project-required');
});


it('the viewer static server retains its missing root diagnostic', async () => {
  await assert.rejects(startViewerStaticServer(), {
    name: 'TypeError', message: 'viewer static server requires staticRoot',
  });
});
