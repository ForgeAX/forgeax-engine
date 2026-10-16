import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createResourceBrowserPlatform } from '../src/index.ts';
import { ViewWorkspaceShell } from '@forgeax/view-plugin-viewport/workspace-shell';

test('resource browser keeps catalog hosting available but declines Engine preview pages', async () => {
  const platform = createResourceBrowserPlatform();
  assert.deepEqual(platform.getCapabilities(), {
    ready: true,
    supportsPage: false,
    resourceBrowser: true,
    gpuModes: [],
    maxWidth: 0,
    maxHeight: 0,
    canvasSizing: 'none',
  });
  await assert.rejects(platform.createPage(), { fallbackReason: 'view-resource-browser' });
  await platform.dispose();
  assert.equal(platform.getCapabilities().ready, false);
});

test('resource browser inspects a catalog item without opening an Engine preview', async () => {
  let opened = 0;
  const shell = new ViewWorkspaceShell({
    resourceBrowser: true,
    api: {
      async inspectAsset() { return { inspection: { guid: 'board', asset: { guid: 'board' } } }; },
      async openAsset() { opened += 1; },
    },
  });
  shell.state.project = { id: 'gomoku' };
  shell.state.assets = [{ guid: 'board', kind: 'scene', name: 'Gomoku Board' }];
  await shell.selectAsset('board');
  assert.equal(opened, 0);
  assert.equal(shell.state.inspection.guid, 'board');
});
