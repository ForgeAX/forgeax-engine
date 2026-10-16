// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createApp } from '@forgeax/engine-app/browser';

import {
  createUiAuthoringHost,
  type UiAuthoringAssetGateway,
} from '../src/ui-authoring';
import { createPreviewUiRun, reportPreviewEngineFailure } from '../src/ui-root';

describe('preview UI run lifecycle', () => {
  it('removes the root and runs cleanup in reverse order', () => {
    const parent = document.createElement('main');
    document.body.append(parent);
    const run = createPreviewUiRun(parent);
    const order: string[] = [];
    expect(window.__forgeaxUiAuthoring).toBe(run.authoring);
    run.registerCleanup(() => order.push('first'));
    run.registerCleanup(() => order.push('second'));
    run.uiRoot.append(document.createElement('button'));

    run.cleanup();
    run.cleanup();

    expect(order).toEqual(['second', 'first']);
    expect(run.uiRoot.childElementCount).toBe(0);
    expect(parent.querySelector('[data-forgeax-ui-root]')).toBeNull();
    expect(window.__forgeaxUiAuthoring).toBeUndefined();
    parent.remove();
  });

  it('keeps authoring available when createApp cannot acquire WebGPU', async () => {
    const parent = document.createElement('main');
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    document.body.append(parent);
    const run = createPreviewUiRun(parent);
    Object.defineProperty(canvas, 'getContext', {
      configurable: true,
      value: () => null,
    });

    try {
      const app = await createApp(canvas, { uiRoot: run.uiRoot });
      expect(app.ok).toBe(false);
      if (app.ok) return;

      reportPreviewEngineFailure(run, {
        code: 'engine-environment',
        detail: app.error.code,
      });
      const opened = await run.authoring.open('default');

      expect(opened.ok).toBe(true);
      expect(run.authoring.getCaptureTarget()?.isConnected).toBe(true);
      expect(run.uiRoot.dataset.forgeaxPreviewEngineFailure).toBe(
        JSON.stringify({ code: 'engine-environment', detail: app.error.code }),
      );
      expect(window.__forgeaxUiAuthoring).toBe(run.authoring);
    } finally {
      delete (canvas as HTMLCanvasElement & { getContext?: HTMLCanvasElement['getContext'] }).getContext;
      run.cleanup();
      parent.remove();
    }
  });

  it('keeps the selected source discoverable while a repaired override is mounted', async () => {
    const parent = document.createElement('main');
    document.body.append(parent);
    const selected = {
      guid: '019f8354-6386-4386-849d-f2ab4b96229d',
      kind: 'ui' as const,
      sourcePath: 'assets/ui-authoring/preview-hud.ui.html',
    };
    let invalidated = false;
    const gateway: UiAuthoringAssetGateway = {
      preferredGuid: selected.guid,
      listCatalog: () => (invalidated ? [] : [selected]),
      loadByGuid: async () => ({
        ok: true as const,
        value: {
          guid: selected.guid,
          html: '<section data-ui-part="root"><strong data-ui-part="score">Score 0</strong></section>',
          css: ':host { display: block; }',
        },
      }),
      invalidate: () => {
        invalidated = true;
      },
      replace: async (asset) => ({ ok: true as const, value: asset }),
      subscribe: () => () => {},
    };
    const authoring = createUiAuthoringHost(parent, gateway);

    try {
      expect((await authoring.open('default')).ok).toBe(true);
      const invalid = await authoring.repair({ html: '<script>bad</script>', css: '' });
      expect(invalid.ok).toBe(false);
      const repaired = await authoring.repair({
        html: '<section data-ui-part="root"><strong data-ui-part="score">Score 1</strong></section>',
        css: ':host { display: block; }',
      });
      expect(repaired.ok).toBe(true);
      expect((await authoring.getSession()?.retry())?.ok).toBe(true);
      expect(authoring.discover()).toContainEqual(selected);
    } finally {
      authoring.dispose();
      parent.remove();
    }
  });
});
