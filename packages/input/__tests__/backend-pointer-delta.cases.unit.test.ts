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

// Split source block: F2 cross-frame pointer delta via real backend.
{
  interface DeltaBB {
    canvas: HTMLCanvasElement;
    store: {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void;
    };
  }

  function buildDeltaFakes(): DeltaBB & {
    doc: Document;
    win: Window;
  } {
    const listeners = new Map<string, Map<string, Set<EventListener>>>();

    const makeTarget = (label: string) => ({
      addEventListener(kind: string, handler: EventListener): void {
        let perTarget = listeners.get(label);
        if (!perTarget) { perTarget = new Map(); listeners.set(label, perTarget); }
        let set = perTarget.get(kind);
        if (!set) { set = new Set(); perTarget.set(kind, set); }
        set.add(handler);
      },
      removeEventListener(kind: string, handler: EventListener): void {
        listeners.get(label)?.get(kind)?.delete(handler);
      },
    });

    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {},
      setPointerCapture(): void {},
      // computePointerCoords fallback: no getBoundingClientRect → uses clientX/Y.
      width: 800,
      height: 600,
      style: {} as CSSStyleDeclaration,
    } as unknown as HTMLCanvasElement;

    const doc = {
      hasFocus(): boolean { return true; },
      pointerLockElement: null,
      exitPointerLock(): void {},
    } as unknown as Document;

    const win = makeTarget('window') as unknown as Window;

    const store = {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void {
        const handlers = listeners.get(target)?.get(kind);
        if (!handlers) return;
        // Merge default touch event shape so tests don't need full PointerEvent.
        const full = {
          pointerType: 'touch',
          pointerId: 1,
          button: 0,
          pressure: 1,
          clientX: 0,
          clientY: 0,
          ...ev,
          movementX: ev.movementX ?? 0,
          movementY: ev.movementY ?? 0,
        };
        for (const h of handlers) {
          h(full as unknown as Event);
        }
      },
    };
    return { canvas, doc, win, store };
  }

  describe('cross-frame pointer delta via real backend (F-2 / AC-09)', () => {
    it('single pointermove in a frame: delta equals displacement from pointerdown', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 100, clientY: 200, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 130, clientY: 200, pointerType: 'touch' });

      const sample = handle.backend.sample();
      expect(sample.pointers).toBeDefined();
      expect(sample.pointers!.length).toBe(1);
      expect(sample.pointers![0].x).toBe(130);
      expect(sample.pointers![0].y).toBe(200);
      expect(sample.pointers![0].delta.x).toBe(30);
      expect(sample.pointers![0].delta.y).toBe(0);
    });

    it('next frame with no movement: delta resets to zero', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 100, clientY: 200, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 150, clientY: 200, pointerType: 'touch' });
      handle.backend.sample(); // consume frame 1

      // Frame 2: no move events → delta=0.
      const sample2 = handle.backend.sample();
      expect(sample2.pointers).toBeDefined();
      expect(sample2.pointers![0].delta.x).toBe(0);
      expect(sample2.pointers![0].delta.y).toBe(0);
    });

    it('multi-move across two frames: each frame reports independent delta', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' });

      // Frame 1: 3 moves, +10px each.
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 10, clientY: 0, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 20, clientY: 0, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 30, clientY: 0, pointerType: 'touch' });
      const s1 = handle.backend.sample();
      expect(s1.pointers![0].delta.x).toBe(30);
      expect(s1.pointers![0].delta.y).toBe(0);

      // Frame 2: 2 more moves.
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 45, clientY: 10, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 60, clientY: 20, pointerType: 'touch' });
      const s2 = handle.backend.sample();
      expect(s2.pointers![0].delta.x).toBe(30);  // 60-30 = 30 from frame 1's last position
      expect(s2.pointers![0].delta.y).toBe(20);  // 20-0 = 20
    });

    it('Beving #12442 anti-regression: N moves in same frame produce accumulated delta, not zero', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' });
      // 5 move events in the same frame, +10px each.
      for (let i = 1; i <= 5; i++) {
        store.fire('canvas', 'pointermove', { pointerId: 1, clientX: i * 10, clientY: 0, pointerType: 'touch' });
      }

      const sample = handle.backend.sample();
      // Bevy #12442 bug: delta was (0,0) because prevX was updated per-event.
      // Our fix: prevX is only snapshotted in sample(), never in onPointerMove.
      expect(sample.pointers![0].delta.x).toBe(50); // accumulated 5*10 = 50
      expect(sample.pointers![0].x).toBe(50);
    });
  });
}
