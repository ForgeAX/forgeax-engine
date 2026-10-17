import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindWorkspacePreviewSurface,
  dedicatedPreviewPresentation,
} from '../packages/view-workspace-core/src/preview-surface.ts';
import {
  selectWorkspaceResourcePreview,
  selectWorkspaceResourceSubject,
} from '../packages/view-workspace-core/src/resource-open.ts';

function container() {
  const node = {
    tagName: 'DIV',
    dataset: {},
    child: undefined,
    ownerDocument: {},
    append(child) {
      this.replaceChildren(child);
    },
    replaceChildren(child) {
      if (this.child) this.child.parentNode = null;
      this.child = child;
      if (child) child.parentNode = this;
    },
    removeChild(child) {
      if (this.child === child) {
        this.child = undefined;
        child.parentNode = null;
      }
    },
    contains(other) {
      return other === this || other === this.child;
    },
  };
  return node;
}

function engineSurface(canvas) {
  return {
    tagName: 'DIV',
    dataset: {},
    style: {},
    querySelector: (selector) => (selector === 'canvas' ? canvas : null),
  };
}

describe('dedicated asset preview surfaces', () => {
  it('requires a panel-owned container and refuses owner placement', () => {
    const ownerPlacement = bindWorkspacePreviewSurface({
      presentation: {
        surfacePlacement: 'owner',
        createSurface() { return engineSurface({ tagName: 'CANVAS', dataset: {}, style: {} }); },
      },
      target: { targetId: 'scene-target' },
      container: container(),
      owner: { panelId: 'material-preview', pageType: 'material' },
    });
    assert.equal(ownerPlacement.ok, false);
    assert.equal(ownerPlacement.error.code, 'view-preview-surface-unavailable');

    assert.throws(
      () => bindWorkspacePreviewSurface({
        presentation: {
          createSurface() { return engineSurface({ tagName: 'CANVAS', dataset: {}, style: {} }); },
        },
        target: { targetId: 'mesh-target' },
        canvas: { tagName: 'CANVAS', dataset: {} },
        owner: { panelId: 'mesh-preview', pageType: 'mesh' },
      }),
      /container, not a canvas/,
    );
  });

  it('hosts Engine createSurface output in distinct panel containers', async () => {
    const materialHost = container();
    const meshHost = container();
    const materialCanvas = { tagName: 'CANVAS', dataset: {}, style: { width: '320px', height: '240px' } };
    const meshCanvas = { tagName: 'CANVAS', dataset: {}, style: { width: '400px', height: '300px' } };
    const attached = [];
    const presentation = {
      createSurface({ target }) {
        return target.targetId === 'material-target' ? engineSurface(materialCanvas) : meshCanvas;
      },
      attach(input) {
        attached.push(input);
      },
    };
    const wrapped = dedicatedPreviewPresentation(presentation, {
      panelId: 'material-preview',
      pageType: 'material',
    });
    assert.equal(typeof wrapped.createSurface, 'function');

    const material = bindWorkspacePreviewSurface({
      presentation,
      target: { targetId: 'material-target' },
      container: materialHost,
      owner: { panelId: 'material-preview', pageType: 'material' },
    });
    const mesh = bindWorkspacePreviewSurface({
      presentation,
      target: { targetId: 'mesh-target' },
      container: meshHost,
      owner: { panelId: 'mesh-preview', pageType: 'mesh' },
    });
    assert.equal(material.ok, true);
    assert.equal(mesh.ok, true);
    assert.equal(materialHost.child.querySelector('canvas'), materialCanvas);
    assert.equal(meshHost.child, meshCanvas);
    assert.notEqual(attached[0].element, attached[1].element);
    assert.equal(materialCanvas.dataset.forgeaxAssetPreview, 'material-target');
    assert.equal(materialCanvas.style.width, '100%', 'presentation surface fills the panel host');
    assert.equal(materialCanvas.style.height, '100%');
    assert.equal(meshCanvas.style.width, '100%');
    assert.equal(meshCanvas.style.height, '100%');

    const reused = bindWorkspacePreviewSurface({
      presentation,
      target: { targetId: 'mesh-target' },
      container: materialHost,
      owner: { panelId: 'mesh-preview', pageType: 'mesh' },
    });
    assert.equal(reused.ok, false);
    assert.equal(reused.error.code, 'view-preview-canvas-owned');
    await material.dispose();
    await mesh.dispose();
  });

  it('releases placement before an asynchronous detach can overtake a rebind', async () => {
    const host = container();
    const surface = engineSurface({ tagName: 'CANVAS', dataset: {}, style: {} });
    let finishAttach;
    const pending = new Promise(resolve => { finishAttach = resolve; });
    let detached = 0;
    const input = {
      presentation: { createSurface: () => surface, attach: () => pending },
      target: { targetId: 'mesh-target' },
      container: host,
      owner: { panelId: 'mesh-preview', pageType: 'mesh' },
    };
    const first = bindWorkspacePreviewSurface(input);
    const disposing = first.dispose();
    const second = bindWorkspacePreviewSurface(input);
    finishAttach(() => { detached++; });
    await disposing;
    assert.equal(host.child, surface, 'old cleanup must not remove the current canvas');
    assert.equal(host.dataset.forgeaxAssetPreview, 'mesh-target');
    assert.equal(bindWorkspacePreviewSurface({ ...input, owner: { panelId: 'another', pageType: 'mesh' } }).ok, false);
    assert.equal(detached, 1, 'the old attachment still releases its resources');
    await second.dispose();
    assert.equal(host.child, undefined);
    assert.equal(detached, 2);
  });

  it('returns a borrowed preview to Engine parking before attachment cleanup settles', async () => {
    const parking = container();
    const host = container();
    const surface = engineSurface({ tagName: 'CANVAS', dataset: {}, style: {} });
    parking.append(surface);
    let finishAttach;
    const pending = new Promise(resolve => { finishAttach = resolve; });
    let detached = 0;
    const input = {
      presentation: { createSurface: () => surface, attach: () => pending },
      target: { targetId: 'mesh-target' },
      container: host,
      owner: { panelId: 'mesh-preview', pageType: 'mesh' },
    };
    const first = bindWorkspacePreviewSurface(input);
    assert.equal(surface.parentNode, host);
    const disposing = first.dispose();
    assert.equal(surface.parentNode, parking, 'the live Engine surface must remain connected during pending cleanup');
    assert.equal(detached, 0);
    const second = bindWorkspacePreviewSurface(input);
    finishAttach(() => { detached++; });
    await disposing;
    assert.equal(surface.parentNode, host, 'old cleanup must not reclaim a newly borrowed surface');
    await second.dispose();
    assert.equal(surface.parentNode, parking);
    assert.equal(detached, 2);
  });

  it('rolls back placement when presentation attachment throws synchronously', async () => {
    const parking = container();
    const host = container();
    const surface = engineSurface({ tagName: 'CANVAS', dataset: {}, style: {} });
    parking.append(surface);
    const failure = new Error('attachment failed');
    const input = {
      presentation: { createSurface: () => surface, attach: () => { throw failure; } },
      target: { targetId: 'mesh-target' },
      container: host,
      owner: { panelId: 'mesh-preview', pageType: 'mesh' },
    };
    assert.throws(() => bindWorkspacePreviewSurface(input), error => error === failure);
    assert.equal(surface.parentNode, parking);
    assert.deepEqual(host.dataset, {});
    const rebound = bindWorkspacePreviewSurface({
      ...input,
      presentation: { createSurface: () => surface },
      owner: { panelId: 'replacement', pageType: 'mesh' },
    });
    assert.equal(rebound.ok, true, 'failed attachment must release its panel claim');
    await rebound.dispose();
    assert.equal(surface.parentNode, parking);
  });

  it('forwards panel host size through preview.resize when a workspace api is provided', async () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback([]); }
      disconnect() {}
    };
    const host = container();
    Object.defineProperty(host, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 360, configurable: true });
    host.ownerDocument = { defaultView: { devicePixelRatio: 2 } };
    const resizeCalls = [];
    const bound = bindWorkspacePreviewSurface({
      presentation: {
        createSurface: () => engineSurface({ tagName: 'CANVAS', dataset: {}, style: {} }),
      },
      target: { targetId: 'material-target', generation: 3 },
      container: host,
      owner: { panelId: 'material-preview', pageType: 'material' },
      api: {
        resizePreview: (input) => {
          resizeCalls.push(input);
          return Promise.resolve();
        },
      },
    });
    assert.equal(bound.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(resizeCalls.length, 1);
    assert.deepEqual(resizeCalls[0], {
      tabId: 'forgeax-user-workspace',
      targetId: 'material-target',
      targetGeneration: 3,
      width: 1280,
      height: 720,
      reportError: false,
      signal: resizeCalls[0].signal,
    });
    assert.equal(resizeCalls[0].signal.aborted, false);
    void bound.dispose?.();
    assert.equal(resizeCalls[0].signal.aborted, true, 'Asset previews also revoke pending resize requests');
    globalThis.ResizeObserver = original;
  });

  it('refuses to host the Scene owner canvas', () => {
    const sceneCanvas = {
      tagName: 'CANVAS',
      dataset: { forgeaxViewSurface: 'engine-canvas' },
      style: {},
    };
    const bound = bindWorkspacePreviewSurface({
      presentation: {
        createSurface() { return sceneCanvas; },
      },
      target: { targetId: 'material-preview-target' },
      container: container(),
      owner: { panelId: 'material-preview', pageType: 'material' },
    });
    assert.equal(bound.ok, false);
    assert.equal(bound.error.code, 'view-preview-surface-unavailable');
  });

  it('selects extra type-preview targets and skips the Scene preview', () => {
    const snapshot = {
      scenePreview: { asset: { guid: 'scene-1', kind: 'scene' }, target: { targetId: 'scene-target' } },
      preview: { asset: { guid: 'mat-1', kind: 'material' }, target: { targetId: 'scene-target' } },
      openRequest: {
        asset: { guid: 'mat-1', kind: 'material' },
        preview: { asset: { guid: 'mat-1', kind: 'material' }, target: { targetId: 'scene-target' } },
      },
      previews: [
        { asset: { guid: 'scene-1', kind: 'scene' }, target: { targetId: 'scene-target' } },
        { asset: { guid: 'mat-1', kind: 'material' }, target: { targetId: 'material-preview-target' } },
      ],
    };
    const preview = selectWorkspaceResourcePreview(snapshot, 'mat-1');
    assert.equal(preview.target.targetId, 'material-preview-target');
    const missing = selectWorkspaceResourcePreview({
      ...snapshot,
      resourceOpens: {
        material: {
          asset: snapshot.openRequest.asset,
          preview,
        },
      },
      openRequest: { ...snapshot.openRequest, preview },
      previews: [snapshot.previews[0]],
    }, 'mat-1');
    assert.equal(missing, undefined);
  });

  it('keeps a previous asset-viewer subject after a later openRequest of another kind', () => {
    const snapshot = {
      scenePreview: { asset: { guid: 'scene-1', kind: 'scene' }, target: { targetId: 'scene-target' } },
      preview: { asset: { guid: 'scene-1', kind: 'scene' }, target: { targetId: 'scene-target' } },
      openRequest: {
        asset: { guid: 'mesh-1', kind: 'mesh' },
        preview: { asset: { guid: 'mesh-1', kind: 'mesh' }, target: { targetId: 'mesh-preview-target' } },
      },
      resourceOpens: {
        material: {
          asset: { guid: 'mat-1', kind: 'material' },
          preview: { asset: { guid: 'mat-1', kind: 'material' }, target: { targetId: 'material-preview-target' } },
        },
        mesh: {
          asset: { guid: 'mesh-1', kind: 'mesh' },
          preview: { asset: { guid: 'mesh-1', kind: 'mesh' }, target: { targetId: 'mesh-preview-target' } },
        },
      },
      previews: [
        { asset: { guid: 'scene-1', kind: 'scene' }, target: { targetId: 'scene-target' } },
        { asset: { guid: 'mat-1', kind: 'material' }, target: { targetId: 'material-preview-target' } },
        { asset: { guid: 'mesh-1', kind: 'mesh' }, target: { targetId: 'mesh-preview-target' } },
      ],
    };
    assert.equal(selectWorkspaceResourceSubject(snapshot, ['material']).guid, 'mat-1');
    assert.equal(selectWorkspaceResourcePreview(snapshot, 'mat-1').target.targetId, 'material-preview-target');
    assert.equal(selectWorkspaceResourceSubject(snapshot, ['mesh']).guid, 'mesh-1');
  });
});
