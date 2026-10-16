import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine/ui';
import { CheckList, defineFeature } from '../../lab/feature';
import {
  discTexture,
  spawnOrthoCamera,
  spawnSprite,
  spriteMaterial,
  spriteMaterialAsset,
} from './_shared/sprite';

const HUD: UiAsset = {
  guid: 'feature-lab/2d/hud',
  html: '<header class="bar"><span>HP</span><div class="fill"></div></header><button data-ui-action="pause">Pause</button>',
  css: [
    '.bar { position: absolute; left: 4%; right: 4%; top: 6%; height: 22%; display: flex; align-items: center; gap: 24px;',
    '  padding: 0 32px; background: #1c64f2; border: 6px solid #ffffff; border-radius: 18px; font: 700 64px sans-serif; color: #fff; }',
    '.fill { flex: 1; height: 50%; background: linear-gradient(90deg, #22e36b, #f7e733); border-radius: 12px; }',
    'button { position: absolute; right: 4%; bottom: 8%; font: 700 40px sans-serif; padding: 16px 40px; background: #ff3d81; color: #fff; border: 0; }',
  ].join('\n'),
};

export default defineFeature({
  title: 'Prepared UiAsset',
  catalog: 'Prepared UiAsset',
  kind: 'visual',
  summary:
    'mountUi places a prepared HTML/CSS UiAsset over the canvas in an open ShadowRoot at a z-index layer; the UiInstance owns an AbortSignal and an idempotent dispose. The game scene behind it is an ordinary sprite.',
  expect:
    'ON: a blue HP bar with a green-yellow fill spans the top and a pink Pause button sits bottom-right over the canvas. OFF: the instance is disposed, only the orange sprite remains. Checks cover the ShadowRoot, layer, action dispatch, abort and structured errors.',
  setup({ canvas, world }) {
    const root = canvas.parentElement;
    if (root === null) throw new Error('canvas has no parent');
    spawnOrthoCamera(world, canvas);
    spawnSprite(
      world,
      spriteMaterial(world, spriteMaterialAsset(discTexture(world), [1, 0.5, 0.1, 1])),
      [0, -0.3, 0],
      2.2,
    );
    const actions: string[] = [];
    let instance: UiInstance | undefined;
    const mount = (): void => {
      const mounted = mountUi(HUD, { root, layer: 3, onAction: (name) => actions.push(name) });
      if (!mounted.ok) throw new Error(`mountUi: ${mounted.error.code}`);
      instance = mounted.value;
    };
    mount();
    return {
      toggle(on) {
        if (on && instance === undefined) mount();
        if (!on && instance !== undefined) {
          instance.dispose();
          instance = undefined;
        }
      },
      checks() {
        const c = new CheckList();
        const probe = mountUi(HUD, {
          root,
          layer: 7,
          onAction: (name) => actions.push(`probe:${name}`),
        });
        c.ok('mountUi succeeds', probe.ok);
        if (probe.ok) {
          const ui = probe.value;
          c.equal('host is tagged with the asset guid', ui.host.dataset.uiAsset, HUD.guid);
          c.ok('host has an open ShadowRoot', ui.host.shadowRoot !== null);
          c.equal('layer becomes z-index', ui.host.style.zIndex, '7');
          c.ok(
            'document-level CSS does not leak into the shadow content',
            document.querySelector('.bar') === null,
          );
          (ui.host.shadowRoot?.querySelector('button') as HTMLButtonElement | null)?.click();
          c.ok(
            'data-ui-action click reaches onAction',
            actions.includes('probe:pause'),
            actions.join(','),
          );
          ui.dispose();
          ui.dispose();
          c.ok('dispose aborts the signal', ui.signal.aborted);
          c.ok('dispose removes the host and is idempotent', !ui.host.isConnected);
        }
        const badLayer = mountUi(HUD, { root, layer: -1 });
        c.equal(
          'negative layer is invalid-layer',
          badLayer.ok ? 'ok' : badLayer.error.code,
          'invalid-layer',
        );
        const badAsset = mountUi({ guid: '', html: '', css: '' }, { root, layer: 0 });
        c.equal(
          'empty guid is invalid-asset',
          badAsset.ok ? 'ok' : badAsset.error.code,
          'invalid-asset',
        );
        return c.items;
      },
    };
  },
});
