import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEditorPageTitleController,
  createResourcePageTitleController,
  editorPageTitleFromWorkspace,
  resourceAssetName,
  resourcePageTitleFromWorkspace,
} from '../packages/view-workspace-core/src/page-title.ts';

function createFakeWorkspaceClient(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    getState() {
      return Promise.resolve(state);
    },
    publish(next) {
      state = next;
      for (const listener of listeners) listener(state);
    },
  };
}

describe('editor page title from workspace', () => {
  it('is idle when no preview is bound', () => {
    assert.equal(editorPageTitleFromWorkspace({ preview: null }), undefined);
    assert.equal(editorPageTitleFromWorkspace({ preview: { asset: { guid: 'x', kind: 'scene' } } }), undefined);
  });

  it('reads the bound preview asset name', () => {
    assert.equal(
      editorPageTitleFromWorkspace({
        preview: { asset: { guid: 'scene-guid', kind: 'scene', name: 'Main' } },
      }),
      'Main',
    );
  });

  it('notifies subscribers when the workspace snapshot changes', () => {
    const client = createFakeWorkspaceClient({ preview: null });
    const controller = createEditorPageTitleController(client);
    const seen = [];
    const unsubscribe = controller.subscribeTitle(() => {
      seen.push(controller.getTitle());
    });
    assert.equal(controller.getTitle(), undefined);
    client.publish({ preview: { asset: { guid: 'scene-guid', kind: 'scene', name: 'Forest' } } });
    assert.equal(controller.getTitle(), 'Forest');
    assert.deepEqual(seen.at(-1), 'Forest');
    client.publish({ preview: null });
    assert.equal(controller.getTitle(), undefined);
    unsubscribe();
    controller.dispose();
  });

  it('does not notify when only frame telemetry changes', () => {
    const client = createFakeWorkspaceClient({
      revision: 1,
      preview: { asset: { guid: 'scene-guid', kind: 'scene', name: 'Forest' }, target: { targetId: 't', frameId: 1 } },
    });
    const controller = createEditorPageTitleController(client);
    const seen = [];
    const unsubscribe = controller.subscribeTitle(() => {
      seen.push(controller.getTitle());
    });
    const afterSubscribe = seen.length;
    client.publish({
      revision: 9,
      preview: { asset: { guid: 'scene-guid', kind: 'scene', name: 'Forest' }, target: { targetId: 't', frameId: 88 } },
    });
    assert.equal(seen.length, afterSubscribe);
    assert.equal(controller.getTitle(), 'Forest');
    unsubscribe();
    controller.dispose();
  });
});

describe('mesh resource page title', () => {
  const cube = { guid: 'cube-guid', kind: 'mesh', sourceKey: 'mesh/cube' };

  it('uses the opened asset name or source key instead of the generic page label', () => {
    assert.equal(resourceAssetName({ ...cube, name: 'Painted Cube' }), 'Painted Cube');
    assert.equal(resourceAssetName(cube), 'cube');
    assert.equal(resourcePageTitleFromWorkspace({ openRequest: { asset: cube } }, ['mesh']), 'cube');
    assert.equal(resourcePageTitleFromWorkspace({
      openRequest: { asset: { guid: 'cube-guid', kind: 'mesh' }, inspection: { asset: cube } },
    }, ['mesh']), 'cube');
    assert.equal(resourcePageTitleFromWorkspace({
      resourceOpens: { mesh: { asset: { guid: 'cube-guid', kind: 'mesh' } } }, assets: [cube],
    }, ['mesh']), 'cube');
    assert.equal(resourcePageTitleFromWorkspace({ openRequest: { asset: { guid: 'other', kind: 'mesh' } } }, ['mesh']), undefined);
  });

  it('retains the mesh title when a different asset page opens and follows later mesh opens', () => {
    const client = createFakeWorkspaceClient({ resourceOpens: { mesh: { asset: cube } } });
    const controller = createResourcePageTitleController(client, ['mesh']);
    const seen = [];
    const unsubscribe = controller.subscribeTitle(() => seen.push(controller.getTitle()));
    assert.equal(controller.getTitle(), 'cube');
    assert.deepEqual(controller.getResource(), { asset: { guid: cube.guid, kind: 'mesh' } });
    client.publish({ openRequest: { asset: { guid: 'material-guid', kind: 'material', name: 'Paint' } },
      resourceOpens: { mesh: { asset: { guid: 'cube-guid', kind: 'mesh' } } }, assets: [cube] });
    assert.equal(controller.getTitle(), 'cube');
    client.publish({ resourceOpens: { mesh: { asset: { ...cube, sourceKey: 'mesh/sphere' } } } });
    assert.equal(controller.getTitle(), 'sphere');
    assert.equal(seen.at(-1), 'sphere');
    unsubscribe();
    controller.dispose();
  });
});

it('generic page titles stay idle for scene and dedicated preview opens', () => {
  assert.equal(resourcePageTitleFromWorkspace({ openRequest: { asset: { guid: 'scene', kind: 'scene', name: 'Forest' } } }, []), undefined);
  assert.equal(resourcePageTitleFromWorkspace({ openRequest: { asset: { guid: 'mesh', kind: 'mesh', name: 'Cube' } } }, []), undefined);
  assert.equal(resourcePageTitleFromWorkspace({ openRequest: { detailsOnly: true, asset: { guid: 'audio', kind: 'audio', name: 'Ambient' } } }, []), 'Ambient');
});
