// @vitest-environment jsdom
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';

function fixture(native = true, search = '') {
  document.open();
  document.write(
    hostStartupDocument('Render FPS game', undefined, { game: '1.2.3', engine: 'abcdef123456' }),
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
    gap: () => document.querySelector<HTMLElement>('#forgeax-frame-gap'),
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
      expect(page.hud()?.textContent).toBe('Render FPS 30.0');
      expect(page.status()?.textContent).toBe(
        'Game 1.2.3 | Engine abcdef123456 | Render FPS 30.0 850 ms max gap',
      );
      expect(page.status()?.style.display).toBe('block');
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('Render FPS 0.0');
    } finally {
      page.startup.destroy();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows completed-frame cadence even when the same number of receipts arrive in a burst', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const page = fixture(false);
    try {
      page.receive(1);
      await vi.advanceTimersByTimeAsync(150);
      page.receive(2);
      await vi.advanceTimersByTimeAsync(250);
      page.receive(3);
      await vi.advanceTimersByTimeAsync(400);
      page.receive(4);
      await vi.advanceTimersByTimeAsync(200);
      expect(page.hud()?.textContent).toBe('Render FPS 3.0');
      expect(page.gap()?.textContent).toBe('400 ms max gap');

      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('Render FPS 0.0');
      expect(page.gap()?.textContent).toBe('1200 ms max gap');

      page.receive(1, 2);
      await vi.advanceTimersByTimeAsync(50);
      page.receive(2, 2);
      await vi.advanceTimersByTimeAsync(950);
      expect(page.gap()?.textContent).toBe('950 ms max gap');
    } finally {
      page.startup.destroy();
    }
  });

  it('charts the same completed-receipt samples and drops history on device replacement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const drawing = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
    };
    const canvasPrototype: {
      getContext(kind: '2d'): CanvasRenderingContext2D | null;
    } = HTMLCanvasElement.prototype;
    const getContext = vi
      .spyOn(canvasPrototype, 'getContext')
      .mockReturnValue(drawing as unknown as CanvasRenderingContext2D);
    const page = fixture(false, '?forgeax-fps-chart=1');
    const graph = document.querySelector<HTMLCanvasElement>('#forgeax-fps-history');
    try {
      expect(graph?.hidden).toBe(true);
      page.receive(1);
      await vi.advanceTimersByTimeAsync(200);
      page.receive(2);
      page.receive(3);
      await vi.advanceTimersByTimeAsync(300);
      expect(page.hud()?.textContent).toBe('Render FPS 4.0');
      expect(page.gap()?.textContent).toBe('300 ms max gap');
      expect(graph?.hidden).toBe(false);
      expect(drawing.fillText).toHaveBeenCalledWith('Render FPS · 20 s', 10, 15);

      drawing.lineTo.mockClear();
      page.receive(1, 2);
      expect(graph?.hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(page.hud()?.textContent).toBe('Render FPS 0.0');
      expect(graph?.hidden).toBe(false);
      expect(drawing.lineTo).toHaveBeenCalledTimes(4); // Three grid lines and one new sample.
    } finally {
      page.startup.destroy();
      getContext.mockRestore();
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
      expect(page.hud()?.textContent).toBe('Render FPS --');
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
      expect(page.hud()?.textContent).toBe('Render FPS 1.0');
      page.receive(1, 2);
      page.receive(62, 1); // Old device completion cannot replace the new baseline.
      page.receive(2, 2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('Render FPS 1.0');
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
      expect(page.hud()?.textContent).toBe('Render FPS 1.0');

      const retired = document.querySelector('#app');
      if (retired === null) throw new Error('Missing game canvas');
      retired.replaceWith(retired.cloneNode(false));
      page.receive(1, 0);
      page.receive(2, 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('Render FPS 1.0');
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
      expect(page.hud()?.textContent).toBe('Render FPS 1.0');

      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      expect(page.status()?.style.display).toBe('none');
      await vi.advanceTimersByTimeAsync(4000);
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      page.receive(3);
      page.receive(4);
      await vi.advanceTimersByTimeAsync(1000);
      expect(page.hud()?.textContent).toBe('Render FPS 1.0');
      expect(page.status()?.style.display).toBe('block');
    } finally {
      page.startup.destroy();
    }
  });
});
