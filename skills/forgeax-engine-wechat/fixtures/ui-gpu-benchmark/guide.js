import { createBlitzUi } from '@probe/ui-blitz';
import { installGuideUiFixture } from '@probe/guide-fixture';
import html from '@probe/guide-html';
import css from '@probe/guide-css';
import { startupDocument, createStartup } from '@probe/startup';
import { benchmarkHost } from '@probe/host';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const required = (value) => {
  check(value !== null && value !== undefined, 'required value');
  return value;
};
export function createGuideProbe(canvas, render) {
  const facts = {
    scope: 'UI owner only; generated vase state, no 3D renderer',
    raster: render.name,
    phases: [],
    errors: [],
  };
  let ui,
    fixture,
    startup,
    channel,
    clock = 0;
  const messages = [];
  const paint = (time) => {
    clock = time;
    return render(ui, time);
  };
  const get = (part) => required(fixture.host.shadowRoot.querySelector(`[data-ui-part="${part}"]`));
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const pointer = (phase, pointerId, x, y) =>
    ui.input.pointer({
      phase,
      pointerId,
      x,
      y,
      pointerType: 'touch',
      pressure: phase === 'up' ? 0 : 1,
    });
  return {
    facts,
    get ui() {
      return ui;
    },
    element: (part) => get(part),
    movementIntents: () => messages.filter((m) => m.kind === 'move'),
    pointer,
    paint,
    async initialize() {
      const { wasm, font } = await benchmarkHost.resources;
      ui = await createBlitzUi({
        html: startupDocument,
        width: 2532,
        height: 1170,
        pixelRatio: 3,
        font,
        fontFamily: 'Noto Sans SC Variable',
        wasm,
        onError: (error) => {
          facts.errors.push(String(error));
          throw error;
        },
      });
      const host = {
        document: ui.document,
        events: ui.document,
        surface: () => canvas,
        now: () => clock,
        visible: () => true,
        reducedMotion: false,
        reload: () => {
          throw new Error('unexpected reload');
        },
      };
      startup = createStartup(host);
      channel = new MessageChannel();
      channel.port2.addEventListener('message', (e) => {
        if (e.data?.channel === 'game-3d/player-controls') messages.push(e.data);
      });
      channel.port2.start();
      fixture = await installGuideUiFixture(
        required(ui.document.querySelector('#game-ui')),
        { guid: 'mac-ui-owner-guide', html, css },
        channel,
        (values) => fixture.setState({ values, vertexCount: 1216 }),
      );
      await sleep(0);
      const loading = required(ui.document.querySelector('#forgeax-loading'));
      const spinner = required(ui.document.querySelector('#forgeax-loading-spinner'));
      const transform = () => ui.getComputedStyle(spinner).getPropertyValue('transform');
      const initial = paint(0),
        initialTransform = transform(),
        rotated = paint(225),
        rotatedTransform = transform();
      check(
        initial.rgba && rotated.rgba && initialTransform !== rotatedTransform,
        'visible spinner must animate',
      );
      let inputEnabled = false;
      startup.bindInput((value) => {
        inputEnabled = value;
      });
      const receipt = {
        worldIdentity: 'mac-ui-owner-fixture',
        deviceGeneration: 1,
        frameId: 1,
        presentation: 'ready',
      };
      startup.bindSession(receipt.worldIdentity);
      startup.prepare();
      startup.submitted(receipt);
      startup.enter(receipt);
      const fading = paint(250);
      await sleep(180);
      const hidden = paint(450);
      const cached = paint(1000);
      check(
        loading.style.display === 'none' && inputEnabled,
        'real startup lifecycle must finish fade',
      );
      check(hidden.rgba && !cached.rgba, 'hidden startup must stop causing raster');
      check(
        ui.document.querySelector('#forgeax-loading-spinner') === spinner,
        'spinner identity retained',
      );
      loading.style.display = 'grid';
      loading.setAttribute('aria-hidden', 'false');
      const restored = paint(2000),
        restoredTransform = transform();
      check(restoredTransform === initialTransform, 'reshowing must restart spinner at time zero');
      const advanced = paint(2225),
        advancedTransform = transform();
      check(advancedTransform === rotatedTransform, 'reshown spinner must continue normally');
      loading.style.display = 'none';
      paint(2400);
      paint(2700);
      check(paint(3000).rgba === false, 'second hide must remain cached');
      const result = {
        initial,
        initialTransform,
        rotated,
        rotatedTransform,
        fading,
        hidden,
        cached,
        restored,
        restoredTransform,
        advanced,
        advancedTransform,
        inputEnabled,
        loadingDisplay: loading.style.display,
        joystick: rect(get('move-stick')),
        controls: get('touch-controls').getBoundingClientRect().width,
      };
      facts.phases.push({ name: 'startup', ...result });
      return result;
    },
    dispose() {
      startup?.destroy();
      fixture?.dispose();
      channel?.port1.close();
      channel?.port2.close();
      ui?.dispose();
      return facts;
    },
  };
}
