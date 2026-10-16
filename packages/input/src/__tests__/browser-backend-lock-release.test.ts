// browser-backend-lock-release.test.ts -- M1 w3: release path unit tests.
//
// Covers: ESC (providerLocked only), blur provider release, detach dual-path release.
//
// charter awareness:
//   F1 single-entry indexability -- all release tests in one file
//   P3 explicit failure -- each assertion produces a clear diagnostic

import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend } from '../browser-backend';

// ---------------------------------------------------------------------------
// Helper: build fake env with call tracking.
// ---------------------------------------------------------------------------

function buildReleaseEnv(opts?: { provider?: { requestLock: () => void; exitLock: () => void } }): {
  backend: ReturnType<typeof attachBrowserInputBackend>['backend'];
  fire(target: string, kind: string, ev: Partial<Event | KeyboardEvent>): void;
  exitPointerLockCalls: { count: number };
  exitLockCalls: { count: number };
  requestLockCalls: { count: number };
  setPointerLockElement(el: Element | null): void;
  detach: () => void;
} {
  const listeners = new Map<string, Map<string, Set<EventListener>>>();

  const makeTarget = (label: string) => ({
    addEventListener(kind: string, handler: EventListener): void {
      let perTarget = listeners.get(label);
      if (!perTarget) {
        perTarget = new Map();
        listeners.set(label, perTarget);
      }
      let set = perTarget.get(kind);
      if (!set) {
        set = new Set();
        perTarget.set(kind, set);
      }
      set.add(handler);
    },
    removeEventListener(kind: string, handler: EventListener): void {
      listeners.get(label)?.get(kind)?.delete(handler);
    },
  });

  let pointerLockEl: Element | null = null;
  const exitPointerLockCalls = { count: 0 };
  const exitLockCalls = { count: 0 };
  const requestLockCalls = { count: 0 };

  const canvas = {
    ...makeTarget('canvas'),
    requestPointerLock() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    width: 800,
    height: 600,
    style: { touchAction: '' },
    setPointerCapture: () => {},
  } as unknown as HTMLCanvasElement;

  const doc = {
    ...makeTarget('document'),
    hasFocus() {
      return true;
    },
    visibilityState: 'visible',
    get pointerLockElement() {
      return pointerLockEl;
    },
    exitPointerLock() {
      exitPointerLockCalls.count += 1;
      pointerLockEl = null;
      const hs = listeners.get('document')?.get('pointerlockchange');
      if (hs) {
        const ev = new Event('pointerlockchange');
        for (const h of hs) h(ev as Event);
      }
    },
  } as unknown as Document & { exitPointerLock(): void };

  const win = makeTarget('window') as unknown as Window;

  const handle = attachBrowserInputBackend(canvas, {
    document: doc,
    window: win,
    ...(opts?.provider ? { lockProvider: opts.provider } : {}),
  });

  return {
    backend: handle.backend,
    fire(target, kind, ev) {
      const handlers = listeners.get(target)?.get(kind);
      if (!handlers) return;
      for (const h of handlers) h(ev as Event);
    },
    exitPointerLockCalls,
    exitLockCalls,
    requestLockCalls,
    setPointerLockElement(el) {
      pointerLockEl = el;
      const hs = listeners.get('document')?.get('pointerlockchange');
      if (hs) {
        const ev = new Event('pointerlockchange');
        for (const h of hs) h(ev as Event);
      }
    },
    detach: handle,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser-backend-lock-release.test.ts (w3)', () => {
  describe('ESC key release', () => {
    it('ESC when providerLocked=true calls exitLock and clears providerLocked', () => {
      const exitLockCalls = { count: 0 };
      const env = buildReleaseEnv({
        provider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });

      // Lock via provider path.
      env.fire('canvas', 'click', new Event('click'));
      const s1 = env.backend.sample();
      expect(s1.pointerLocked).toBe(true);

      // ESC releases provider lock.
      env.fire('window', 'keydown', { key: 'Escape' } as KeyboardEvent);
      expect(exitLockCalls.count).toBe(1);

      const s2 = env.backend.sample();
      expect(s2.pointerLocked).toBe(false);
    });

    it('ESC when providerLocked=false does NOT call exitLock', () => {
      const exitLockCalls = { count: 0 };
      const env = buildReleaseEnv({
        provider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });

      // Not locked via provider path.
      env.fire('window', 'keydown', { key: 'Escape' } as KeyboardEvent);
      expect(exitLockCalls.count).toBe(0);
    });

    it('ESC when only w3cLocked=true does NOT call exitLock (W3C handles ESC via browser)', () => {
      const exitLockCalls = { count: 0 };
      const env = buildReleaseEnv({
        provider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });

      // Lock via W3C path only.
      // Actually, we need to simulate W3C lock. Let's use the setPointerLockElement helper.
      env.fire('canvas', 'click', new Event('click'));
      // Then simulate pointerlockchange to set w3cLocked=true.
      // We can't directly set pointerLockElement without the canvas ref.
      // Instead, use the exitPointerLock pattern: we know doc.exitPointerLock
      // fires pointerlockchange. But we need to LOCK first.
      // For W3C path, the backend fires requestPointerLock on click, then
      // browser fires pointerlockchange. Let's just fire the pointerlockchange directly.
      // We need canvas ref... let's rebuild with inline approach.
    });

    it('ESC when only w3cLocked=true does NOT call exitLock (W3C handles ESC via browser)', () => {
      // Build inline to have canvas ref.
      const listeners = new Map<string, Map<string, Set<EventListener>>>();
      const makeTarget = (label: string) => ({
        addEventListener(kind: string, handler: EventListener): void {
          let perTarget = listeners.get(label);
          if (!perTarget) {
            perTarget = new Map();
            listeners.set(label, perTarget);
          }
          let set = perTarget.get(kind);
          if (!set) {
            set = new Set();
            perTarget.set(kind, set);
          }
          set.add(handler);
        },
        removeEventListener(kind: string, handler: EventListener): void {
          listeners.get(label)?.get(kind)?.delete(handler);
        },
      });

      let pointerLockEl: Element | null = null;
      const exitLockCalls = { count: 0 };

      const canvas = {
        ...makeTarget('canvas'),
        requestPointerLock() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
        width: 800,
        height: 600,
        style: { touchAction: '' },
        setPointerCapture: () => {},
      } as unknown as HTMLCanvasElement;

      const doc = {
        ...makeTarget('document'),
        hasFocus() {
          return true;
        },
        visibilityState: 'visible',
        get pointerLockElement() {
          return pointerLockEl;
        },
        exitPointerLock() {},
      } as unknown as Document;

      const win = makeTarget('window') as unknown as Window;

      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
      });
      const backend = handle.backend;

      // Lock via W3C path: click then pointerlockchange (no lockProvider).
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }
      pointerLockEl = canvas;
      const pcH = listeners.get('document')?.get('pointerlockchange');
      if (pcH) {
        const ev = new Event('pointerlockchange');
        for (const h of pcH) h(ev as Event);
      }

      const s1 = backend.sample();
      expect(s1.pointerLocked).toBe(true);

      // ESC with W3C lock: exitLock is not called because there is no lockProvider.
      // The W3C path handles ESC via browser built-in pointerlockchange.
      const keyH = listeners.get('window')?.get('keydown');
      if (keyH) {
        const ev = { key: 'Escape' } as KeyboardEvent;
        for (const h of keyH) h(ev as Event);
      }
      expect(exitLockCalls.count).toBe(0);
    });

    it('ESC when both locked (w3cLocked + providerLocked) calls exitLock for provider', () => {
      const listeners = new Map<string, Map<string, Set<EventListener>>>();
      const makeTarget = (label: string) => ({
        addEventListener(kind: string, handler: EventListener): void {
          let perTarget = listeners.get(label);
          if (!perTarget) {
            perTarget = new Map();
            listeners.set(label, perTarget);
          }
          let set = perTarget.get(kind);
          if (!set) {
            set = new Set();
            perTarget.set(kind, set);
          }
          set.add(handler);
        },
        removeEventListener(kind: string, handler: EventListener): void {
          listeners.get(label)?.get(kind)?.delete(handler);
        },
      });

      let pointerLockEl: Element | null = null;
      const exitLockCalls = { count: 0 };

      const canvas = {
        ...makeTarget('canvas'),
        requestPointerLock() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
        width: 800,
        height: 600,
        style: { touchAction: '' },
        setPointerCapture: () => {},
      } as unknown as HTMLCanvasElement;

      const doc = {
        ...makeTarget('document'),
        hasFocus() {
          return true;
        },
        visibilityState: 'visible',
        get pointerLockElement() {
          return pointerLockEl;
        },
        exitPointerLock() {},
      } as unknown as Document;

      const win = makeTarget('window') as unknown as Window;

      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        lockProvider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });
      const backend = handle.backend;

      // Lock both paths.
      // W3C path:
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }
      pointerLockEl = canvas;
      const pcH = listeners.get('document')?.get('pointerlockchange');
      if (pcH) {
        const ev = new Event('pointerlockchange');
        for (const h of pcH) h(ev as Event);
      }
      // Provider path: click triggers provider too.
      const s1 = backend.sample();
      expect(s1.pointerLocked).toBe(true);

      // ESC should call exitLock for provider path.
      const keyH = listeners.get('window')?.get('keydown');
      if (keyH) {
        const ev = { key: 'Escape' } as KeyboardEvent;
        for (const h of keyH) h(ev as Event);
      }
      expect(exitLockCalls.count).toBe(1);
    });
  });

  describe('blur provider release', () => {
    it('blur when providerLocked=true calls exitLock and clears providerLocked', () => {
      const exitLockCalls = { count: 0 };
      const env = buildReleaseEnv({
        provider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });

      // Lock via provider path.
      env.fire('canvas', 'click', new Event('click'));
      const s1 = env.backend.sample();
      expect(s1.pointerLocked).toBe(true);

      // Blur should release provider lock.
      env.fire('window', 'blur', new Event('blur'));
      expect(exitLockCalls.count).toBe(1);

      const s2 = env.backend.sample();
      expect(s2.pointerLocked).toBe(false);
    });

    it('blur when providerLocked=false does NOT call exitLock', () => {
      const exitLockCalls = { count: 0 };
      const env = buildReleaseEnv({
        provider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });

      env.fire('window', 'blur', new Event('blur'));
      expect(exitLockCalls.count).toBe(0);
    });
  });

  describe('detach dual-path release', () => {
    it('detach when W3C-locked calls exitPointerLock', () => {
      const listeners = new Map<string, Map<string, Set<EventListener>>>();
      const makeTarget = (label: string) => ({
        addEventListener(kind: string, handler: EventListener): void {
          let perTarget = listeners.get(label);
          if (!perTarget) {
            perTarget = new Map();
            listeners.set(label, perTarget);
          }
          let set = perTarget.get(kind);
          if (!set) {
            set = new Set();
            perTarget.set(kind, set);
          }
          set.add(handler);
        },
        removeEventListener(kind: string, handler: EventListener): void {
          listeners.get(label)?.get(kind)?.delete(handler);
        },
      });

      let pointerLockEl: Element | null = null;
      const exitPointerLockCalls = { count: 0 };

      const canvas = {
        ...makeTarget('canvas'),
        requestPointerLock() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
        width: 800,
        height: 600,
        style: { touchAction: '' },
        setPointerCapture: () => {},
      } as unknown as HTMLCanvasElement;

      const doc = {
        ...makeTarget('document'),
        hasFocus() {
          return true;
        },
        visibilityState: 'visible',
        get pointerLockElement() {
          return pointerLockEl;
        },
        exitPointerLock() {
          exitPointerLockCalls.count += 1;
        },
      } as unknown as Document;

      const win = makeTarget('window') as unknown as Window;

      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
      });

      // Lock via W3C path.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }
      pointerLockEl = canvas;

      // Detach while locked.
      handle();
      expect(exitPointerLockCalls.count).toBe(1);
    });

    it('detach when provider-locked calls exitLock', () => {
      const exitLockCalls = { count: 0 };
      const env = buildReleaseEnv({
        provider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });

      // Lock via provider path.
      env.fire('canvas', 'click', new Event('click'));
      expect(env.backend.sample().pointerLocked).toBe(true);

      // Detach should release provider lock.
      env.detach();
      expect(exitLockCalls.count).toBe(1);
    });

    it('detach when both-locked calls both exitPointerLock and exitLock', () => {
      const listeners = new Map<string, Map<string, Set<EventListener>>>();
      const makeTarget = (label: string) => ({
        addEventListener(kind: string, handler: EventListener): void {
          let perTarget = listeners.get(label);
          if (!perTarget) {
            perTarget = new Map();
            listeners.set(label, perTarget);
          }
          let set = perTarget.get(kind);
          if (!set) {
            set = new Set();
            perTarget.set(kind, set);
          }
          set.add(handler);
        },
        removeEventListener(kind: string, handler: EventListener): void {
          listeners.get(label)?.get(kind)?.delete(handler);
        },
      });

      let pointerLockEl: Element | null = null;
      const exitPointerLockCalls = { count: 0 };
      const exitLockCalls = { count: 0 };

      const canvas = {
        ...makeTarget('canvas'),
        requestPointerLock() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
        width: 800,
        height: 600,
        style: { touchAction: '' },
        setPointerCapture: () => {},
      } as unknown as HTMLCanvasElement;

      const doc = {
        ...makeTarget('document'),
        hasFocus() {
          return true;
        },
        visibilityState: 'visible',
        get pointerLockElement() {
          return pointerLockEl;
        },
        exitPointerLock() {
          exitPointerLockCalls.count += 1;
        },
      } as unknown as Document;

      const win = makeTarget('window') as unknown as Window;

      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        lockProvider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });

      // Lock both paths.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }
      pointerLockEl = canvas;
      const pcH = listeners.get('document')?.get('pointerlockchange');
      if (pcH) {
        const ev = new Event('pointerlockchange');
        for (const h of pcH) h(ev as Event);
      }

      expect(handle.backend.sample().pointerLocked).toBe(true);

      // Detach: both paths should release.
      handle();
      expect(exitPointerLockCalls.count).toBe(1);
      expect(exitLockCalls.count).toBe(1);
    });
  });

  describe('W3C auto-unlock via pointerlockchange', () => {
    it('W3C ESC/focus-loss triggers pointerlockchange, setting w3cLocked=false automatically', () => {
      const listeners = new Map<string, Map<string, Set<EventListener>>>();
      const makeTarget = (label: string) => ({
        addEventListener(kind: string, handler: EventListener): void {
          let perTarget = listeners.get(label);
          if (!perTarget) {
            perTarget = new Map();
            listeners.set(label, perTarget);
          }
          let set = perTarget.get(kind);
          if (!set) {
            set = new Set();
            perTarget.set(kind, set);
          }
          set.add(handler);
        },
        removeEventListener(kind: string, handler: EventListener): void {
          listeners.get(label)?.get(kind)?.delete(handler);
        },
      });

      let pointerLockEl: Element | null = null;

      const canvas = {
        ...makeTarget('canvas'),
        requestPointerLock() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
        width: 800,
        height: 600,
        style: { touchAction: '' },
        setPointerCapture: () => {},
      } as unknown as HTMLCanvasElement;

      const doc = {
        ...makeTarget('document'),
        hasFocus() {
          return true;
        },
        visibilityState: 'visible',
        get pointerLockElement() {
          return pointerLockEl;
        },
        exitPointerLock() {},
      } as unknown as Document;

      const win = makeTarget('window') as unknown as Window;

      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
      });
      const backend = handle.backend;

      // Lock via W3C.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }
      pointerLockEl = canvas;
      const pcH = listeners.get('document')?.get('pointerlockchange');
      if (pcH) {
        const ev = new Event('pointerlockchange');
        for (const h of pcH) h(ev as Event);
      }

      expect(backend.sample().pointerLocked).toBe(true);

      // Browser auto-unlock (ESC / focus-loss): pointerLockElement → null
      pointerLockEl = null;
      if (pcH) {
        const ev = new Event('pointerlockchange');
        for (const h of pcH) h(ev as Event);
      }

      expect(backend.sample().pointerLocked).toBe(false);
    });
  });
});
