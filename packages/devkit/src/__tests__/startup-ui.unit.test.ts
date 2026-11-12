// @vitest-environment jsdom
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';
import { type StartupUiOptions, validateStartupUi } from '../host/startup-ui.js';

function fixture(ui: StartupUiOptions, browser = false) {
  document.open();
  document.write(hostStartupDocument('My Game', undefined, undefined, ui));
  document.close();
  const reload = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  // The same code runs through browser globals and the native Host port.
  const host = {
    document,
    events: window,
    surface: () => document.querySelector('#app'),
    now: () => performance.now(),
    visible: () => true,
    reducedMotion: false,
    reload,
    clipboard: { writeText },
  };
  const startup = runInNewContext(
    hostStartupScript(true, browser ? 'undefined' : 'host', undefined, undefined, ui),
    {
      host,
      document,
      window,
      HTMLElement,
      Node,
      console,
      setTimeout,
      clearTimeout,
      location: { search: '', reload },
      navigator: { clipboard: { writeText } },
    },
  );
  startup.bindSession('world');
  const present = (worldIdentity = 'world', presentation = 'ready') => {
    const detail = { worldIdentity, presentation, frameId: 1, deviceGeneration: 1 };
    startup.submitted(detail);
    startup.enter(detail);
  };
  return { startup, reload, writeText, present };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('project startup presentation', () => {
  it.each([
    false,
    true,
  ])('allows a black screen without bypassing readiness (browser=%s)', async (browser) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = fixture({ loading: 'none', failure: 'none' }, browser);
    try {
      expect(document.querySelector('#forgeax-loading')).toBeNull();
      expect(document.querySelector('#forgeax-fatal')).toBeNull();
      expect(
        getComputedStyle(document.querySelector('#app-shell') as HTMLElement).backgroundColor,
      ).toBe('rgb(0, 0, 0)');
      expect(document.documentElement.dataset.forgeaxInput).toBe('closed');
      page.startup.prepare();
      page.present('stale-world');
      expect(document.documentElement.dataset.forgeaxInput).toBe('closed');
      page.present();
      expect(document.documentElement.dataset.forgeaxInput).toBe('open');
      await vi.advanceTimersByTimeAsync(150);
      page.startup.fail({ code: 'runtime-broken', hint: 'recover game' }, { fault: {} });
      expect(document.documentElement.dataset.forgeaxInput).toBe('closed');
      expect(page.startup.inspect()).toMatchObject({
        phase: 'failed',
        diagnostics: expect.stringContaining('runtime-broken'),
      });
      expect(console.warn).toHaveBeenCalledWith(
        '[ForgeAX game failure]',
        expect.any(String),
        expect.stringContaining('runtime-broken'),
      );
    } finally {
      page.startup.destroy();
    }
  });

  it('replaces both trees, streams state, copies data without built-in nodes, and disposes callbacks', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = fixture({
      loading: {
        html: '<h1 id="custom-loading">My studio</h1>',
        css: '#forgeax-loading { display: flex; color: red; background: rgb(16, 21, 27); }',
        script: `const label = screen.root.querySelector('h1');
          screen.subscribe(state => { label.textContent = state.progress.percent + ':' + state.phase + ':' + state.slow; });
          return () => { screen.document.body.dataset.loadingDisposed = 'yes'; };`,
      },
      failure: {
        css: '#forgeax-fatal { display: flex; }',
        html: '<p></p><button>Copy</button><button id="retry">Try again</button>',
        script: `screen.subscribe(state => { screen.root.querySelector('p').textContent = state.message + state.diagnostics + ':' + state.copyStatus; });
          screen.root.querySelector('button').addEventListener('click', () => screen.copyDiagnostics());
          screen.root.querySelector('#retry').addEventListener('click', screen.reload);
          return () => { screen.document.body.dataset.failureDisposed = 'yes'; };`,
      },
    });
    try {
      expect(document.querySelector('#forgeax-loading-brand')).toBeNull();
      expect(getComputedStyle(document.querySelector('h1') as HTMLElement).color).toBe(
        'rgb(255, 0, 0)',
      );
      expect(document.querySelector('#forgeax-fatal-details')).toBeNull();
      expect(
        getComputedStyle(document.querySelector('#forgeax-loading') as HTMLElement).display,
      ).toBe('flex');
      expect(
        getComputedStyle(document.querySelector('#forgeax-fatal') as HTMLElement).display,
      ).toBe('none');
      expect(
        getComputedStyle(document.querySelector('#forgeax-loading') as HTMLElement).backgroundColor,
      ).toBe('rgb(16, 21, 27)');
      page.startup.progress({ percent: 42, activity: 'Textures', detail: 'x', elapsed: '1 s' });
      expect(document.querySelector('h1')?.textContent).toBe('42:loading:false');
      await vi.advanceTimersByTimeAsync(15000);
      expect(document.querySelector('h1')?.textContent).toBe('42:loading:true');
      page.startup.fail({ code: 'assets-missing', hint: 'Upload pack' });
      expect(document.querySelector('#forgeax-loading')?.getAttribute('style')).toContain(
        'display: none',
      );
      expect(document.querySelector('#forgeax-fatal p')?.textContent).toContain('assets-missing');
      expect(
        getComputedStyle(document.querySelector('#forgeax-fatal') as HTMLElement).display,
      ).toBe('flex');
      (document.querySelector('#forgeax-fatal button') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(0);
      expect(page.writeText).toHaveBeenCalledWith(expect.stringContaining('Upload pack'));
      expect(document.querySelector('#forgeax-fatal p')?.textContent).toContain(':copied');
      (document.querySelector('#retry') as HTMLButtonElement).click();
      expect(page.reload).toHaveBeenCalledOnce();
      expect(document.body.dataset.loadingDisposed).toBe('yes');
      expect(document.body.dataset.failureDisposed).toBe('yes');
    } finally {
      page.startup.destroy();
    }
  });

  it('retires the custom loading script after readiness and keeps failure presentation available', async () => {
    vi.useFakeTimers();
    const page = fixture({
      loading: {
        html: '<p>Only my game</p>',
        script: `screen.subscribe(state => { screen.root.dataset.phase = state.phase; }); return () => { screen.root.dataset.disposed = 'yes'; };`,
      },
    });
    try {
      page.startup.prepare();
      page.present();
      expect(document.querySelector('#forgeax-loading')?.getAttribute('data-phase')).toBe('fading');
      await vi.advanceTimersByTimeAsync(150);
      expect(document.querySelector('#forgeax-loading')?.getAttribute('data-disposed')).toBe('yes');
      expect(document.querySelector('#forgeax-fatal-message')).not.toBeNull();
    } finally {
      page.startup.destroy();
    }
  });

  it('contains presentation exceptions without admitting input or losing diagnostics', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = fixture({
      loading: { html: '<p>Game</p>', script: 'throw new Error("broken theme");' },
    });
    try {
      expect(document.documentElement.dataset.forgeaxInput).toBe('closed');
      page.startup.fail(new Error('original failure'));
      expect(document.querySelector('#forgeax-fatal-details')?.textContent).toContain(
        'original failure',
      );
    } finally {
      page.startup.destroy();
    }
  });

  it('validates the closed configuration and parses scripts before generating hosts', () => {
    expect(() =>
      validateStartupUi({
        loading: 'none',
        failure: { html: '', css: '', script: 'return () => {};' },
      }),
    ).not.toThrow();
    for (const input of [
      { foo: true },
      { loading: false },
      { failure: { html: '', other: '' } },
      { loading: { html: '<script>bad()</script>' } },
      { loading: { html: '', script: 'import x from "x";' } },
    ])
      expect(() => validateStartupUi(input)).toThrow();
  });
});
