// @vitest-environment jsdom
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';

// Runs the emitted startup owner in a real DOM with the default 150 ms fade.
function fixture() {
  document.open();
  document.write(hostStartupDocument('Fade game'));
  document.close();
  const inputStates: boolean[] = [];
  const reload = vi.fn();
  const startup = runInNewContext(hostStartupScript(true, 'host'), {
    host: {
      document,
      events: window,
      surface: () => document.querySelector('#app'),
      now: () => performance.now(),
      visible: () => true,
      reducedMotion: false,
      reload,
    },
    MutationObserver,
    setTimeout,
    clearTimeout,
  });
  startup.bindInput((enabled: boolean) => inputStates.push(enabled));
  startup.bindSession('world');
  startup.prepare();
  const present = (frameId: number, deviceGeneration = 1) => {
    const detail = { frameId, deviceGeneration, presentation: 'ready', worldIdentity: 'world' };
    startup.submitted(detail);
    startup.enter(detail);
  };
  const loading = document.querySelector<HTMLElement>('#forgeax-loading');
  const loadingReload = document.querySelector<HTMLButtonElement>('#forgeax-loading-reload');
  if (loading === null || loadingReload === null) throw new Error('startup document is incomplete');
  const canvas = () => {
    const current = document.querySelector<HTMLCanvasElement>('#app');
    if (current === null) throw new Error('startup canvas missing');
    return current;
  };
  const click = () => {
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    canvas().dispatchEvent(event);
    return event;
  };
  const inputSignal = () => document.documentElement.getAttribute('data-forgeax-input');
  return {
    startup,
    present,
    inputStates,
    loading,
    loadingReload,
    canvas,
    click,
    reload,
    inputSignal,
  };
}

afterEach(() => vi.useRealTimers());

describe('startup overlay fade', () => {
  it('admits gameplay input as soon as the first frame is presentable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture();
    try {
      expect(page.inputStates.at(-1)).toBe(false);
      expect(page.inputSignal()).toBe('closed');
      expect(page.click().defaultPrevented).toBe(true);

      page.present(1);
      expect(page.inputSignal()).toBe('open');
      // The fade is presentation only: input opens with the first ready frame,
      // and the fading overlay no longer intercepts canvas hits.
      expect(page.loading.dataset.fading).toBe('true');
      expect(page.inputStates.at(-1)).toBe(true);
      expect(page.click().defaultPrevented).toBe(false);
      expect(getComputedStyle(page.loading).pointerEvents).toBe('none');

      await vi.advanceTimersByTimeAsync(150);
      expect(page.loading.style.display).toBe('none');
      expect(page.inputStates.at(-1)).toBe(true);
    } finally {
      page.startup.destroy();
    }
  });

  it('closes input again when a replacement device cancels the fade', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture();
    try {
      page.present(1);
      expect(page.inputStates.at(-1)).toBe(true);
      page.startup.submitted({ frameId: 1, deviceGeneration: 2, worldIdentity: 'world' });
      expect(page.loading.dataset.fading).toBe('false');
      expect(page.loading.getAttribute('aria-hidden')).toBe('false');
      expect(page.inputStates.at(-1)).toBe(false);
      expect(page.click().defaultPrevented).toBe(true);

      page.present(2, 2);
      expect(page.inputStates.at(-1)).toBe(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(page.loading.style.display).toBe('none');
    } finally {
      page.startup.destroy();
    }
  });

  it('releases slow-start Reload focus so fade-time keys reach only the game', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture();
    const gameKeys: string[] = [];
    const onKey = (event: KeyboardEvent) => gameKeys.push(event.key);
    window.addEventListener('keydown', onKey);
    try {
      page.loadingReload.style.display = 'inline-block';
      page.loadingReload.focus();
      expect(document.activeElement).toBe(page.loadingReload);

      page.present(1);
      expect(document.activeElement).not.toBe(page.loadingReload);
      expect(page.loading.inert).toBe(true);
      for (const key of ['Enter', ' ']) {
        page.loadingReload.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        page.loadingReload.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      expect(page.reload).not.toHaveBeenCalled();
      expect(gameKeys).toEqual(['Enter', ' ']);

      // A fade that falls back to preparation restores the startup control.
      page.startup.submitted({ frameId: 1, deviceGeneration: 2, worldIdentity: 'world' });
      expect(page.loading.inert).toBe(false);
      page.loadingReload.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(page.reload).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('keydown', onKey);
      page.startup.destroy();
    }
  });

  it('closes input as soon as the presenting canvas element is replaced mid-fade', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture();
    try {
      page.present(1);
      expect(page.inputStates.at(-1)).toBe(true);
      const retired = page.canvas();
      retired.replaceWith(retired.cloneNode(false));
      await Promise.resolve();
      expect(page.inputStates.at(-1)).toBe(false);
      expect(page.inputSignal()).toBe('closed');
      expect(page.loading.getAttribute('aria-hidden')).toBe('false');
      expect(page.click().defaultPrevented).toBe(true);

      page.present(2, 2);
      expect(page.inputSignal()).toBe('open');
      await vi.advanceTimersByTimeAsync(150);
      expect(page.loading.style.display).toBe('none');
    } finally {
      page.startup.destroy();
    }
  });

  it('keeps the readiness signal closed on the fatal path', () => {
    const page = fixture();
    try {
      page.startup.fail(new Error('boot failed'));
      expect(page.loading.getAttribute('aria-hidden')).toBe('true');
      expect(page.inputSignal()).toBe('closed');
    } finally {
      page.startup.destroy();
    }
  });
});
