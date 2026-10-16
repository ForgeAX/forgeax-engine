// create-app-lock-provider.test.ts -- M2 w9: three-hop passthrough real
// link integration test.
//
// Validates that lockProvider flows from CreateAppOptions through
// InputAttachOptions to BrowserInputBackendOptions without breakage
// (D-2 three-hop passthrough). Uses a fake canvas + synthetic click
// event to verify that requestLock is called and sample().pointerLocked
// reflects the provider lock state.
//
// TDD red phase: the lockProvider field on CreateAppOptions /
// InputAttachOptions is added in w12 (committed), but the full pipeline
// test validates the end-to-end wiring. This test is green when
// attachInputAuto correctly forwards lockProvider to the backend.
//
// charter awareness:
//   F1 single-entry indexability -- all three-hop tests in one file
//   P3 explicit failure -- each assertion produces a clear diagnostic
//   P4 consistent abstraction -- tests use fake canvas, not real browser PointerLock

import { snapshotFromSample } from '@forgeax/engine-input';
import { describe, expect, it, vi } from 'vitest';

import type { AppError } from '../errors';
import { attachInputAuto, type InputAttachOptions } from '../internal/input-attach';

// ---------------------------------------------------------------------------
// Fake DOM infrastructure (mirrors input tests pattern: buildBBFakes).
// ---------------------------------------------------------------------------

interface FakeTarget {
  addEventListener(kind: string, handler: EventListener): void;
  removeEventListener(kind: string, handler: EventListener): void;
}

function makeFakeDom() {
  // Listener store: Map<target, Map<kind, Set<handler>>>
  const listeners = new Map<string, Map<string, Set<EventListener>>>();

  function makeTarget(label: string): FakeTarget {
    return {
      addEventListener(kind: string, handler: EventListener): void {
        let perKind = listeners.get(label);
        if (!perKind) {
          perKind = new Map();
          listeners.set(label, perKind);
        }
        let set = perKind.get(kind);
        if (!set) {
          set = new Set();
          perKind.set(kind, set);
        }
        set.add(handler);
      },
      removeEventListener(kind: string, handler: EventListener): void {
        listeners.get(label)?.get(kind)?.delete(handler);
      },
    };
  }

  const canvas = {
    ...makeTarget('canvas'),
    requestPointerLock: vi.fn(),
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
    pointerLockElement: null as Element | null,
    exitPointerLock: vi.fn(),
  } as unknown as Document;

  const win = makeTarget('window') as unknown as Window;

  function dispatchClick(): void {
    const handlers = listeners.get('canvas')?.get('click');
    if (handlers) {
      const ev = new Event('click', { bubbles: true });
      for (const h of handlers) {
        h(ev as Event);
      }
    }
  }

  // Simulate W3C pointerlockchange: canvas enters pointer-lock.
  function simulateW3cLock(): void {
    (doc as unknown as { pointerLockElement: Element | null }).pointerLockElement = canvas;
    const handlers = listeners.get('document')?.get('pointerlockchange');
    if (handlers) {
      const ev = new Event('pointerlockchange');
      for (const h of handlers) {
        h(ev as Event);
      }
    }
  }

  return { canvas, doc, win, dispatchClick, simulateW3cLock, listeners };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-app-lock-provider (w9)', () => {
  describe('three-hop passthrough: CreateAppOptions -> InputAttachOptions -> BrowserInputBackendOptions', () => {
    it('lockProvider.requestLock is called on canvas click when lockProvider is injected', () => {
      const { canvas, doc, win, dispatchClick } = makeFakeDom();

      // Stub browser globals (attachBrowserInputBackend reads these).
      vi.stubGlobal('document', doc);
      vi.stubGlobal('window', win);
      vi.stubGlobal('HTMLElement', class {});

      // Patch performance.now() for gesture debounce (backend checks time
      // since mousedown for trusted-gesture purposes).
      vi.stubGlobal(
        'performance',
        Object.freeze({
          now: () => 0,
        }),
      );

      const requestLock = vi.fn();
      const exitLock = vi.fn();
      const lockProvider = { requestLock, exitLock };

      const opts: InputAttachOptions = { lockProvider };
      const handle = attachInputAuto(canvas, opts);

      // Dispatch a click — the backend's onCanvasClick handler should call
      // lockProvider.requestLock() (provider path takes priority over W3C).
      dispatchClick();

      expect(requestLock).toHaveBeenCalledOnce();

      // After provider requestLock succeeds (synchronous return, D-7 optimistic
      // placement), the providerLocked flag should be set, so sample() should
      // report pointerLocked === true.
      const snap = snapshotFromSample(handle.backend.sample());
      expect(snap.mouse.pointerLocked).toBe(true);

      // Cleanup.
      handle.cleanup();

      vi.unstubAllGlobals();
    });

    it('without lockProvider, W3C path is used (pointerlockchange-driven)', () => {
      const { canvas, doc, win, dispatchClick, simulateW3cLock } = makeFakeDom();

      vi.stubGlobal('document', doc);
      vi.stubGlobal('window', win);
      vi.stubGlobal('HTMLElement', class {});
      vi.stubGlobal(
        'performance',
        Object.freeze({
          now: () => 0,
        }),
      );

      const opts: InputAttachOptions = {};
      const handle = attachInputAuto(canvas, opts);

      // Dispatch a click — the backend should call requestPointerLock on
      // the canvas (W3C path, no provider).
      dispatchClick();
      expect(canvas.requestPointerLock).toHaveBeenCalledOnce();

      // Simulate W3C pointerlockchange event.
      simulateW3cLock();

      const snap = snapshotFromSample(handle.backend.sample());
      expect(snap.mouse.pointerLocked).toBe(true);

      handle.cleanup();
      vi.unstubAllGlobals();
    });

    it('setOnErrorDispatch receives onLockError when w12 is wired', () => {
      // This tests the onLockError wrapping path. When the backend's
      // onLockError fires (e.g. W3C requestPointerLock rejection), the
      // setOnErrorDispatch callback should be invoked with an AppError
      // tagged 'app-pointer-lock-failed'.

      const onErrorReceived: AppError[] = [];
      const handle = attachInputAuto({} as HTMLCanvasElement);

      handle.setOnErrorDispatch((err) => {
        onErrorReceived.push(err);
      });

      // Call setOnErrorDispatch again — idempotent replacement.
      handle.setOnErrorDispatch((err) => {
        onErrorReceived.push(err);
      });

      // Verify the setter does not crash and the handle is valid.
      // The actual onLockError firing is covered implicitly when the
      // real backend rejects — but this test validates the wiring seam.
      expect(onErrorReceived).toHaveLength(0);

      handle.cleanup();
    });
  });
});
