// browser-backend-dual-instance.test.ts -- M1 w5: dual instance isolation unit test.
//
// Covers: two backend instances with different fake canvases,
// pointerlockchange on document must only affect the instance whose
// canvas matches pointerLockElement.
//
// charter awareness:
//   F1 single-entry indexability -- all isolation tests in one file.
//   P4 consistent abstraction -- instance isolation is natural
//     from the backend's perspective (compare pointerLockElement === canvas).

import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend } from '../browser-backend';

describe('browser-backend-dual-instance.test.ts (w5)', () => {
  it('pointerlockchange on canvas A only affects instance A, not instance B', () => {
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

    // Create two fake canvases.
    const canvasA = {
      ...makeTarget('canvasA'),
      requestPointerLock() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
      width: 800,
      height: 600,
      style: { touchAction: '' },
      setPointerCapture: () => {},
    } as unknown as HTMLCanvasElement;

    const canvasB = {
      ...makeTarget('canvasB'),
      requestPointerLock() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
      width: 800,
      height: 600,
      style: { touchAction: '' },
      setPointerCapture: () => {},
    } as unknown as HTMLCanvasElement;

    // Shared document — both instances listen on it.
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

    const handleA = attachBrowserInputBackend(canvasA, {
      document: doc,
      window: win,
    });
    const handleB = attachBrowserInputBackend(canvasB, {
      document: doc,
      window: win,
    });

    // Neither is locked initially.
    expect(handleA.backend.sample().pointerLocked).toBe(false);
    expect(handleB.backend.sample().pointerLocked).toBe(false);

    // Lock canvas A via pointerlockchange.
    pointerLockEl = canvasA;
    const pcHandlers = listeners.get('document')?.get('pointerlockchange');
    if (pcHandlers) {
      const ev = new Event('pointerlockchange');
      for (const h of pcHandlers) h(ev as Event);
    }

    // Only instance A should see pointerLocked=true.
    expect(handleA.backend.sample().pointerLocked).toBe(true);
    expect(handleB.backend.sample().pointerLocked).toBe(false);

    // Unlock: pointerLockElement → null.
    pointerLockEl = null;
    if (pcHandlers) {
      const ev = new Event('pointerlockchange');
      for (const h of pcHandlers) h(ev as Event);
    }
    expect(handleA.backend.sample().pointerLocked).toBe(false);
    expect(handleB.backend.sample().pointerLocked).toBe(false);
  });

  it('pointerlockchange on canvas B only affects instance B', () => {
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

    const canvasA = {
      ...makeTarget('canvasA'),
      requestPointerLock() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
      width: 800,
      height: 600,
      style: { touchAction: '' },
      setPointerCapture: () => {},
    } as unknown as HTMLCanvasElement;

    const canvasB = {
      ...makeTarget('canvasB'),
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

    const handleA = attachBrowserInputBackend(canvasA, {
      document: doc,
      window: win,
    });
    const handleB = attachBrowserInputBackend(canvasB, {
      document: doc,
      window: win,
    });

    // Lock canvas B.
    pointerLockEl = canvasB;
    const pcHandlers = listeners.get('document')?.get('pointerlockchange');
    if (pcHandlers) {
      const ev = new Event('pointerlockchange');
      for (const h of pcHandlers) h(ev as Event);
    }

    expect(handleA.backend.sample().pointerLocked).toBe(false);
    expect(handleB.backend.sample().pointerLocked).toBe(true);
  });

  it('provider path: two instances with independent providers do not interfere', () => {
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

    const pointerLockEl: Element | null = null;
    let providerACalled = false;

    const canvasA = {
      ...makeTarget('canvasA'),
      requestPointerLock() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
      width: 800,
      height: 600,
      style: { touchAction: '' },
      setPointerCapture: () => {},
    } as unknown as HTMLCanvasElement;

    const canvasB = {
      ...makeTarget('canvasB'),
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

    // Instance A has a provider, instance B has W3C-only (no provider).
    const handleA = attachBrowserInputBackend(canvasA, {
      document: doc,
      window: win,
      lockProvider: {
        requestLock() {
          providerACalled = true;
        },
        exitLock() {},
      },
    });
    const handleB = attachBrowserInputBackend(canvasB, {
      document: doc,
      window: win,
      // No lockProvider — pure W3C path.
    });

    // Click on canvas A triggers provider.
    const clickAH = listeners.get('canvasA')?.get('click');
    if (clickAH) {
      const ev = new Event('click');
      for (const h of clickAH) h(ev as Event);
    }
    expect(providerACalled).toBe(true);

    // Instance A is provider-locked; instance B is not.
    expect(handleA.backend.sample().pointerLocked).toBe(true);
    expect(handleB.backend.sample().pointerLocked).toBe(false);

    // Instance B click should be on W3C path (no provider).
    const clickBH = listeners.get('canvasB')?.get('click');
    if (clickBH) {
      const ev = new Event('click');
      for (const h of clickBH) h(ev as Event);
    }

    // Instance B should still not be locked (W3C requestPointerLock was called
    // but pointerlockchange hasn't fired).
    expect(handleB.backend.sample().pointerLocked).toBe(false);
    // Instance A should still be locked (no interference).
    expect(handleA.backend.sample().pointerLocked).toBe(true);
  });

  it('detaching instance A does not affect instance B', () => {
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

    const canvasA = {
      ...makeTarget('canvasA'),
      requestPointerLock() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
      width: 800,
      height: 600,
      style: { touchAction: '' },
      setPointerCapture: () => {},
    } as unknown as HTMLCanvasElement;

    const canvasB = {
      ...makeTarget('canvasB'),
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

    const handleA = attachBrowserInputBackend(canvasA, {
      document: doc,
      window: win,
    });
    const handleB = attachBrowserInputBackend(canvasB, {
      document: doc,
      window: win,
    });

    // Lock both.
    pointerLockEl = canvasA;
    let pcHandlers = listeners.get('document')?.get('pointerlockchange');
    if (pcHandlers) {
      const ev = new Event('pointerlockchange');
      for (const h of pcHandlers) h(ev as Event);
    }
    // Only canvasA gets locked because pointerLockElement === canvasA.
    expect(handleA.backend.sample().pointerLocked).toBe(true);
    expect(handleB.backend.sample().pointerLocked).toBe(false);

    // Detach instance A.
    handleA();

    // Instance B should still function normally.
    pointerLockEl = canvasB;
    // Re-fetch pcHandlers since they may have been removed by handleA.
    pcHandlers = listeners.get('document')?.get('pointerlockchange');
    if (pcHandlers) {
      const ev = new Event('pointerlockchange');
      for (const h of pcHandlers) h(ev as Event);
    }
    expect(handleB.backend.sample().pointerLocked).toBe(true);
  });
});
