import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VIEW_WORKSPACE_OPERATIONS } from '@forgeax/view-workspace-core/contract';
import { attachPreviewRenderResizeSync, attachViewportRenderResizeSync } from '../packages/view-workspace-core/src/render-resize-sync.ts';
import { ViewWorkspaceClient } from '../packages/view-workspace-core/src/client.ts';
import { subscribeWorkspaceCommandErrors } from '../packages/view-workspace-core/src/command-error.ts';

describe('preview.resize workspace contract', () => {
  it('is exposed through the workspace operation surface', () => {
    assert.equal(VIEW_WORKSPACE_OPERATIONS.includes('preview.resize'), true);
  });
});

describe('attachViewportRenderResizeSync', () => {
  it('submits the initial extent before later target commands, while debouncing layout changes', async () => {
    const original = globalThis.ResizeObserver;
    let notify;
    globalThis.ResizeObserver = class {
      constructor(callback) { notify = callback; }
      observe() {}
      disconnect() {}
    };
    const calls = [];
    const surface = { clientWidth: 400, clientHeight: 300 };
    const detach = attachPreviewRenderResizeSync({
      api: { async resizePreview(input) { calls.push(input); } },
      surface,
      target: { targetId: 'starting-play', generation: 1 },
    });
    try {
      await Promise.resolve();
      assert.equal(calls.length, 1, 'Initial placement must not leave a resize timer behind later capture/pick commands');
      assert.deepEqual([calls[0].width, calls[0].height], [400, 300]);
      surface.clientWidth = 500;
      notify();
      await Promise.resolve();
      assert.equal(calls.length, 1, 'Subsequent layout changes retain their debounce');
      await new Promise(done => setTimeout(done, 130));
      assert.equal(calls.length, 2);
      assert.deepEqual([calls[1].width, calls[1].height], [500, 300]);
    } finally { detach(); globalThis.ResizeObserver = original; }
  });

  it('cancels an in-flight resize when its surface attachment is revoked', async () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    let signal;
    let reject;
    const notices = [];
    const unsubscribe = subscribeWorkspaceCommandErrors(error => notices.push(error));
    const api = new ViewWorkspaceClient({ clientId: 'resize-proof', transport: {
      request(_service, _request, options) {
        signal = options.signal;
        if (!signal) return Promise.reject(new Error('Active target resize failed'));
        return new Promise((_, fail) => { reject = fail; });
      },
    } });
    const detach = attachPreviewRenderResizeSync({ api, surface: { clientWidth: 400, clientHeight: 300 },
      target: { targetId: 'retired-scene', generation: 1 }, debounceMs: 0 });
    try {
      await new Promise(done => setTimeout(done, 20));
      assert.equal(signal.aborted, false);
      detach();
      assert.equal(signal.aborted, true, 'Pending resize belongs to the old attachment');
      reject(new Error('Target retired while resizing'));
      await new Promise(done => setImmediate(done));
      assert.equal(notices.length, 0, 'Revoked requests cannot publish a late command error');
      await assert.rejects(api.resizePreview({ targetId: 'active', targetGeneration: 2, width: 400, height: 300 }));
      assert.equal(notices.length, 1, 'Failures of current requests remain visible');
    } finally { detach(); unsubscribe(); globalThis.ResizeObserver = original; }
  });

  it('does not acknowledge failed dimensions or leak synchronous request errors', async () => {
    const original = globalThis.ResizeObserver;
    let notify;
    globalThis.ResizeObserver = class {
      constructor(callback) { notify = callback; }
      observe() {}
      disconnect() {}
    };
    let calls = 0;
    const api = { resizePreview() {
      calls++;
      if (calls === 1) throw new Error('Target is busy');
      return Promise.resolve({});
    } };
    const detach = attachPreviewRenderResizeSync({ api, surface: { clientWidth: 400, clientHeight: 300 },
      target: { targetId: 'scene', generation: 1 }, debounceMs: 0 });
    try {
      await new Promise(done => setTimeout(done, 20));
      assert.equal(calls, 1);
      notify();
      await new Promise(done => setTimeout(done, 20));
      assert.equal(calls, 2, 'A failed resize is not a confirmed extent');
      notify();
      await new Promise(done => setTimeout(done, 20));
      assert.equal(calls, 2, 'Confirmed dimensions do not repeat');
    } finally { detach(); globalThis.ResizeObserver = original; }
  });

  it('retries a resize blocked by an open camera interaction without reporting it', async (test) => {
    test.mock.timers.enable({ apis: ['setTimeout'] });
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    };
    let calls = 0;
    const notices = [];
    const unsubscribe = subscribeWorkspaceCommandErrors((error) => notices.push(error));
    const api = {
      async resizePreview() {
        calls += 1;
        if (calls === 1) {
          // The native observer's initial notification flushes while this
          // request is waiting for its camera-busy retry, at the same extent.
          await new Promise(done => setTimeout(done, 50));
          throw Object.assign(new Error('camera busy'), { code: 'view-workspace-target-busy' });
        }
        return Promise.resolve({});
      },
    };
    const detach = attachPreviewRenderResizeSync({
      api,
      surface: { clientWidth: 400, clientHeight: 300 },
      target: { targetId: 'mesh-preview', generation: 4 },
    });
    try {
      await new Promise(done => setImmediate(done));
      assert.equal(calls, 1);
      assert.equal(notices.length, 0);
      test.mock.timers.tick(50);
      await new Promise(done => setImmediate(done));
      test.mock.timers.tick(50);
      await new Promise(done => setImmediate(done));
      assert.equal(calls, 1, 'The initial observer flush shares the pending retry');
      test.mock.timers.tick(50);
      await new Promise(done => setImmediate(done));
      assert.equal(calls, 2);
      assert.equal(notices.length, 0);
    } finally {
      detach();
      unsubscribe();
      globalThis.ResizeObserver = original;
    }
  });

  it('forwards exact surface pixels without mutating Engine target metadata', async () => {
    const calls = [];
    const api = {
      resizePreview(args) {
        calls.push(args);
        return Promise.resolve({ target: { width: args.width, height: args.height } });
      },
    };
    const target = { targetId: 'scene-target', generation: 1, width: 1280, height: 720 };
    const host = {
      clientWidth: 960,
      clientHeight: 540,
    };
    const surface = {
      clientWidth: 480,
      clientHeight: 270,
      ownerDocument: { defaultView: { devicePixelRatio: 2 } },
      parentElement: host,
      closest() {
        return host;
      },
    };

    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        this.callback([]);
      }
      disconnect() {}
    };

    try {
      const detachProvisional = attachViewportRenderResizeSync({ api, surface, target: { targetId: 'project-root' }, debounceMs: 0 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      detachProvisional();
      assert.equal(calls.length, 0, 'a project surface without a preview generation is not resizable');
      const detach = attachViewportRenderResizeSync({ api, surface, target, debounceMs: 0 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      detach();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        tabId: 'forgeax-user-workspace',
        targetId: 'scene-target',
        targetGeneration: 1,
        width: 960,
        height: 540,
        reportError: false,
        signal: calls[0].signal,
      });
      assert.equal(calls[0].signal.aborted, true);
      assert.equal(target.width, 1280);
      assert.equal(target.height, 720);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
