import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEditorPageTitleController,
  editorPageTitleFromWorkspace,
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
