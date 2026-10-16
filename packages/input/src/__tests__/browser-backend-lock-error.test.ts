// browser-backend-lock-error.test.ts -- M3 pointer-lock failure unit tests.
//
// Covers: W3C rejection / pointerlockerror → onLockError (no longer silently
// swallowed), provider reject → onLockError + providerLocked rollback.
//
// charter awareness:
//   P3 explicit failure -- lock failures must produce structured signals,
//     never silently swallowed (constraint 7).
//   F1 single-entry indexability -- all error tests in one file.

import { describe, expect, it, vi } from 'vitest';
import { attachBrowserInputBackend } from '../browser-backend';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser-backend-lock-error.test.ts (w4)', () => {
  describe('W3C requestPointerLock rejection → onLockError', () => {
    it('W3C rejection calls onLockError with { path: "w3c", cause }', () => {
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
      const rejectionError = new Error('WrongDocumentError');
      const lockErrorCalls: Array<{ path: string; cause: unknown }> = [];

      const canvas = {
        ...makeTarget('canvas'),
        requestPointerLock(): Promise<void> {
          return Promise.reject(rejectionError);
        },
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

      attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        onLockError: (detail) => {
          lockErrorCalls.push(detail);
        },
      });

      // Click triggers requestPointerLock which rejects.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }

      // Wait for microtask to resolve promise rejection.
      return vi
        .waitFor(
          () => {
            expect(lockErrorCalls.length).toBe(1);
            expect(lockErrorCalls[0]?.path).toBe('w3c');
            expect(lockErrorCalls[0]?.cause).toBe(rejectionError);
          },
          { timeout: 200 },
        )
        .then(async () => {
          const browserEvent = new Event('pointerlockerror');
          const errorHandlers = listeners.get('document')?.get('pointerlockerror');
          for (const handler of errorHandlers ?? []) handler(browserEvent);
          await vi.waitFor(
            () => {
              expect(lockErrorCalls.length).toBe(2);
              expect(lockErrorCalls[1]?.path).toBe('w3c');
              expect(lockErrorCalls[1]?.cause).toBe(browserEvent);
            },
            { timeout: 200 },
          );
        });
    });

    it('W3C rejection without onLockError provided does NOT throw (backend is resilient)', () => {
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

      const canvas = {
        ...makeTarget('canvas'),
        requestPointerLock(): Promise<void> {
          return Promise.reject(new Error('SecurityError'));
        },
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

      attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        // No onLockError provided -- should not throw.
      });

      // Click triggers rejection.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }

      // The promise rejection should be caught, not unhandled.
      // We verify by waiting a microtask — no throw should occur.
      return vi.waitFor(
        () => {
          // If we got here without an unhandled rejection, the test passes.
          expect(true).toBe(true);
        },
        { timeout: 200 },
      );
    });
  });

  describe('provider requestLock reject → onLockError + rollback', () => {
    it('provider requestLock reject calls onLockError with { path: "provider", cause }', async () => {
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
      const providerError = new Error('Tauri invoke failed');
      const lockErrorCalls: Array<{ path: string; cause: unknown }> = [];

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
          requestLock(): Promise<void> {
            return Promise.reject(providerError);
          },
          exitLock() {},
        },
        onLockError: (detail) => {
          lockErrorCalls.push(detail);
        },
      });
      const backend = handle.backend;

      // Click triggers provider requestLock which rejects.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }

      await vi.waitFor(
        () => {
          expect(lockErrorCalls.length).toBe(1);
          expect(lockErrorCalls[0]?.path).toBe('provider');
          expect(lockErrorCalls[0]?.cause).toBe(providerError);
        },
        { timeout: 200 },
      );

      // providerLocked should be rolled back.
      const s = backend.sample();
      expect(s.pointerLocked).toBe(false);
    });

    it('provider requestLock throw calls onLockError and rolls back providerLocked', async () => {
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
      const syncError = new Error('postMessage failed');
      const lockErrorCalls: Array<{ path: string; cause: unknown }> = [];

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
          requestLock(): void {
            throw syncError;
          },
          exitLock() {},
        },
        onLockError: (detail) => {
          lockErrorCalls.push(detail);
        },
      });
      const backend = handle.backend;

      // Click triggers provider requestLock which throws synchronously.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }

      expect(lockErrorCalls.length).toBe(1);
      expect(lockErrorCalls[0]?.path).toBe('provider');
      expect(lockErrorCalls[0]?.cause).toBe(syncError);

      // providerLocked should be rolled back.
      const s = backend.sample();
      expect(s.pointerLocked).toBe(false);
    });

    it('provider exitLock throw calls onLockError (does not affect lock cleanup)', async () => {
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
      const exitError = new Error('exitLock failed');
      const lockErrorCalls: Array<{ path: string; cause: unknown }> = [];

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
          exitLock(): void {
            throw exitError;
          },
        },
        onLockError: (detail) => {
          lockErrorCalls.push(detail);
        },
      });
      const backend = handle.backend;

      // Lock via provider path.
      const clickH = listeners.get('canvas')?.get('click');
      if (clickH) {
        const ev = new Event('click');
        for (const h of clickH) h(ev as Event);
      }
      expect(backend.sample().pointerLocked).toBe(true);

      // ESC triggers exitLock which throws.
      const keyH = listeners.get('window')?.get('keydown');
      if (keyH) {
        const ev = { key: 'Escape' } as KeyboardEvent;
        for (const h of keyH) h(ev as Event);
      }

      expect(lockErrorCalls.length).toBe(1);
      expect(lockErrorCalls[0]?.path).toBe('provider');
      expect(lockErrorCalls[0]?.cause).toBe(exitError);

      // providerLocked should still be cleared despite exitLock throw.
      const s = backend.sample();
      expect(s.pointerLocked).toBe(false);
    });
  });
});
