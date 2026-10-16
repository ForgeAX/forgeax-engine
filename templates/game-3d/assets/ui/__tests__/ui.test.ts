import { Context } from '@forgeax/engine/plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ui as uiPlugin } from '../ui.pack.ts';

const { dispose, mountUi, label, toggle, signal, button, status, player, disposeVase, installPlayerControls, installVaseControls } = vi.hoisted(() => {
  const signal = new AbortController().signal;
  const dispose = vi.fn();
  const toggle = vi.fn();
  const label = { textContent: '' };
  const button = { setAttribute: vi.fn() };
  const status = { textContent: '' };
  const player = { dispose: vi.fn(), reset: vi.fn(), setEnabled: vi.fn() };
  const disposeVase = vi.fn();
  return { dispose, toggle, label, signal, button, status, player, disposeVase,
    installPlayerControls: vi.fn((_root: ShadowRoot, _port: MessagePort) => player),
    installVaseControls: vi.fn((_root: ShadowRoot, _port: MessagePort) => ({ localize: vi.fn(), dispose: disposeVase })),
    mountUi: vi.fn(() => ({ ok: true, value: {
    dispose, signal, host: { classList: { toggle }, shadowRoot: { querySelector: (selector: string) => {
      if (selector === '[data-ui-slot="lock"]') return label;
      if (selector === '[data-ui-part="vase-controls"] button') return button;
      if (selector === '[data-ui-part="vase-status"]') return status;
      return null;
    } } },
  } })) };
});
vi.mock('../player-controls.ts', () => ({ installPlayerControls }));
vi.mock('../vase-controls.ts', () => ({ installVaseControls }));
vi.mock('@forgeax/engine/ui', () => ({ mountUi, createUiLoader: () => ({ load: () => ({ ok: true, value: {} }) }) }));
vi.mock('@forgeax/engine/ui/localization', () => ({
  createUiLocalization: async () => ({ ok: true, value: { t: (key: string) => key === 'vase.unavailable' ? 'Vase generation is unavailable in this host.' : key === 'lock' ? 'Camera locked' : key === 'touchUnavailable' ? 'Touch controls need a connected game' : key === 'touch' ? 'Touch to interact' : 'Click to lock camera' } }),
  bindUiLocalization: (_ui: unknown, _i18n: unknown, render: () => void) => { render(); return () => {}; },
}));
vi.mock('../../shared/guid.ts', () => ({
  authoredGuid: () => ({ ok: true, value: new Uint8Array(16) }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function hostFixture(ports: { port?: MessagePort; presentationPort?: MessagePort } = {}) {
  const events = new EventTarget();
  let mode: 'pointer' | 'pointer-locked' | 'touch' = 'pointer';
  const root = {};
  const controlMode = {
    read: () => mode,
    subscribe: (listener: () => void) => {
      events.addEventListener('change', listener);
      return () => events.removeEventListener('change', listener);
    },
  };
  const ctx = new Context();
  ctx.provide('gameHost', { uiRoot: root, controlMode, ...ports } as never);
  ctx.provide('assets', { installDecoder: () => ({ dispose() {} }), load: async () => ({ ok: true, value: {} }) } as never);
  return { ctx, root, controlMode, setMode(value: typeof mode) { mode = value; events.dispatchEvent(new Event('change')); } };
}

describe('game-3d Host UI lifecycle', () => {
  it.each(['worker', 'same-realm'] as const)('routes both controllers through the %s presentation endpoint', async (realm) => {
    const channel = new MessageChannel();
    const { ctx, setMode } = hostFixture(realm === 'worker'
      ? { port: channel.port1 }
      : { port: channel.port2, presentationPort: channel.port1 });
    try {
      setMode('touch');
      const fiber = await ctx.plugin(uiPlugin, { guide: '019fb7ce-3600-7000-8000-000000000001' });
      expect(installPlayerControls).toHaveBeenCalledTimes(1);
      expect(installPlayerControls.mock.calls[0]?.[1]).toBe(channel.port1);
      expect(installVaseControls).toHaveBeenCalledTimes(1);
      expect(installVaseControls.mock.calls[0]?.[1]).toBe(channel.port1);
      expect(label.textContent).toBe('Touch to interact');
      expect(player.setEnabled).toHaveBeenLastCalledWith(true);
      await fiber.dispose();
      expect(player.dispose).toHaveBeenCalledTimes(1);
      expect(disposeVase).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.fiber.dispose();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('disposes the mounted UI when input listener installation fails', async () => {
    const { ctx, controlMode } = hostFixture();
    try {
      vi.spyOn(controlMode, 'subscribe').mockImplementationOnce(() => {
        throw new Error('listener unavailable');
      });
      await expect(ctx.plugin(uiPlugin, { guide: '019fb7ce-3600-7000-8000-000000000001' })).rejects.toThrow('listener unavailable');
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('updates from Host pointer lock without a World and removes listeners on each disposal', async () => {
    const { ctx, root, setMode } = hostFixture();
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        setMode('pointer');
        const fiber = await ctx.plugin(uiPlugin, { guide: '019fb7ce-3600-7000-8000-000000000001' });
        expect(label.textContent).toContain('Click to lock camera');
        expect(mountUi).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ root }));
        setMode('pointer-locked');
        expect(label.textContent).toContain('Camera locked');
        expect(toggle).toHaveBeenLastCalledWith('locked', true);
        await fiber.dispose();
        expect(dispose).toHaveBeenCalledTimes(cycle + 1);
        setMode('pointer');

        expect(label.textContent).toContain('Camera locked');
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('uses actual touch capability without global document or synthetic pointer lock', async () => {
    const { ctx, setMode } = hostFixture();
    try {
      setMode('touch');
      const fiber = await ctx.plugin(uiPlugin, { guide: '019fb7ce-3600-7000-8000-000000000001' });
      expect(label.textContent).toBe('Touch controls need a connected game');
      expect(toggle).toHaveBeenCalledWith('controls-ready', false);
      expect(toggle).toHaveBeenCalledWith('vase-open', false);
      expect(toggle).toHaveBeenLastCalledWith('locked', false);
      expect(installPlayerControls).not.toHaveBeenCalled();
      expect(installVaseControls).not.toHaveBeenCalled();
      expect(button.setAttribute).toHaveBeenCalledWith('disabled', '');
      expect(status.textContent).toBe('Vase generation is unavailable in this host.');
      await fiber.dispose();
    } finally { await ctx.fiber.dispose(); }
  });
});
