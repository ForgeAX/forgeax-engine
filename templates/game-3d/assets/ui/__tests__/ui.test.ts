import { Context } from '@forgeax/engine/plugin';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';
import { uiAssetContribution } from '@forgeax/engine/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ui as uiPlugin } from '../ui.pack.ts';

const { dispose, mountUi, label, hint, toggle, hud, touch } = vi.hoisted(() => ({
  touch: { dispose: vi.fn(), reset: vi.fn(), setEnabled: vi.fn() },
  dispose: vi.fn(), toggle: vi.fn(), label: { textContent: '' }, hint: { textContent: '' },
  hud: { dispose: vi.fn() },
  mountUi: vi.fn(() => ({ ok: true, value: {
    dispose, signal: new AbortController().signal,
    host: { classList: { toggle }, shadowRoot: { querySelector: (s: string) => (s === '[data-ui-slot="lock"]' ? label : s === '[data-ui-slot="hint"]' ? hint : null) } },
  } })),
}));
const installPlayerHud = vi.hoisted(() => vi.fn(() => hud));
const installPlayerControls = vi.hoisted(() => vi.fn(() => touch));
vi.mock('../player-controls.ts', () => ({ installPlayerControls }));
vi.mock('../player-hud.ts', () => ({ installPlayerHud }));
vi.mock('@forgeax/engine/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine/ui')>()),
  mountUi,
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const GUIDE = '019fb7ce-3600-7000-8000-000000000001';

function hostFixture(ports: { port?: MessagePort; presentationPort?: MessagePort } = {}) {
  const events = new EventTarget();
  let mode: 'pointer' | 'pointer-locked' | 'touch' = 'pointer';
  const controlMode = {
    read: () => mode,
    subscribe: (listener: () => void) => {
      events.addEventListener('change', listener);
      return () => events.removeEventListener('change', listener);
    },
  };
  const ctx = new Context();
  const packageUrl = 'https://game-3d.invalid/ui.pack.json';
  const kind = uiAssetContribution.kind.kind;
  const { pack, publication } = createRuntimePackPublication({
    scopeId: 'asset-runtime', sourcePath: 'ui.pack.json', sourceRevision: '1', packageUrl,
    pack: { assets: [{ guid: GUIDE, kind, payload: { guid: GUIDE, html: '<main></main>', css: '' }, refs: [], artifacts: {} }] },
  });
  const assets = new AssetRegistry({
    catalog: createCatalogSource({
      entries: [{ guid: GUIDE, kind, packageUrl, sourcePath: 'ui.pack.json', publication }],
      fetch: async () => new Response(JSON.stringify(pack)),
    }),
  });
  vi.spyOn(assets, 'release');
  ctx.provide('gameHost', { uiRoot: {}, controlMode, ...ports } as never);
  ctx.provide('assets', assets);
  ctx.effect(() => () => assets.dispose());
  return { ctx, assets, setMode(value: typeof mode) { mode = value; events.dispatchEvent(new Event('change')); } };
}

describe('game-3d Host UI lifecycle', () => {
  it('wires the HUD through the presentation port and releases them on dispose', async () => {
    const channel = new MessageChannel();
    const { ctx, assets } = hostFixture({ port: channel.port2, presentationPort: channel.port1 });
    try {
      const fiber = await ctx.plugin(uiPlugin, { guide: GUIDE });
      expect((installPlayerHud.mock.calls as unknown[][])[0]?.[1]).toBe(channel.port1);
      await fiber.dispose();
      expect(assets.release).toHaveBeenCalledTimes(1);
      expect(hud.dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.fiber.dispose();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('follows pointer lock and touch mode without a World', async () => {
    const { ctx, setMode } = hostFixture();
    try {
      const fiber = await ctx.plugin(uiPlugin, { guide: GUIDE });
      expect(label.textContent).toContain('Click to lock camera');
      expect(installPlayerHud).not.toHaveBeenCalled();
      setMode('pointer-locked');
      expect(label.textContent).toContain('Camera locked');
      expect(toggle).toHaveBeenLastCalledWith('locked', true);
      expect(toggle).toHaveBeenCalledWith('aim', false);
      expect(toggle).not.toHaveBeenCalledWith('aim', true);
      setMode('touch');
      expect(hint.textContent).toContain('Stick move');
      expect(hint.textContent).not.toContain('WASD');
      await fiber.dispose();
    } finally { await ctx.fiber.dispose(); }
  });

  it('shows the crosshair only when enabled and the pointer is locked', async () => {
    const { ctx, setMode } = hostFixture();
    try {
      const fiber = await ctx.plugin(uiPlugin, { guide: GUIDE, crosshair: true });
      expect(toggle).toHaveBeenCalledWith('aim', false);
      expect(toggle).not.toHaveBeenCalledWith('aim', true);
      toggle.mockClear();
      setMode('pointer-locked');
      expect(toggle).toHaveBeenCalledWith('aim', true);
      toggle.mockClear();
      setMode('pointer');
      expect(toggle).toHaveBeenCalledWith('aim', false);
      await fiber.dispose();
    } finally { await ctx.fiber.dispose(); }
  });
});
