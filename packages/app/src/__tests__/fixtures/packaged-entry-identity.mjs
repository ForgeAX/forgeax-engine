import assert from 'node:assert/strict';
import { Camera } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { publishShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { createApp } from '../../../dist/browser.mjs';
import {
  AppError,
  engineWorkspaceTargetToolsPlugin,
  isAppError,
  resetBrowserFrameSubmitted,
} from '../../../dist/index.mjs';

if (process.argv[2] === 'errors') {
  const result = await createApp({ isConnected: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'app-canvas-detached');
  assert.equal(isAppError(result.error), true);
  assert.ok(result.error instanceof AppError);
} else {
  // The real Null Renderer and App submit a frame. Only native input/display
  // facts are supplied; no private frame state or publication is fabricated.
  const canvas = Object.assign(new EventTarget(), {
    isConnected: true,
    width: 64,
    height: 64,
    getContext: () => null,
    ownerDocument: { documentElement: { dataset: {} } },
  });
  const platform = {
    now: () => ok(performance.now()),
    requestFrame: () => ok(() => {}),
    display: () =>
      ok({
        width: 64,
        height: 64,
        pixelRatio: 1,
        drawingWidth: 64,
        drawingHeight: 64,
        safeArea: { x: 0, y: 0, width: 64, height: 64 },
      }),
    visible: () => true,
    subscribe: () => ok(() => {}),
    dispose() {},
  };
  const input = {
    sample: () => ({
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
    }),
    detach() {},
  };
  const manifest = `data:application/json,${encodeURIComponent(
    JSON.stringify(publishShaderManifest([], [])),
  )}`;
  const app = (
    await createApp(canvas, { rhi, platform, input }, { shaderManifestUrl: manifest })
  ).unwrap();
  try {
    app.world
      .spawn({ component: Camera, data: {} }, { component: Transform, data: { pos: [0, 0, 3] } })
      .unwrap();
    await app.pluginContext.plugin(engineWorkspaceTargetToolsPlugin, {
      targetId: 'target',
      display: { canvas, app },
    });
    app.start().unwrap();
    app.pause().unwrap();
    app.stepFrame(1 / 60).unwrap();
    assert.equal(canvas.ownerDocument.documentElement.dataset.forgeaxFrameSubmitted, '1');
    const pick = () => app.pluginContext.engineWorkspaceTargetTools.pick({ x: 32, y: 32 });
    assert.deepEqual(pick(), {
      targetId: 'target',
      frameId: 1,
      entityId: null,
      granularity: 'bounds',
    });
    resetBrowserFrameSubmitted(canvas);
    assert.throws(
      pick,
      (error) =>
        error.code === 'engine-workspace-frame-unavailable' &&
        error.detail.reason === 'missing-frame',
    );
    app.stepFrame(1 / 60).unwrap();
    assert.equal(pick().frameId, 2);
  } finally {
    (await app.dispose()).unwrap();
  }
}
