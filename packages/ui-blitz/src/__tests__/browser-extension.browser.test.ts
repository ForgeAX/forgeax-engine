import { createUiLoader, mountUi } from '@forgeax/engine-ui';
import { expect, it } from 'vitest';
import { createBlitzUi } from '../index.js';
import { required } from './fixture.js';

it('keeps the real Brotato browser blur and rejects its declaration before mutating a native document', async () => {
  const pack = await (
    await fetch(
      new URL('../../../../apps/showcase/brotato-3d/assets/ui/hud.pack.json', import.meta.url),
    )
  ).json();
  const loaded = createUiLoader().load({
    guid: 'brotato-browser-hud',
    sourcePath: 'hud.ui.html',
    ...pack.assets['ui/hud'].payload,
  });
  if (!loaded.ok) throw loaded.error;
  const root = document.createElement('section');
  root.style.cssText =
    'position:absolute;left:0;top:0;width:900px;height:600px;background:repeating-conic-gradient(#0c718d 0 25%,#663859 0 50%) 0/36px 36px';
  document.body.append(root);
  const bytes = new Uint8Array(
    await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
  );
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html: '<p>Existing UI</p>',
    width: 900,
    height: 600,
    onError: (cause) => {
      throw cause;
    },
  });
  const nativeRoot = required(ui.document.body);
  const before = nativeRoot.innerHTML;
  const rejected = mountUi(loaded.value, { root: nativeRoot, layer: 1 });
  expect(rejected).toMatchObject({
    ok: false,
    error: {
      code: 'invalid-environment',
      detail: {
        diagnostics: [
          expect.objectContaining({
            code: 'ui-browser-extension-unavailable',
            sourcePath: 'hud.ui.css',
          }),
        ],
      },
    },
  });
  expect(nativeRoot.innerHTML).toBe(before);
  const mounted = mountUi(loaded.value, { root, layer: 1 });
  if (!mounted.ok) throw mounted.error;
  try {
    const card = required(mounted.value.host.shadowRoot?.querySelector('.brotato3d-card'));
    expect(getComputedStyle(card).backdropFilter).toBe('blur(10px)');
    expect(card.textContent).toContain('BROTATO 3D / NEON HARVEST');
  } finally {
    mounted.value.dispose();
    ui.dispose();
    root.remove();
  }
});
