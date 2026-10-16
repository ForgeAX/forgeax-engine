import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { VIEW_WORKSPACE_TAB_ID } from '@forgeax/view-workspace-core/contract';

import { openViewProject, projectIdentity } from '../src/view-project-open.ts';

const target = {
  url: 'http://127.0.0.1:9/?forgeaxWorkspaceSession=session-1',
  targetId: 'target-1',
};

function workspace(snapshot, openProject) {
  return {
    snapshot: () => snapshot,
    openProject: openProject ?? (async () => { throw new Error('project.open must not run'); }),
  };
}

test('project open reuses the same directory and refuses a different one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'view-project-open-'));
  const other = await mkdtemp(join(tmpdir(), 'view-project-other-'));
  try {
    const identity = await projectIdentity(root);
    let opened = 0;
    const current = workspace({
      project: { id: 'game', root: identity },
      projectTarget: target,
    }, async () => { opened += 1; });
    const again = await openViewProject(current, `${root}${root.endsWith('\\') || root.endsWith('/') ? '' : '/'}`);
    assert.equal(again.alreadyOpen, true);
    assert.equal(again.project.root, identity);
    assert.equal(again.projectTarget.url, target.url);
    assert.equal(opened, 0);

    await assert.rejects(
      () => openViewProject(current, other),
      (error) => error.code === 'view-project-already-open' && error.detail.root === identity,
    );
    assert.equal(opened, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('project open calls Engine once when the same project target was lost', async () => {
  const calls = [];
  const opened = await openViewProject(workspace({
    project: { id: 'game', root: '/game' },
    projectTarget: target,
    workspaceTargetLost: true,
  }, async (args) => {
    calls.push(args);
    return { project: { id: 'game', root: '/game' }, projectTarget: target };
  }), '/game', { viewerUrl: 'http://127.0.0.1:8/' });
  assert.deepEqual(calls, [{ root: await projectIdentity('/game'), tabId: VIEW_WORKSPACE_TAB_ID }]);
  assert.equal(opened.alreadyOpen, false);
  assert.equal(opened.viewerUrl, 'http://127.0.0.1:8/');
  assert.equal(opened.projectTarget.targetId, 'target-1');
});

test('project open fails when View has no broker and does not invent one', async () => {
  await assert.rejects(
    () => openViewProject(undefined, '/game'),
    (error) => error.code === 'view-not-started',
  );
});

test('project open maps an aborted open to view stopped', async () => {
  const controller = new AbortController();
  const pending = openViewProject(workspace({ project: null }, async () => {
    controller.abort();
    throw new Error('aborted');
  }), '/game', { signal: controller.signal });
  await assert.rejects(pending, (error) => error.code === 'view-not-started' && /stopped/i.test(error.hint));
});

test('project open does not succeed without a headed document URL', async () => {
  const openWithoutUrl = async () => ({ project: { id: 'game', root: '/game' } });
  await assert.rejects(
    () => openViewProject(workspace({ project: null }, openWithoutUrl), '/game'),
    (error) => error.code === 'view-project-open-incomplete',
  );
});
