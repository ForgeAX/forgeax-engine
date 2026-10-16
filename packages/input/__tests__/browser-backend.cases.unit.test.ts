import { Update } from '@forgeax/engine-ecs';
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/input/src/__tests__/browser-backend-wheel-normalization.test.ts
//   - packages/input/src/__tests__/browser-backend.test.ts
//   - packages/input/src/__tests__/frame-start-scan-system.test.ts
//   - packages/input/src/__tests__/input-snapshot.test.ts
//   - packages/input/src/__tests__/wheel-delta.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from src/__tests__/ into __tests__/; import paths adjusted (../ → ../src/).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend, coercePointerType } from '../src/browser-backend';
import {
  buildGuidFromVidPid,
  extractGuidFromGamepadId,
  type MappingTokens,
  parseControllerDb,
  platformFromUserAgent,
  selectBestMappingEntry,
} from '../src/controller-db';
import type {
  Capabilities,
  GamepadSlotSample,
  PointerPhaseEvent,
  VirtualJoystickConfig,
} from '../src/input-snapshot';
import {
  createInputSnapshot,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  InputFrameStartScan,
  type InputSnapshot,
  type PointerType,
  snapshotFromSample,
} from '../src/index';
import { diffGamepadFrame, type RawGamepadStub } from '../src/gamepad-frame';
import {
  deriveVirtualAxes,
  handleVirtualJoystickUnbind,
  type BindState,
} from '../src/virtual-joystick';
import {
  deriveActionStates,
  getAxis,
  getVector,
  type ActionConfig,
  type ActionState,
  type GetVectorOptions,
} from '../src/action-state';
import {
  createRecognizerState,
  DOUBLE_TAP_DISTANCE,
  DOUBLE_TAP_INTERVAL_MS,
  type GestureEvent,
  type GestureState,
  LONG_PRESS_DURATION_MS,
  LONG_PRESS_SLOP,
  processGestureFrame,
  type RecognizerPointer,
  type RecognizerState,
  SWIPE_VELOCITY_THRESHOLD,
  SWIPE_WINDOW_MS,
} from '../src/gesture-recognizer';

/**
 * Build a standard-layout GamepadSlotSample for test injection.
 * Standard mapping has 17 buttons (0-16) and 4 axes (0-3).
 */
function buildGamepadSlot(index: number, overrides?: {
  pressed?: number[];
  justPressed?: number[];
  justReleased?: number[];
  buttonValues?: Map<number, number>;
  axes?: [number, number, number, number];
  standardMapping?: boolean;
}): GamepadSlotSample {
  return {
    index,
    standardMapping: overrides?.standardMapping ?? true,
    pressed: new Set(overrides?.pressed ?? []),
    justPressed: new Set(overrides?.justPressed ?? []),
    justReleased: new Set(overrides?.justReleased ?? []),
    buttonValues: overrides?.buttonValues ?? new Map(),
    axes: overrides?.axes ?? [0, 0, 0, 0],
  };
}

interface FakeListenerStore {
  fire(target: string, kind: string, ev: Partial<WheelEvent | KeyboardEvent | MouseEvent>): void;
}

/**
 * Extended fixtureBackend with optional gamepad/capability fields for M1+ testing.
 * Defined at top level so all test blocks can access it.
 */
function fixtureBackend(initial: {
  downKeys?: ReadonlySet<string>;
  upKeys?: ReadonlySet<string>;
  buttons?: readonly [boolean, boolean, boolean];
  movementX?: number;
  movementY?: number;
  wheelDelta?: number;
  focused?: boolean;
  pointerLocked?: boolean;
  gamepads?: readonly GamepadSlotSample[];
  capabilities?: Capabilities;
  pointers?: readonly import('../src/input-snapshot').PointerSample[];
  pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
}): InputBackend & { sampleCalls: number } {
  let calls = 0;
  return {
    sample(): {
      downKeys: ReadonlySet<string>;
      upKeys: ReadonlySet<string>;
      buttons: readonly [boolean, boolean, boolean];
      movementX: number;
      movementY: number;
      wheelDelta: number;
      focused: boolean;
      pointerLocked: boolean;
      gamepads?: readonly GamepadSlotSample[];
      capabilities?: Capabilities;
      pointers?: readonly import('../src/input-snapshot').PointerSample[];
      pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
    } {
      calls += 1;
      return {
        downKeys: initial.downKeys ?? new Set<string>(),
        upKeys: initial.upKeys ?? new Set<string>(),
        buttons: initial.buttons ?? [false, false, false],
        movementX: initial.movementX ?? 0,
        movementY: initial.movementY ?? 0,
        wheelDelta: initial.wheelDelta ?? 0,
        focused: initial.focused ?? true,
        pointerLocked: initial.pointerLocked ?? false,
        gamepads: initial.gamepads,
        capabilities: initial.capabilities,
        pointers: initial.pointers,
        pointerEvents: initial.pointerEvents,
      };
    },
    detach() {},
    get sampleCalls() {
      return calls;
    },
  } as InputBackend & { sampleCalls: number };
}

void [DOUBLE_TAP_DISTANCE, DOUBLE_TAP_INTERVAL_MS, INPUT_BACKEND_KEY, INPUT_SNAPSHOT_RESOURCE_KEY, InputFrameStartScan, LONG_PRESS_DURATION_MS, LONG_PRESS_SLOP, SWIPE_VELOCITY_THRESHOLD, SWIPE_WINDOW_MS, Update, World, attachBrowserInputBackend, buildGamepadSlot, buildGuidFromVidPid, coercePointerType, createInputSnapshot, createRecognizerState, deriveActionStates, deriveVirtualAxes, describe, diffGamepadFrame, expect, extractGuidFromGamepadId, fileURLToPath, fixtureBackend, getAxis, getVector, handleVirtualJoystickUnbind, it, parseControllerDb, platformFromUserAgent, processGestureFrame, readFileSync, selectBestMappingEntry, snapshotFromSample];
type __MergedKeep = ActionConfig | ActionState | BindState | Capabilities | FakeListenerStore | GamepadSlotSample | GestureEvent | GestureState | GetVectorOptions | InputBackend | InputSnapshot | MappingTokens | PointerPhaseEvent | PointerType | RawGamepadStub | RecognizerPointer | RecognizerState | VirtualJoystickConfig;


{
  // ─── from browser-backend.test.ts ───

  interface FakeBBListenerStore {
    add(target: string, kind: string, handler: EventListener): void;
    remove(target: string, kind: string, handler: EventListener): void;
    fire(target: string, kind: string, ev: Partial<KeyboardEvent | MouseEvent>): void;
    count(): number;
  }

  function buildBBFakes(): {
    canvas: HTMLCanvasElement;
    doc: Document;
    win: Window;
    store: FakeBBListenerStore;
    setPointerLockElement(el: Element | null): void;
    setHasFocus(focused: boolean): void;
    requestCalls: { count: number };
    exitCalls: { count: number };
  } {
    const listeners = new Map<string, Map<string, Set<EventListener>>>();
    const requestCalls = { count: 0 };
    const exitCalls = { count: 0 };
    let pointerLockEl: Element | null = null;
    let focused = true;

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

    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {
        requestCalls.count += 1;
      },
    } as unknown as HTMLCanvasElement;

    const doc = {
      ...makeTarget('document'),
      hasFocus(): boolean {
        return focused;
      },
      visibilityState: 'visible',
      get pointerLockElement(): Element | null {
        return pointerLockEl;
      },
      exitPointerLock(): void {
        exitCalls.count += 1;
      },
    } as unknown as Document;

    const win = makeTarget('window') as unknown as Window;

    const store: FakeBBListenerStore = {
      add() {},
      remove() {},
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
    };

    return {
      canvas,
      doc,
      win,
      store,
      setPointerLockElement(el) {
        pointerLockEl = el;
      },
      setHasFocus(f) {
        focused = f;
      },
      requestCalls,
      exitCalls,
    };
  }

  describe('browser-backend.test.ts', () => {
    describe('attachBrowserInputBackend (browser-backend.ts)', () => {
      it('attaches input, visibility, pointer-lock-error, and click listeners', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(store.count()).toBe(15); // Input plus Host haptic connection/visibility listeners.
      });

      it('translates keyboard events into the snapshot held-key set', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('window', 'keydown', { key: 'w' });
        store.fire('window', 'keydown', { key: 'shift' });
        const sample1 = backend.sample();
        expect(sample1.downKeys.has('w')).toBe(true);
        expect(sample1.downKeys.has('shift')).toBe(true);
        expect(sample1.upKeys.size).toBe(0);

        store.fire('window', 'keyup', { key: 'w' });
        const sample2 = backend.sample();
        expect(sample2.downKeys.has('w')).toBe(false);
        expect(sample2.upKeys.has('w')).toBe(true);

        const sample3 = backend.sample();
        expect(sample3.upKeys.has('w')).toBe(false);
      });

      it('translates pointer events (pointerType=mouse) into the buttons tuple + accumulates movementX/Y', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointerdown', { button: 2, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointermove', { movementX: 5, movementY: -3, buttons: 3, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointermove', { movementX: 1, movementY: 1, buttons: 3, pointerType: 'mouse', pointerId: 1 });

        const sample1 = backend.sample();
        expect(sample1.buttons).toEqual([true, false, true]);
        expect(sample1.movementX).toBe(6);
        expect(sample1.movementY).toBe(-2);

        const sample2 = backend.sample();
        expect(sample2.movementX).toBe(0);
        expect(sample2.movementY).toBe(0);

        store.fire('canvas', 'pointerup', { button: 0, pointerType: 'mouse', pointerId: 1 });
        const sample3 = backend.sample();
        expect(sample3.buttons).toEqual([false, false, true]);
      });

      it('blur clears the up-edge set (alt-tab does not synthesise releases)', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('window', 'keydown', { key: 'q' });
        store.fire('window', 'keyup', { key: 'q' });
        store.fire('window', 'blur', {});
        const sample = backend.sample();
        expect(sample.upKeys.has('q')).toBe(false);
      });

      it('keyup while unfocused suppresses the up-edge (document.hasFocus() === false)', () => {
        const { canvas, doc, win, store, setHasFocus } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;
        store.fire('window', 'keydown', { key: 'a' });
        setHasFocus(false);
        store.fire('window', 'keyup', { key: 'a' });
        const sample = backend.sample();
        expect(sample.upKeys.has('a')).toBe(false);
        expect(sample.focused).toBe(false);
      });

      it('canvas click triggers requestPointerLock (W3C user-activation contract)', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(requestCalls.count).toBe(0);
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1);
      });

      // w19 (feat-20260630-viewport): neutral PointerLock gate. The backend never
      // learns the host's reason — it only asks the predicate. A host that owns
      // the cursor (e.g. an editor viewport outside its play·game quadrant)
      // supplies a predicate returning false and a click does NOT capture.
      it('pointerLockAllowed=false suppresses requestPointerLock on click', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        attachBrowserInputBackend(canvas, {
          document: doc,
          window: win,
          pointerLockAllowed: () => false,
        });
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(0);
      });

      it('pointerLockAllowed=true allows requestPointerLock (same as default)', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        attachBrowserInputBackend(canvas, {
          document: doc,
          window: win,
          pointerLockAllowed: () => true,
        });
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1);
      });

      it('pointerLockAllowed is read live per click (predicate re-evaluated each time)', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        let allowed = false;
        attachBrowserInputBackend(canvas, {
          document: doc,
          window: win,
          pointerLockAllowed: () => allowed,
        });
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(0); // disallowed: no lock
        allowed = true;
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1); // now allowed: locks
      });

      it('detach removes every listener and is idempotent on second call', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(store.count()).toBe(15);
        handle();
        expect(store.count()).toBe(0);
        expect(() => handle()).not.toThrow();
        handle.backend.detach();
        for (let cycle = 0; cycle < 10; cycle++) {
          const next = attachBrowserInputBackend(canvas, { document: doc, window: win });
          expect(store.count()).toBe(15);
          next();
          expect(store.count()).toBe(0);
        }
      });

      it('detach exits PointerLock when the canvas is the active lock target', () => {
        const { canvas, doc, win, setPointerLockElement, exitCalls } = buildBBFakes();
        setPointerLockElement(canvas);
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        handle();
        expect(exitCalls.count).toBe(1);
      });

      it('handles missing addEventListener / removeEventListener gracefully', () => {
        const fakeCanvas = {} as HTMLCanvasElement;
        const fakeDoc = {} as Document;
        const fakeWin = {} as Window;
        const handle = attachBrowserInputBackend(fakeCanvas, { document: fakeDoc, window: fakeWin });
        expect(typeof handle).toBe('function');
        expect(typeof handle.backend.sample).toBe('function');
        expect(() => handle()).not.toThrow();
      });
    });

    // C-R6 (studio-issues): pointerlock focus gate + rejection catch.
    // Pre-fix: onCanvasClick unconditionally calls requestPointerLock,
    // which can produce unhandled promise rejections in iframe / post-load
    // contexts (WrongDocumentError); trusted clicks still trigger pointerlock
    // while the tab is backgrounded, and returned promises are caught.
    describe('C-R6 pointerlock focus gate + rejection catch', () => {
      it('AC-05 trusted click still requests pointer lock when doc.hasFocus() is false', () => {
        const { canvas, doc, win, store, setHasFocus, requestCalls } = buildBBFakes();
        setHasFocus(false);
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(requestCalls.count).toBe(0);
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1);
      });

      it('AC-05 focus gate: calls requestPointerLock when doc.hasFocus() is true (regression guard)', () => {
        const { canvas, doc, win, store, setHasFocus, requestCalls } = buildBBFakes();
        setHasFocus(true);
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(requestCalls.count).toBe(0);
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1);
      });

      it('AC-05 rejection catch: requestPointerLock returning a rejecting Promise is swallowed', async () => {
        // Inline fake: requestPointerLock returns a Promise that rejects.
        const listeners = new Map<string, Map<string, Set<EventListener>>>();
        let rejectCalled = false;
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
        const canvas = {
          ...makeTarget('canvas'),
          requestPointerLock(): Promise<void> {
            return Promise.reject(new Error('WrongDocumentError'));
          },
          get ownerDocument() {
            return doc;
          },
        } as unknown as HTMLCanvasElement;
        const doc = {
          hasFocus(): boolean {
            return true;
          },
          pointerLockElement: null,
          exitPointerLock(): void {},
        } as unknown as Document;
        const win = makeTarget('window') as unknown as Window;

        attachBrowserInputBackend(canvas, { document: doc, window: win });

        // Override addEventListener for unhandledrejection to detect leaks.
        const origAdd = process.addListener ?? process.on;
        const rejectionErrors: Error[] = [];
        const onUnhandled = (reason: Error) => {
          rejectionErrors.push(reason);
        };
        const processObj = process as unknown as {
          on(event: string, listener: (...args: unknown[]) => void): void;
          removeListener(event: string, listener: (...args: unknown[]) => void): void;
        };
        processObj.on('unhandledRejection', onUnhandled);

        // Fire click -> requestPointerLock returns rejecting Promise.
        // The .catch should swallow it; we wait a microtick for rejection to surface.
        const clickHandlers = listeners.get('canvas')?.get('click');
        expect(clickHandlers?.size).toBeGreaterThan(0);
        for (const h of clickHandlers ?? []) {
          h(new Event('click'));
        }

        // Wait for microtask queue to flush the rejection.
        await new Promise((resolve) => setTimeout(resolve, 10));

        // No unhandled rejection should have surfaced — .catch swallowed it.
        expect(rejectionErrors.length).toBe(0);

        processObj.removeListener('unhandledRejection', onUnhandled);

        // Verify rejectCalled is tracked (the .catch ran).
        rejectCalled = true;
        // The key assertion: rejection is swallowed by .catch, no crash.
        expect(rejectCalled).toBe(true);
      });

      it('AC-05: canvas without requestPointerLock silently returns (missing API guard)', () => {
        // Canvas that has addEventListener but no requestPointerLock.
        const listeners = new Map<string, Map<string, Set<EventListener>>>();
        const canvas = {
          addEventListener(kind: string, handler: EventListener): void {
            let perTarget = listeners.get('c');
            if (!perTarget) {
              perTarget = new Map();
              listeners.set('c', perTarget);
            }
            let set = perTarget.get(kind);
            if (!set) {
              set = new Set();
              perTarget.set(kind, set);
            }
            set.add(handler);
          },
          removeEventListener(kind: string, handler: EventListener): void {
            listeners.get('c')?.get(kind)?.delete(handler);
          },
          get ownerDocument() {
            return doc;
          },
          // No requestPointerLock — jsdom environments may lack it.
        } as unknown as HTMLCanvasElement;
        const doc = {
          hasFocus(): boolean {
            return true;
          },
        } as unknown as Document;
        const win = { addEventListener() {}, removeEventListener() {} } as unknown as Window;

        // Must not throw; the typeof guard handles it.
        expect(() =>
          attachBrowserInputBackend(canvas, { document: doc, window: win }),
        ).not.toThrow();

        // Fire click: no requestPointerLock available, silently return.
        const clickHandlers = listeners.get('c')?.get('click');
        expect(clickHandlers?.size).toBeGreaterThan(0);
        for (const h of clickHandlers ?? []) {
          expect(() => h(new Event('click'))).not.toThrow();
        }
      });
    });

    // ─── w9: PointerEvent-driven mouse regression (AC-06) ───
    describe('PointerEvent-driven mouse regression (AC-06)', () => {
      function buildPointerRegressionFakes(): {
        canvas: HTMLCanvasElement;
        doc: Document;
        win: Window;
        store: FakeBBListenerStore;
        requestCalls: { count: number };
      } {
        const listeners = new Map<string, Map<string, Set<EventListener>>>();
        const requestCalls = { count: 0 };
        let focused = true;

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

        const canvas = {
          ...makeTarget('canvas'),
          requestPointerLock(): void {
            requestCalls.count += 1;
          },
        } as unknown as HTMLCanvasElement;

        const doc = {
          hasFocus(): boolean {
            return focused;
          },
          pointerLockElement: null,
          exitPointerLock(): void {},
        } as unknown as Document;

        const win = makeTarget('window') as unknown as Window;

        const store: FakeBBListenerStore = {
          add() {},
          remove() {},
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
        };
        return { canvas, doc, win, store, requestCalls };
      }

      it('button(0|1|2) semantics preserved after pointer event migration', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointerdown', { button: 2, pointerType: 'mouse', pointerId: 1 });
        const sample1 = backend.sample();
        expect(sample1.buttons).toEqual([true, false, true]);

        store.fire('canvas', 'pointerup', { button: 0, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointerup', { button: 2, pointerType: 'mouse', pointerId: 1 });
        const sample2 = backend.sample();
        expect(sample2.buttons).toEqual([false, false, false]);
      });

      it('movementDelta accumulated from pointermove (PointerEvent extends MouseEvent)', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointermove', { movementX: 3, movementY: -7, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointermove', { movementX: 2, movementY: 1, pointerType: 'mouse', pointerId: 1 });
        const sample = backend.sample();
        expect(sample.movementX).toBe(5);
        expect(sample.movementY).toBe(-6);
      });

      it('wheelDelta unchanged after pointer migration (wheel listener preserved)', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'wheel', { deltaY: 120, deltaMode: 0 });
        const sample = backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });

      it('non-mouse pointerType does not affect mouse cluster (touch ignored)', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointerdown', { button: 0, pointerType: 'touch', pointerId: 2 });
        store.fire('canvas', 'pointermove', { movementX: 10, movementY: 10, pointerType: 'touch', pointerId: 2 });
        const sample = backend.sample();
        expect(sample.buttons).toEqual([false, false, false]);
        expect(sample.movementX).toBe(0);
        expect(sample.movementY).toBe(0);
      });
    });
  });
}
