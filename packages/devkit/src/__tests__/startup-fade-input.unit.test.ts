// @vitest-environment jsdom
import { runInNewContext } from 'node:vm';
import { type LoadProgressLabelInput, resolveLoadProgressLabels } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import zhCN from '../../../types/src/locales/load-progress.zh-CN.json';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';

// Runs the emitted startup owner in a real DOM with the default 150 ms fade.
function fixture(input?: LoadProgressLabelInput) {
  const labels = resolveLoadProgressLabels(input);
  document.open();
  document.write(hostStartupDocument('Fade game', labels, { game: 'game-1', engine: 'engine-1' }));
  document.close();
  const inputStates: boolean[] = [];
  const reload = vi.fn();
  const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
  const startup = runInNewContext(hostStartupScript(true, 'host', labels), {
    host: {
      document,
      events: window,
      surface: () => document.querySelector('#app'),
      now: () => performance.now(),
      visible: () => true,
      reducedMotion: false,
      reload,
      clipboard,
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
    clipboard,
    inputSignal,
  };
}

afterEach(() => vi.useRealTimers());

describe('startup overlay fade', () => {
  it.each([
    false,
    true,
    'zh-CN',
  ])('uses one Host text configuration through markup and execution failure (overridden: %s)', async (overridden) => {
    const input =
      overridden === 'zh-CN'
        ? { lang: 'zh-CN' }
        : overridden
          ? {
              lang: 'en-GB',
              reload: 'Restart application',
              host: {
                game: 'Application <version>',
                engine: 'Runtime',
                completedFramesPerSecond: 'Application completed frames',
                startupFailed: 'Application startup unavailable',
                runtimeFailed: 'Application execution unavailable </script>',
                diagnostics: 'Failure details',
                copyDiagnostics: 'Copy <details>',
                diagnosticsCopied: 'Details copied',
                diagnosticsCopyFailed: 'Copy unavailable',
                javascriptRequired: 'Enable the scripting runtime',
              },
            }
          : undefined;
    const labels = resolveLoadProgressLabels(input);
    if (overridden === 'zh-CN') expect(labels.host.copyDiagnostics).toBe(zhCN.host.copyDiagnostics);
    const page = fixture(input);
    try {
      expect(document.documentElement.lang).toBe(labels.lang);
      expect(document.querySelector('#forgeax-status')?.textContent).toBe(
        `${labels.host.game} game-1 | ${labels.host.engine} engine-1 | FPS --`,
      );
      expect(document.querySelector('#forgeax-status version')).toBeNull();
      expect(document.querySelector('#forgeax-fps')?.getAttribute('aria-label')).toBe(
        labels.host.completedFramesPerSecond,
      );
      expect(document.querySelector('#forgeax-fatal-message')?.textContent).toBe(
        labels.host.startupFailed,
      );
      expect(document.querySelector('#forgeax-fatal-diagnostics-title')?.textContent).toBe(
        labels.host.diagnostics,
      );
      expect(document.querySelector('#forgeax-fatal-copy')?.textContent).toBe(
        labels.host.copyDiagnostics,
      );
      expect(document.querySelector('#forgeax-fatal-reload')?.textContent).toBe(labels.reload);
      expect(document.querySelector('noscript')?.textContent).toBe(labels.host.javascriptRequired);

      page.present(1);
      page.startup.fail(
        { code: 'fixture-runtime-fault', message: 'original diagnostic cause' },
        { fault: { phase: 'frame' } },
      );
      expect(document.querySelector('#forgeax-fatal-message')?.textContent).toBe(
        labels.host.runtimeFailed,
      );
      expect(document.querySelector('#forgeax-fatal-details')?.textContent).toContain(
        'fixture-runtime-fault: original diagnostic cause',
      );
      const copy = document.querySelector<HTMLButtonElement>('#forgeax-fatal-copy');
      copy?.click();
      await vi.waitFor(() =>
        expect(document.querySelector('#forgeax-fatal-copy-status')?.textContent).toBe(
          labels.host.diagnosticsCopied,
        ),
      );
      expect(page.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('fixture-runtime-fault'),
      );
      page.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard denied'));
      copy?.click();
      await vi.waitFor(() =>
        expect(document.querySelector('#forgeax-fatal-copy-status')?.textContent).toBe(
          labels.host.diagnosticsCopyFailed,
        ),
      );
    } finally {
      page.startup.destroy();
    }
  });

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

  it('keeps the game UI interactive when an App binds or unbinds after the first frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture();
    const gameUi = document.querySelector<HTMLElement>('#game-ui');
    if (gameUi === null) throw new Error('startup document is missing #game-ui');
    try {
      expect(gameUi.inert).toBe(true);
      page.present(1);
      await vi.advanceTimersByTimeAsync(150);
      expect(gameUi.inert).toBe(false);
      const late: boolean[] = [];
      const unbind = page.startup.bindInput((enabled: boolean) => late.push(enabled));
      expect(late).toEqual([true]);
      expect(gameUi.inert).toBe(false);
      unbind();
      expect(late).toEqual([true, false]);
      expect(gameUi.inert).toBe(false);
      expect(page.inputSignal()).toBe('open');
    } finally {
      page.startup.destroy();
    }
    expect(gameUi.inert).toBe(false);
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
