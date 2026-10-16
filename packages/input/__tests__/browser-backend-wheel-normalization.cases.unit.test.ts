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
  // ─── from browser-backend-wheel-normalization.test.ts ───

  interface WheelFakeListenerStore {
    fire(target: string, kind: string, ev: Partial<WheelEvent>): void;
  }

  function buildWheelFakes(): {
    canvas: HTMLCanvasElement;
    doc: Document;
    win: Window;
    store: WheelFakeListenerStore;
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
    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {},
    } as unknown as HTMLCanvasElement;
    const doc = {
      hasFocus(): boolean {
        return true;
      },
      pointerLockElement: null,
      exitPointerLock(): void {},
    } as unknown as Document;
    const win = makeTarget('window') as unknown as Window;
    const store: WheelFakeListenerStore = {
      fire(target, kind, ev) {
        const handlers = listeners.get(target)?.get(kind);
        if (!handlers) return;
        for (const h of handlers) {
          h(ev as Event);
        }
      },
    };
    return { canvas, doc, win, store };
  }

  describe('browser-backend-wheel-normalization.test.ts', () => {
    describe('browser-backend WheelEvent deltaMode normalization (D-5 sign-discrete)', () => {
      it('PIXEL deltaY=120 -> wheelDelta=+1 (one notch)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 120, deltaMode: 0 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });

      it('LINE deltaY=-3 -> wheelDelta=-1 (sign collapses across deltaMode)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: -3, deltaMode: 1 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(-1);
      });

      it('PAGE deltaY=2 -> wheelDelta=+1 (PAGE mode collapses to +/-1)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 2, deltaMode: 2 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });

      it('deltaY=0 -> wheelDelta=0 (P3 empty signal)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 0, deltaMode: 0 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(0);
      });

      it('multiple wheel events accumulate within a frame; sample drains the accumulator', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 80, deltaMode: 0 });
        store.fire('canvas', 'wheel', { deltaY: 80, deltaMode: 0 });
        store.fire('canvas', 'wheel', { deltaY: 80, deltaMode: 0 });
        store.fire('canvas', 'wheel', { deltaY: -50, deltaMode: 0 });
        const sample1 = handle.backend.sample();
        expect(sample1.wheelDelta).toBe(2);
        const sample2 = handle.backend.sample();
        expect(sample2.wheelDelta).toBe(0);
      });

      it('deltaMode unspecified treated as PIXEL (default 0); large positive deltaY -> +1', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 4 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });
    });
  });
}