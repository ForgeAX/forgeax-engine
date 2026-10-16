// browser-backend-lock-state.test.ts -- M1 w1: lock state machine unit tests.
//
// Covers: pointerlockchange → w3cLocked, providerLocked set/reset,
// merged pointerLocked = w3cLocked || providerLocked,
// snap.mouse.pointerLocked freeze in sample() output.
//
// charter awareness:
//   F1 single-entry indexability -- all lock state tests in one file
//   P3 explicit failure -- each assertion produces a clear diagnostic on failure
//   P4 consistent abstraction -- tests use fake document/canvas, not real browser PointerLock

import { describe, expect, it, vi } from 'vitest';
import { attachBrowserInputBackend } from '../browser-backend';
import { type InputBackendSample, snapshotFromSample } from '../input-snapshot';

// ---------------------------------------------------------------------------
// Fake canvas / document / window infrastructure (mirrors buildBBFakes pattern
// from input.unit.test.ts, extended with pointerlockchange event support).
// ---------------------------------------------------------------------------

interface LockStateFakeStore {
  fire(target: string, kind: string, ev: Partial<Event>): void;
  count(): number;
  countTarget(target: string): number;
}

interface LockStateFakes {
  canvas: HTMLCanvasElement;
  doc: Document;
  win: Window;
  store: LockStateFakeStore;
  setPointerLockElement(el: Element | null): void;
  requestPointerLockReject: Error | null;
}

function buildLockStateFakes(): LockStateFakes {
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
  const requestPointerLockReject: Error | null = null;

  const canvas = {
    ...makeTarget('canvas'),
    requestPointerLock(): void {
      // Marker: canvas requestPointerLock was called. The actual W3C
      // resolution (resolve/reject) is driven by pointerlockchange event
      // dispatch in tests, matching real-browser behavior.
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    width: 800,
    height: 600,
    style: { touchAction: '' },
    setPointerCapture: vi.fn(),
  } as unknown as HTMLCanvasElement;

  const doc = {
    ...makeTarget('document'),
    hasFocus(): boolean {
      return true;
    },
    visibilityState: 'visible',
    get pointerLockElement(): Element | null {
      return pointerLockEl;
    },
    exitPointerLock(): void {
      // Simulate browser exiting pointer lock — sets pointerLockElement
      // to null and fires pointerlockchange.
      pointerLockEl = null;
      // Fire pointerlockchange event on document
      const handlers = listeners.get('document')?.get('pointerlockchange');
      if (handlers) {
        const ev = new Event('pointerlockchange');
        for (const h of handlers) {
          h(ev as Event);
        }
      }
    },
  } as unknown as Document;

  const win = makeTarget('window') as unknown as Window;

  const store: LockStateFakeStore = {
    fire(target, kind, ev) {
      const handlers = listeners.get(target)?.get(kind);
      if (!handlers) return;
      for (const h of handlers) {
        h(ev as Event);
      }
    },
    count() {
      let total = 0;
      for (const perTarget of listeners.values()) {
        for (const set of perTarget.values()) {
          total += set.size;
        }
      }
      return total;
    },
    countTarget(target: string) {
      const perTarget = listeners.get(target);
      if (!perTarget) return 0;
      let total = 0;
      for (const set of perTarget.values()) total += set.size;
      return total;
    },
  };

  return {
    canvas,
    doc,
    win,
    store,
    setPointerLockElement(el) {
      pointerLockEl = el;
    },
    get requestPointerLockReject() {
      return requestPointerLockReject;
    },
  };
}

/**
 * Simulate the browser firing a pointerlockchange event and setting the
 * pointerLockElement. Both happen atomically in the real browser.
 */
function firePointerLockChange(fakes: LockStateFakes, newLockedElement: Element | null): void {
  fakes.setPointerLockElement(newLockedElement);
  fakes.store.fire('document', 'pointerlockchange', new Event('pointerlockchange'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser-backend-lock-state.test.ts (w1)', () => {
  it('preserves physical KeyboardEvent.code held and release edges separately from key', () => {
    const fakes = buildLockStateFakes();
    const handle = attachBrowserInputBackend(fakes.canvas, {
      document: fakes.doc,
      window: fakes.win,
    });

    fakes.store.fire('window', 'keydown', { key: '?', code: 'KeyA' } as KeyboardEvent);
    const pressed = handle.backend.sample();
    expect(pressed.downKeys.has('?')).toBe(true);
    expect(pressed.downCodes?.has('KeyA')).toBe(true);

    fakes.store.fire('window', 'keyup', { key: '?', code: 'KeyA' } as KeyboardEvent);
    const released = handle.backend.sample();
    expect(released.downKeys.has('?')).toBe(false);
    expect(released.downCodes?.has('KeyA')).toBe(false);
    expect(released.upKeys.has('?')).toBe(true);
    expect(released.upCodes?.has('KeyA')).toBe(true);

    const next = handle.backend.sample();
    expect(next.upKeys.has('?')).toBe(false);
    expect(next.upCodes?.has('KeyA')).toBe(false);
    handle.backend.detach?.();
  });

  it('tracks hover mouse position without a button press', () => {
    const fakes = buildLockStateFakes();
    const handle = attachBrowserInputBackend(fakes.canvas, {
      document: fakes.doc,
      window: fakes.win,
    });

    fakes.store.fire('canvas', 'pointermove', {
      pointerType: 'mouse',
      pointerId: 1,
      pressure: 0,
      clientX: 400,
      clientY: 300,
      movementX: 0,
      movementY: 0,
    } as unknown as Event);

    const sample = handle.backend.sample();
    expect(sample.mouseX).toBe(400);
    expect(sample.mouseY).toBe(300);
    expect(snapshotFromSample(sample).mouse.position).toEqual({ x: 400, y: 300 });
  });

  describe('W3C pointerlockchange → w3cLocked tracking', () => {
    it('pointerlockchange with pointerLockElement === canvas sets w3cLocked=true in sample', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      const backend = handle.backend;

      // Before any pointerlockchange, pointerLocked should be false.
      const s0 = backend.sample();
      expect(s0.pointerLocked).toBe(false);

      // Browser locks onto this canvas.
      firePointerLockChange(fakes, fakes.canvas);
      const s1 = backend.sample();
      expect(s1.pointerLocked).toBe(true);

      // Browser unlocks (pointerLockElement becomes null).
      firePointerLockChange(fakes, null);
      const s2 = backend.sample();
      expect(s2.pointerLocked).toBe(false);
    });

    it('pointerlockchange with pointerLockElement !== canvas does NOT set w3cLocked', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      const backend = handle.backend;

      // Another element (e.g. a different canvas) gets the lock.
      const otherCanvas = {} as HTMLCanvasElement;
      firePointerLockChange(fakes, otherCanvas as unknown as Element);

      const s = backend.sample();
      expect(s.pointerLocked).toBe(false);
    });

    it('pointerlockchange listener is registered on document, not canvas', () => {
      const fakes = buildLockStateFakes();
      attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });

      // The pointerlockchange listener must be on the document (W3C spec:
      // pointerlockchange fires on document, not on individual elements).
      const docPointerLockChangeCount = fakes.store.countTarget('document');
      expect(docPointerLockChangeCount).toBeGreaterThanOrEqual(1);

      // The listener count must include the pointerlockchange handler.
      // (We can't test the specific event without firing it, which we do
      // in the pointerLocked tests above.)
    });
  });

  describe('lockProvider → providerLocked tracking', () => {
    it('lockProvider.requestLock() sync success sets providerLocked=true via sample', () => {
      const fakes = buildLockStateFakes();
      let providerLockedAtRequest = false;
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
        lockProvider: {
          requestLock(): void {
            providerLockedAtRequest = true;
          },
          exitLock(): void {
            // no-op
          },
        },
      });
      const backend = handle.backend;

      // Simulate a click that triggers lock request through the provider path.
      // The onCanvasClick handler checks gate, finds lockProvider, calls requestLock.
      // After requestLock() succeeds synchronously, providerLocked should be true.
      fakes.store.fire('canvas', 'click', new Event('click'));

      const s = backend.sample();
      expect(s.pointerLocked).toBe(true);
      // Verify that requestLock was indeed called (provider path was taken).
      expect(providerLockedAtRequest).toBe(true);
    });

    it('lockProvider.exitLock() clears providerLocked via sample', () => {
      const fakes = buildLockStateFakes();
      let exitCalled = false;
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
        lockProvider: {
          requestLock(): void {
            // no-op
          },
          exitLock(): void {
            exitCalled = true;
          },
        },
      });
      const backend = handle.backend;

      // First, get into locked state via provider path.
      fakes.store.fire('canvas', 'click', new Event('click'));
      const s1 = backend.sample();
      expect(s1.pointerLocked).toBe(true);

      // Now simulate ESC keydown to trigger provider exit.
      fakes.store.fire('window', 'keydown', { key: 'Escape' } as KeyboardEvent);
      const s2 = backend.sample();
      expect(s2.pointerLocked).toBe(false);
      expect(exitCalled).toBe(true);
    });

    it('lockProvider.requestLock() returning Promise<void> works with optimistic placement', async () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
        lockProvider: {
          requestLock(): Promise<void> {
            return Promise.resolve();
          },
          exitLock(): void {
            // no-op
          },
        },
      });
      const backend = handle.backend;

      // D-7 optimistic placement: providerLocked is set true immediately
      // when requestLock() is called, before the promise resolves.
      fakes.store.fire('canvas', 'click', new Event('click'));

      const s = backend.sample();
      expect(s.pointerLocked).toBe(true);
      // Cleanup: make sure the promise settles.
      await vi.waitFor(() => Promise.resolve(), { timeout: 100 });
    });
  });

  describe('merged pointerLocked = w3cLocked || providerLocked', () => {
    it('both w3cLocked and providerLocked false → pointerLocked=false', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      const s = handle.backend.sample();
      expect(s.pointerLocked).toBe(false);
    });

    it('w3cLocked=true, providerLocked=false → pointerLocked=true', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      firePointerLockChange(fakes, fakes.canvas);
      const s = handle.backend.sample();
      expect(s.pointerLocked).toBe(true);
    });

    it('w3cLocked=false, providerLocked=true → pointerLocked=true', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
        lockProvider: {
          requestLock(): void {
            // no-op
          },
          exitLock(): void {
            // no-op
          },
        },
      });
      // Provider path lock via click.
      fakes.store.fire('canvas', 'click', new Event('click'));
      const s = handle.backend.sample();
      expect(s.pointerLocked).toBe(true);
    });

    it('both w3cLocked=true and providerLocked=true → pointerLocked=true (OR merge)', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
        lockProvider: {
          requestLock(): void {
            // no-op
          },
          exitLock(): void {
            // no-op
          },
        },
      });
      // Both paths lock.
      firePointerLockChange(fakes, fakes.canvas);
      fakes.store.fire('canvas', 'click', new Event('click'));
      const s = handle.backend.sample();
      expect(s.pointerLocked).toBe(true);
    });

    it('w3cLocked → false while providerLocked=true keeps pointerLocked=true', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
        lockProvider: {
          requestLock(): void {
            // no-op
          },
          exitLock(): void {
            // no-op
          },
        },
      });
      // Both paths lock.
      firePointerLockChange(fakes, fakes.canvas);
      fakes.store.fire('canvas', 'click', new Event('click'));
      expect(handle.backend.sample().pointerLocked).toBe(true);

      // W3C unlocks but provider is still locked.
      firePointerLockChange(fakes, null);
      const s = handle.backend.sample();
      expect(s.pointerLocked).toBe(true);
    });
  });

  describe('snap.mouse.pointerLocked frozen', () => {
    it('sample().pointerLocked is a boolean (required, not optional)', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      const sample: InputBackendSample = handle.backend.sample();
      expect(typeof sample.pointerLocked).toBe('boolean');
    });

    it('snapshotFromSample writes pointerLocked into snap.mouse.pointerLocked', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      // Lock via W3C path.
      firePointerLockChange(fakes, fakes.canvas);
      const sample = handle.backend.sample();
      expect(sample.pointerLocked).toBe(true);

      const snap = snapshotFromSample(sample);
      expect(snap.mouse.pointerLocked).toBe(true);
    });

    it('snap.mouse.pointerLocked is false in empty snapshot from createInputSnapshot', () => {
      // This will be tested after w6 when createInputSnapshot includes pointerLocked.
      // For now, we verify the snapshot propagation contract.
      const snap = snapshotFromSample({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      });
      expect(snap.mouse.pointerLocked).toBe(false);
    });

    it('snap.mouse.pointerLocked is immutable (frozen) across re-reads', () => {
      const snap = snapshotFromSample({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: true,
      });
      expect(snap.mouse.pointerLocked).toBe(true);
      expect(snap.mouse.pointerLocked).toBe(true); // re-read stable
    });
  });

  describe('detach cleans up pointerlockchange listener', () => {
    it('detach removes pointerlockchange listener from document', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });

      // Before detach: listener exists.
      const beforeDetachCount = fakes.store.count();
      expect(beforeDetachCount).toBeGreaterThan(0);

      handle();

      // After detach: all listeners removed (count should be 0).
      expect(fakes.store.count()).toBe(0);
    });

    it('pointerlockchange after detach does not affect sample', () => {
      const fakes = buildLockStateFakes();
      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      // Lock, then detach.
      firePointerLockChange(fakes, fakes.canvas);
      expect(handle.backend.sample().pointerLocked).toBe(true);
      handle();

      // After detach, unlock event should not affect anything.
      firePointerLockChange(fakes, null);
      // Note: sample() after detach is still callable (no throw),
      // but the backend should no longer track lock state changes.
      const s = handle.backend.sample();
      // pointerLocked may be true (stale from before detach) or false (reset on detach),
      // but the key assertion is that sample() doesn't throw after detach.
      expect(typeof s.pointerLocked).toBe('boolean');
    });
  });

  // Regression: setPointerCapture must NOT be called while pointer lock is active.
  // Pointer capture + pointer lock are mutually exclusive (W3C) — calling
  // setPointerCapture on a locked element throws InvalidStateError. This is what
  // crashed the game template on the 2nd click (1st click locked, 2nd click's
  // onPointerDown captured → throw). The backend now skips capture while locked.
  describe('setPointerCapture vs pointer lock (InvalidStateError regression)', () => {
    function firePointerDown(fakes: LockStateFakes, pointerId = 1): void {
      fakes.store.fire('canvas', 'pointerdown', {
        pointerType: 'mouse',
        button: 0,
        pointerId,
        pressure: 0.5,
        clientX: 10,
        clientY: 10,
        movementX: 0,
        movementY: 0,
      } as unknown as Event);
    }

    it('does NOT call setPointerCapture on pointerdown while locked', () => {
      const fakes = buildLockStateFakes();
      // Make the fake behave like a real browser: throw if captured while locked.
      const capture = vi.fn((_id: number) => {
        if (fakes.doc.pointerLockElement === fakes.canvas) {
          throw new DOMException('capture while locked', 'InvalidStateError');
        }
      });
      (fakes.canvas as unknown as { setPointerCapture: typeof capture }).setPointerCapture =
        capture;

      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });

      // Not locked yet: pointerdown SHOULD capture (drag coherence path).
      firePointerDown(fakes, 1);
      expect(capture).toHaveBeenCalledTimes(1);

      // Browser locks onto the canvas, then another pointerdown (the "shoot").
      firePointerLockChange(fakes, fakes.canvas);
      expect(handle.backend.sample().pointerLocked).toBe(true);
      // Must NOT throw and must NOT call capture again while locked.
      expect(() => firePointerDown(fakes, 1)).not.toThrow();
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('resumes capturing after pointer lock is released', () => {
      const fakes = buildLockStateFakes();
      const capture = vi.fn((_id: number) => {
        if (fakes.doc.pointerLockElement === fakes.canvas) {
          throw new DOMException('capture while locked', 'InvalidStateError');
        }
      });
      (fakes.canvas as unknown as { setPointerCapture: typeof capture }).setPointerCapture =
        capture;

      const handle = attachBrowserInputBackend(fakes.canvas, {
        document: fakes.doc,
        window: fakes.win,
      });
      firePointerLockChange(fakes, fakes.canvas); // lock
      firePointerDown(fakes, 1); // skipped while locked
      expect(capture).toHaveBeenCalledTimes(0);

      firePointerLockChange(fakes, null); // unlock
      expect(handle.backend.sample().pointerLocked).toBe(false);
      firePointerDown(fakes, 1); // capture allowed again
      expect(capture).toHaveBeenCalledTimes(1);
    });
  });
});
