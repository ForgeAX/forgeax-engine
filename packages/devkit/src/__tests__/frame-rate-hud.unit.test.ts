// @vitest-environment jsdom
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';

function fixture(native = true, search = '') {
  document.open();
  document.write(
    hostStartupDocument('FPS game', undefined, { game: '1.2.3', engine: 'abcdef123456' }),
  );
  document.close();
  let visible = true;
  const host = {
    document,
    events: window,
    surface: () => document.querySelector('#app'),
    now: () => performance.now(),
    visible: () => visible,
    reducedMotion: true,
    reload: vi.fn(),
  };
  const startup = runInNewContext(hostStartupScript(true, native ? 'host' : 'undefined'), {
    host,
    document,
    window,
    HTMLElement,
    Node,
    location: { search },
    URLSearchParams,
    performance,
    setTimeout,
    clearTimeout,
  });
  startup.bindSession('world');
  startup.prepare();
  const receive = (id: number, generation = 1, presentation = 'ready', world = 'world') => {
    const detail = {
      frameId: id,
      deviceGeneration: generation,
      presentation,
      worldIdentity: world,
    };
    if (native) {
      startup.submitted(detail);
      startup.enter(detail);
    } else {
      const canvas = document.querySelector('#app');
      if (canvas === null) throw new Error('Missing game canvas');
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-submitted', { detail }));
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-completed', { detail }));
    }
  };
  return {
    startup,
    receive,
    hud: () => document.querySelector<HTMLElement>('#forgeax-fps'),
    status: () => document.querySelector<HTMLElement>('#forgeax-status'),
    visibility(next: boolean) {
      visible = next;
      startup.visibilityChanged();
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('ordinary game FPS HUD', () => {
  it.each([
    true,
    false,
  ])('counts completed scene receipts after startup (native=%s)', async (native) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture(native);
    try {
      page.receive(1);
      await vi.advanceTimersByTimeAsync(150);
      for (let i = 2; i <= 31; i++) page.receive(i);
      page.receive(31); // Duplicate and pending/error UI receipts do not inflate FPS.
      page.receive(32, 1, 'pending');
      page.receive(33, 1, 'ready', 'retired-world');
      await vi.advanceTimersByTimeAsync(850);
      expect(page.hud()?.textContent).toBe('FPS 30.0');
      expect(page.status()?.textContent).toBe('Game 1.2.3 | Engine abcdef123456 | FPS 30.0');
      expect(page.status()?.style.display).toBe('block');
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('FPS 0.0');
    } finally {
      page.startup.destroy();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('omits game diagnostics from workspace pages', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture(false, '?forgeaxWorkspace=preview');
    try {
      page.receive(1);
      await vi.advanceTimersByTimeAsync(150);
      for (let i = 2; i <= 31; i++) page.receive(i);
      await vi.advanceTimersByTimeAsync(2000);
      expect(page.status()?.style.display).not.toBe('block');
      expect(page.hud()?.textContent).toBe('FPS --');
    } finally {
      page.startup.destroy();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets on visibility/device changes and stops on failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture();
    try {
      page.receive(50);
      await vi.advanceTimersByTimeAsync(100);
      page.receive(51);
      page.visibility(false);
      await vi.advanceTimersByTimeAsync(4000);
      expect(page.status()?.style.display).toBe('none');
      page.visibility(true);
      page.receive(60);
      page.receive(61);
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('FPS 1.0');
      page.receive(1, 2);
      page.receive(62, 1); // Old device completion cannot replace the new baseline.
      page.receive(2, 2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('FPS 1.0');
      page.startup.fail(new Error('device lost'), { fault: { code: 'device-lost' } });
      expect(page.status()?.style.display).toBe('none');
      await vi.advanceTimersByTimeAsync(0); // jsdom queues the focused Reload control's event.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      page.startup.destroy();
    }
  });

  it('starts a fresh device baseline when a replacement canvas owns a new Renderer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture(false);
    try {
      page.receive(50, 2);
      await vi.advanceTimersByTimeAsync(150);
      page.receive(51, 2);
      await vi.advanceTimersByTimeAsync(850);
      expect(page.hud()?.textContent).toBe('FPS 1.0');

      const retired = document.querySelector('#app');
      if (retired === null) throw new Error('Missing game canvas');
      retired.replaceWith(retired.cloneNode(false));
      page.receive(1, 0);
      page.receive(2, 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('FPS 1.0');
    } finally {
      page.startup.destroy();
    }
  });

  it('resumes after a persisted pagehide/pageshow round trip', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture(false);
    try {
      page.receive(1);
      await vi.advanceTimersByTimeAsync(150);
      page.receive(2);
      await vi.advanceTimersByTimeAsync(850);
      expect(page.hud()?.textContent).toBe('FPS 1.0');

      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      expect(page.status()?.style.display).toBe('none');
      await vi.advanceTimersByTimeAsync(4000);
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      page.receive(3);
      page.receive(4);
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('FPS 1.0');
      expect(page.status()?.style.display).toBe('block');
    } finally {
      page.startup.destroy();
    }
  });
});
