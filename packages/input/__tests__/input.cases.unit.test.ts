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
  // ─── M5 gesture recognizer (gesture-recognizer.ts) ───
  // Pure-function state machines called directly with synthetic phaseQueue +
  // pointerMap + injected now() clock (D-3/D-4). No DOM.

  /** Build a synthetic PointerPhaseEvent. */
  function ph(
    pointerId: number,
    phase: PointerPhaseEvent['phase'],
    x: number,
    y: number,
    pointerType: PointerType = 'touch',
  ): PointerPhaseEvent {
    return { pointerId, phase, x, y, pressure: 0.5, pointerType };
  }

  /** Build a pointerMap (pointerId -> live position) for the recognizer. */
  function pm(
    entries: readonly (readonly [number, number, number, PointerType?])[],
  ): ReadonlyMap<number, RecognizerPointer> {
    const m = new Map<number, RecognizerPointer>();
    for (const [id, x, y, pt] of entries) {
      m.set(id, { x, y, pointerType: pt ?? 'touch' });
    }
    return m;
  }

  const EMPTY_MAP: ReadonlyMap<number, RecognizerPointer> = new Map();

  describe('m5t1: pinch + rotate recognizer (D-11)', () => {
    it('two fingers down -> pinch + rotate begin, scale 1.0 / angle 0 (AC-14)', () => {
      const s0 = createRecognizerState();
      const r = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s0,
        1000,
      );
      const kinds = r.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-begin');
      expect(kinds).toContain('rotate-begin');
      const begin = r.gestureEvents.find((e) => e.kind === 'pinch-begin');
      expect(begin).toBeDefined();
      if (begin && begin.kind === 'pinch-begin') {
        expect([...begin.pointerIds].sort()).toEqual([1, 2]);
        expect(begin.pointerType).toBe('touch');
      }
      expect(r.gestureState.pinchScale).toBeCloseTo(1.0, 5);
      expect(r.gestureState.rotationAngle).toBeCloseTo(0, 5);
    });

    it('fingers spread -> pinchScale increases proportionally', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      // Spread finger 2 from x=100 to x=200 (distance 100 -> 200 => scale 2.0).
      const r = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      );
      expect(r.gestureState.pinchScale).toBeCloseTo(2.0, 5);
      expect(r.gestureState.rotationAngle).toBeCloseTo(0, 5);
      // No new begin/end on a pure move frame.
      expect(r.gestureEvents.map((e) => e.kind)).not.toContain('pinch-begin');
    });

    it('fingers rotate -> rotationAngle tracks atan2 frame delta', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      // Rotate finger 2 from (100,0) [angle 0] to (0,100) [angle +PI/2].
      const r = processGestureFrame(
        [ph(2, 'move', 0, 100)],
        pm([
          [1, 0, 0],
          [2, 0, 100],
        ]),
        s,
        1016,
      );
      expect(r.gestureState.rotationAngle).toBeCloseTo(Math.PI / 2, 5);
      // Distance unchanged (100) => scale stays 1.0.
      expect(r.gestureState.pinchScale).toBeCloseTo(1.0, 5);
    });

    it('2->1 lift emits end + freezes continuous value; back to 2 re-begins + resets (D-11/E-6)', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      // Spread to scale 2.0.
      s = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      ).newState;
      // Lift finger 1 (2->1): end events, continuous value frozen at 2.0.
      const rEnd = processGestureFrame([ph(1, 'up', 0, 0)], pm([[2, 200, 0]]), s, 1032);
      const endKinds = rEnd.gestureEvents.map((e) => e.kind);
      expect(endKinds).toContain('pinch-end');
      expect(endKinds).toContain('rotate-end');
      expect(rEnd.gestureState.pinchScale).toBeCloseTo(2.0, 5);
      s = rEnd.newState;
      // Idle frame with a single finger: frozen value retained (not identity).
      const rIdle = processGestureFrame([], pm([[2, 200, 0]]), s, 1048);
      expect(rIdle.gestureState.pinchScale).toBeCloseTo(2.0, 5);
      s = rIdle.newState;
      // Second finger returns -> new begin, reset to identity 1.0/0.
      const rBegin = processGestureFrame(
        [ph(3, 'down', 300, 0)],
        pm([
          [2, 200, 0],
          [3, 300, 0],
        ]),
        s,
        1064,
      );
      expect(rBegin.gestureEvents.map((e) => e.kind)).toContain('pinch-begin');
      expect(rBegin.gestureState.pinchScale).toBeCloseTo(1.0, 5);
      expect(rBegin.gestureState.rotationAngle).toBeCloseTo(0, 5);
    });

    it('third finger down is ignored while a pair is locked (D-11)', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      s = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      ).newState;
      // Third finger arrives; locked pair (1,2) unchanged, no new begin.
      const r = processGestureFrame(
        [ph(3, 'down', 50, 50)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
          [3, 50, 50],
        ]),
        s,
        1032,
      );
      expect(r.gestureEvents.map((e) => e.kind)).not.toContain('pinch-begin');
      // Scale still reflects the locked pair (1,2): 200/100 = 2.0.
      expect(r.gestureState.pinchScale).toBeCloseTo(2.0, 5);
    });

    it('AC-12: no active gesture returns identity empty signal without throwing', () => {
      const s = createRecognizerState();
      const r = processGestureFrame([], EMPTY_MAP, s, 1000);
      expect(r.gestureState.pinchScale).toBe(1);
      expect(r.gestureState.rotationAngle).toBe(0);
      expect(r.gestureEvents).toEqual([]);
    });

    it('AC-12: active gesture retains continuous value on an idle (no-event) frame', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      s = processGestureFrame(
        [ph(2, 'move', 300, 0)],
        pm([
          [1, 0, 0],
          [2, 300, 0],
        ]),
        s,
        1016,
      ).newState;
      // Idle frame: fingers unchanged, no events -> value retained (scale 3.0).
      const r = processGestureFrame(
        [],
        pm([
          [1, 0, 0],
          [2, 300, 0],
        ]),
        s,
        1032,
      );
      expect(r.gestureState.pinchScale).toBeCloseTo(3.0, 5);
      expect(r.gestureEvents).toEqual([]);
    });
  });

  describe('m5t2: swipe recognizer (D-10)', () => {
    it('fast flick over threshold emits a single swipe (right) with direction (AC-15)', () => {
      // Frame 1: down at origin, t=1000.
      let res = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      // Frame 2: move + up at (100,0), t=1100 -> displacement 100 over 100ms = 1.0 px/ms >= 0.5.
      res = processGestureFrame(
        [ph(1, 'move', 100, 0), ph(1, 'up', 100, 0)],
        EMPTY_MAP,
        res.newState,
        1100,
      );
      const swipes = res.gestureEvents.filter((e) => e.kind === 'swipe');
      expect(swipes).toHaveLength(1);
      const sw = swipes[0];
      if (sw && sw.kind === 'swipe') {
        expect(sw.direction).toBe('right');
        expect(sw.pointerId).toBe(1);
        expect(sw.pointerType).toBe('touch');
      }
    });

    it('slow drag under threshold emits no swipe on up', () => {
      let res = processGestureFrame([ph(2, 'down', 0, 0)], pm([[2, 0, 0]]), createRecognizerState(), 2000);
      // Move only 10px over 100ms -> 0.1 px/ms < 0.5.
      res = processGestureFrame([ph(2, 'move', 10, 0), ph(2, 'up', 10, 0)], EMPTY_MAP, res.newState, 2100);
      expect(res.gestureEvents.filter((e) => e.kind === 'swipe')).toHaveLength(0);
    });

    it('direction classification: pure-down, pure-left, diagonal-dominant-horizontal', () => {
      // pure down (screen y increases downward -> 'down')
      let r = processGestureFrame([ph(3, 'down', 0, 0)], pm([[3, 0, 0]]), createRecognizerState(), 3000);
      r = processGestureFrame([ph(3, 'move', 0, 100), ph(3, 'up', 0, 100)], EMPTY_MAP, r.newState, 3100);
      let sw = r.gestureEvents.find((e) => e.kind === 'swipe');
      expect(sw && sw.kind === 'swipe' ? sw.direction : undefined).toBe('down');

      // pure left
      r = processGestureFrame([ph(4, 'down', 100, 0)], pm([[4, 100, 0]]), createRecognizerState(), 3200);
      r = processGestureFrame([ph(4, 'move', 0, 0), ph(4, 'up', 0, 0)], EMPTY_MAP, r.newState, 3300);
      sw = r.gestureEvents.find((e) => e.kind === 'swipe');
      expect(sw && sw.kind === 'swipe' ? sw.direction : undefined).toBe('left');

      // up-right diagonal, larger horizontal component -> 'right'
      r = processGestureFrame([ph(5, 'down', 0, 100)], pm([[5, 0, 100]]), createRecognizerState(), 3400);
      r = processGestureFrame([ph(5, 'move', 120, 40), ph(5, 'up', 120, 40)], EMPTY_MAP, r.newState, 3500);
      sw = r.gestureEvents.find((e) => e.kind === 'swipe');
      expect(sw && sw.kind === 'swipe' ? sw.direction : undefined).toBe('right');
    });

    it('AC-15: swipe is a single instantaneous event with no begin/end pair', () => {
      let r = processGestureFrame([ph(6, 'down', 0, 0)], pm([[6, 0, 0]]), createRecognizerState(), 4000);
      r = processGestureFrame([ph(6, 'move', 200, 0), ph(6, 'up', 200, 0)], EMPTY_MAP, r.newState, 4100);
      const kinds = r.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('swipe');
      expect(kinds).not.toContain('pinch-begin');
      expect(kinds).not.toContain('pinch-end');
      // Next frame carries no lingering swipe (one-frame lifecycle).
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 4116);
      expect(r2.gestureEvents.filter((e) => e.kind === 'swipe')).toHaveLength(0);
    });

    it('velocity threshold uses SWIPE_WINDOW_MS + SWIPE_VELOCITY_THRESHOLD constants', () => {
      expect(SWIPE_VELOCITY_THRESHOLD).toBe(0.5);
      expect(SWIPE_WINDOW_MS).toBe(100);
    });
  });

  describe('m5t3: long-press recognizer (D-10, AC-16)', () => {
    it('constants match D-10 defaults', () => {
      expect(LONG_PRESS_DURATION_MS).toBe(500);
      expect(LONG_PRESS_SLOP).toBe(10);
      expect(DOUBLE_TAP_INTERVAL_MS).toBe(350);
      expect(DOUBLE_TAP_DISTANCE).toBe(10);
    });

    it('hold >= 500ms within slop fires exactly one long-press', () => {
      // Down at t=1000.
      let res = processGestureFrame([ph(1, 'down', 50, 50)], pm([[1, 50, 50]]), createRecognizerState(), 1000);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      // Idle frame at t=1400 (400ms elapsed) -> not yet.
      res = processGestureFrame([], pm([[1, 50, 50]]), res.newState, 1400);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      // Idle frame at t=1500 (500ms elapsed) -> fires.
      res = processGestureFrame([], pm([[1, 50, 50]]), res.newState, 1500);
      const lp = res.gestureEvents.filter((e) => e.kind === 'long-press');
      expect(lp).toHaveLength(1);
      if (lp[0] && lp[0].kind === 'long-press') {
        expect(lp[0].pointerId).toBe(1);
        expect(lp[0].x).toBe(50);
        expect(lp[0].y).toBe(50);
        expect(lp[0].pointerType).toBe('touch');
      }
      // Subsequent idle frame does not re-fire (one-shot per press).
      res = processGestureFrame([], pm([[1, 50, 50]]), res.newState, 1700);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });

    it('AC-16 clock decoupling: no pointer events, only clock advance -> timer still fires', () => {
      // Down, then ALL subsequent frames have an EMPTY phase queue. Only the
      // injected clock advances. The timer must still cross 500ms and fire.
      let res = processGestureFrame([ph(2, 'down', 10, 10)], pm([[2, 10, 10]]), createRecognizerState(), 0);
      // Many empty frames advancing the clock; finger stays down in pointerMap.
      res = processGestureFrame([], pm([[2, 10, 10]]), res.newState, 200);
      res = processGestureFrame([], pm([[2, 10, 10]]), res.newState, 400);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      res = processGestureFrame([], pm([[2, 10, 10]]), res.newState, 550);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(1);
    });

    it('AC-16 (2b) F-1 falsification: single empty-queue frame past 500ms fires (event-coupled impl FAILS)', () => {
      // The ONLY pointer event ever seen is the down at t=0. If a recognizer
      // coupled its timer to event arrival (advances only when the phase queue
      // is non-empty), this assertion FAILS -- the empty-queue frame at t=600
      // would never advance the timer. A clock-driven recognizer fires.
      const afterDown = processGestureFrame([ph(3, 'down', 0, 0)], pm([[3, 0, 0]]), createRecognizerState(), 0);
      const idle = processGestureFrame([], pm([[3, 0, 0]]), afterDown.newState, 600);
      expect(idle.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(1);
    });

    it('move beyond slop before 500ms disarms -> no long-press', () => {
      let res = processGestureFrame([ph(4, 'down', 0, 0)], pm([[4, 0, 0]]), createRecognizerState(), 0);
      // Move 15px (> slop 10) at t=100.
      res = processGestureFrame([ph(4, 'move', 15, 0)], pm([[4, 15, 0]]), res.newState, 100);
      // Clock crosses 500ms; disarmed -> no fire.
      res = processGestureFrame([], pm([[4, 15, 0]]), res.newState, 600);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });

    it('up before 500ms cancels the pending long-press', () => {
      let res = processGestureFrame([ph(5, 'down', 0, 0)], pm([[5, 0, 0]]), createRecognizerState(), 0);
      // Up at t=300 (before 500ms).
      res = processGestureFrame([ph(5, 'up', 0, 0)], EMPTY_MAP, res.newState, 300);
      // Later clock -> nothing pending.
      res = processGestureFrame([], EMPTY_MAP, res.newState, 800);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });
  });

  describe('m5t3: double-tap recognizer (D-10, AC-17)', () => {
    it('two ups within 350ms + 10px window fire one double-tap (AC-17)', () => {
      let res = createRecognizerState();
      // First tap: down + up at (0,0), t=1000.
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), res, 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
      // Second tap: down + up at (5,5), t=1300 (interval 290ms, dist ~7px).
      r = processGestureFrame([ph(2, 'down', 5, 5)], pm([[2, 5, 5]]), r.newState, 1300);
      r = processGestureFrame([ph(2, 'up', 5, 5)], EMPTY_MAP, r.newState, 1310);
      const dt = r.gestureEvents.filter((e) => e.kind === 'double-tap');
      expect(dt).toHaveLength(1);
      if (dt[0] && dt[0].kind === 'double-tap') {
        expect(dt[0].pointerType).toBe('touch');
      }
    });

    it('second tap outside time window (>350ms) does not fire', () => {
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      // Second up at t=1400 -> interval 390ms > 350ms.
      r = processGestureFrame([ph(2, 'down', 0, 0)], pm([[2, 0, 0]]), r.newState, 1390);
      r = processGestureFrame([ph(2, 'up', 0, 0)], EMPTY_MAP, r.newState, 1400);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
    });

    it('second tap outside distance window (>10px) does not fire', () => {
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      // Second up at (20,0) -> distance 20px > 10px, within time window.
      r = processGestureFrame([ph(2, 'down', 20, 0)], pm([[2, 20, 0]]), r.newState, 1100);
      r = processGestureFrame([ph(2, 'up', 20, 0)], EMPTY_MAP, r.newState, 1110);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
    });

    it('AC-17: double-tap is a single instantaneous event (no lingering next frame)', () => {
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      r = processGestureFrame([ph(2, 'down', 2, 2)], pm([[2, 2, 2]]), r.newState, 1200);
      r = processGestureFrame([ph(2, 'up', 2, 2)], EMPTY_MAP, r.newState, 1210);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(1);
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 1226);
      expect(r2.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
    });
  });

  describe('m5t4: gesture cancel + idle retention (AC-18/E-7/E-8/AC-12)', () => {
    // onBlur maps to the recognizer's cancel-phase path (D-4): the backend
    // funnel pushes a cancel phase per active pointer into the queue, which
    // the recognizer consumes before drain. Backend-level onBlur e2e is in
    // the m5t8 integration block; here we drive the recognizer directly.

    /** Set up an active 2-finger pinch spread to scale 2.0. */
    function activePinch(): RecognizerState {
      let s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        createRecognizerState(),
        1000,
      ).newState;
      s = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      ).newState;
      return s;
    }

    it('pointercancel on active pinch -> cancel events + values reset to identity (AC-18/E-8)', () => {
      const s = activePinch();
      // A cancel phase for one locked finger cancels the pair.
      const r = processGestureFrame([ph(1, 'cancel', 0, 0)], pm([[2, 200, 0]]), s, 1032);
      const kinds = r.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-cancel');
      expect(kinds).toContain('rotate-cancel');
      // Continuous value reset to identity (NOT frozen, unlike the 2->1 end path).
      expect(r.gestureState.pinchScale).toBe(1);
      expect(r.gestureState.rotationAngle).toBe(0);
      // Next idle frame emits no ghost gesture.
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 1048);
      expect(r2.gestureEvents).toEqual([]);
      expect(r2.gestureState.pinchScale).toBe(1);
    });

    it('onBlur path (cancel phases for all pointers) -> cancels + identity + no ghost next frame', () => {
      const s = activePinch();
      // Backend onBlur clears pointerMap and pushes a cancel phase per pointer.
      const r = processGestureFrame(
        [ph(1, 'cancel', 0, 0), ph(2, 'cancel', 200, 0)],
        EMPTY_MAP,
        s,
        1032,
      );
      expect(r.gestureEvents.map((e) => e.kind)).toContain('pinch-cancel');
      expect(r.gestureState.pinchScale).toBe(1);
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 1048);
      expect(r2.gestureEvents).toEqual([]);
    });

    it('idle frames retain continuous values while gesture stays active (AC-12)', () => {
      let s = activePinch(); // scale 2.0
      for (const t of [1032, 1048, 1064, 1080]) {
        const r = processGestureFrame(
          [],
          pm([
            [1, 0, 0],
            [2, 200, 0],
          ]),
          s,
          t,
        );
        expect(r.gestureState.pinchScale).toBeCloseTo(2.0, 5);
        expect(r.gestureEvents).toEqual([]);
        s = r.newState;
      }
    });

    it('long-press armed then cancelled before 500ms -> timer reset, no fire (E-7)', () => {
      let s = processGestureFrame([ph(7, 'down', 5, 5)], pm([[7, 5, 5]]), createRecognizerState(), 0);
      // onBlur before 500ms: cancel phase + cleared pointerMap.
      s = processGestureFrame([ph(7, 'cancel', 5, 5)], EMPTY_MAP, s.newState, 200);
      // Clock advances well past 500ms; timer must have been reset.
      const r = processGestureFrame([], EMPTY_MAP, s.newState, 800);
      expect(r.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });

    it('cascading: pinch + long-press both active -> cancel resets both independently (AC-18)', () => {
      // Pinch on (1,2); a third finger (3) arms a long-press (ignored by pinch, D-11).
      let s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        createRecognizerState(),
        0,
      ).newState;
      s = processGestureFrame(
        [ph(3, 'down', 300, 300)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
          [3, 300, 300],
        ]),
        s,
        16,
      ).newState;
      // Cancel everything (onBlur).
      const r = processGestureFrame(
        [ph(1, 'cancel', 0, 0), ph(2, 'cancel', 100, 0), ph(3, 'cancel', 300, 300)],
        EMPTY_MAP,
        s,
        32,
      );
      expect(r.gestureEvents.map((e) => e.kind)).toContain('pinch-cancel');
      expect(r.gestureState.pinchScale).toBe(1);
      // After cancel, advancing the clock past 500ms fires NO long-press for finger 3.
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 700);
      expect(r2.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });
  });

  describe('m5t8: gesture e2e through backend + snapshot (AC-11/AC-13)', () => {
    /** Backend fixture with an injectable fake clock. */
    function gestureBackend(): {
      backend: InputBackend;
      fire(kind: string, ev: Record<string, unknown>): void;
      setNow(t: number): void;
      blur(): void;
      handle: () => void;
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
        width: 800,
        height: 600,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        setPointerCapture: () => {},
        style: {} as CSSStyleDeclaration,
      } as unknown as HTMLCanvasElement;
      const doc = { ...makeTarget('document'), hasFocus: () => true } as unknown as Document;
      const win = makeTarget('window') as unknown as Window;
      let clock = 0;
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        now: () => clock,
      });
      return {
        backend: handle.backend,
        fire(kind, ev) {
          for (const h of listeners.get('canvas')?.get(kind) ?? []) h(ev as Event);
        },
        setNow(t) { clock = t; },
        blur() {
          for (const h of listeners.get('window')?.get('blur') ?? []) h({} as Event);
        },
        handle,
      };
    }

    it('full pipeline: pinch flows through sample() into snap.gesture + snap.gestureEvents (AC-13)', () => {
      const bb = gestureBackend();
      // Two fingers down at t=0.
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      let snap = snapshotFromSample(bb.backend.sample());
      let kinds = snap.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-begin');
      expect(snap.gesture.pinchScale).toBeCloseTo(1.0, 5);

      // Spread finger 2 to x=200 -> scale 2.0. No begin/end on this frame.
      bb.setNow(16);
      bb.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 0, movementX: 100, movementY: 0 });
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gesture.pinchScale).toBeCloseTo(2.0, 5);
      expect(snap.gestureEvents.map((e) => e.kind)).not.toContain('pinch-begin');

      // Lift finger 1 -> pinch-end in this frame's events, value frozen at 2.0.
      bb.setNow(32);
      bb.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      snap = snapshotFromSample(bb.backend.sample());
      kinds = snap.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-end');
      expect(snap.gesture.pinchScale).toBeCloseTo(2.0, 5);

      bb.handle();
    });

    it('AC-13 lifecycle: begin/end appear only on their frames, middle frames empty', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      let snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'pinch-begin')).toHaveLength(1);

      // Idle frame: no pointer events -> no lifecycle events.
      bb.setNow(16);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents).toHaveLength(0);

      bb.setNow(32);
      bb.fire('pointerup', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'pinch-end')).toHaveLength(1);

      // Next frame empty again (one-frame lifecycle).
      bb.setNow(48);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents).toHaveLength(0);

      bb.handle();
    });

    it('AC-11 gesture half: same-frame double read returns identical GestureState object', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      const snap = snapshotFromSample(bb.backend.sample());
      const first = snap.gesture;
      const second = snap.gesture;
      expect(first).toBe(second); // frozen: identical reference
      expect(first.pinchScale).toBe(second.pinchScale);
      bb.handle();
    });

    it('AC-16 through backend: long-press fires on idle frames driven only by injected clock', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 50 });
      let snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      // No further pointer events; only advance the clock past 500ms.
      bb.setNow(600);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(1);
      bb.handle();
    });

    it('multiple simultaneous gestures: pinch (fingers 1,2) + long-press (finger 3)', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      snapshotFromSample(bb.backend.sample()); // pinch-begin frame
      // Finger 3 arrives (ignored by pinch pair D-11) but arms a long-press.
      bb.setNow(16);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 400, clientY: 400 });
      snapshotFromSample(bb.backend.sample());
      // Advance past 500ms -> finger 3 long-press fires; pinch value still live.
      bb.setNow(600);
      const snap = snapshotFromSample(bb.backend.sample());
      const lp = snap.gestureEvents.filter((e) => e.kind === 'long-press');
      expect(lp).toHaveLength(1);
      if (lp[0] && lp[0].kind === 'long-press') expect(lp[0].pointerId).toBe(3);
      // Fingers 1,2 are committed to the pinch and do NOT fire long-presses.
      expect(lp.every((e) => e.kind === 'long-press' && e.pointerId === 3)).toBe(true);
      bb.handle();
    });

    it('onBlur end-to-end: active pinch cancelled + values reset, no ghost next frame (AC-18)', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      snapshotFromSample(bb.backend.sample());
      bb.setNow(16);
      bb.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 300, clientY: 0, movementX: 200, movementY: 0 });
      let snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gesture.pinchScale).toBeCloseTo(3.0, 5);
      // Blur pushes cancel phases; recognizer consumes them before drain.
      bb.setNow(32);
      bb.blur();
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.map((e) => e.kind)).toContain('pinch-cancel');
      expect(snap.gesture.pinchScale).toBe(1);
      // Next frame: no ghost gesture.
      bb.setNow(48);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents).toHaveLength(0);
      expect(snap.gesture.pinchScale).toBe(1);
      bb.handle();
    });

    it('no active gesture: snap.gesture identity + empty gestureEvents (AC-12)', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      const snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gesture.pinchScale).toBe(1);
      expect(snap.gesture.rotationAngle).toBe(0);
      expect(snap.gestureEvents).toEqual([]);
      bb.handle();
    });

    it('AC-19 real consumption: GestureEvent consumer exhaustively switches on kind + pointerType', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      const snap = snapshotFromSample(bb.backend.sample());
      // Exhaustive consumption path: no default branch on either discriminant.
      const label = (e: GestureEvent): string => {
        const device = ((pt: PointerType): string => {
          switch (pt) {
            case 'mouse': return 'M';
            case 'pen': return 'P';
            case 'touch': return 'T';
          }
        })(e.pointerType);
        switch (e.kind) {
          case 'pinch-begin': case 'pinch-end': case 'pinch-cancel':
          case 'rotate-begin': case 'rotate-end': case 'rotate-cancel':
            return `${e.kind}:${device}`;
          case 'swipe': return `swipe-${e.direction}:${device}`;
          case 'long-press': return `lp:${device}`;
          case 'double-tap': return `dt:${device}`;
        }
      };
      const labels = snap.gestureEvents.map(label);
      expect(labels.some((l) => l.startsWith('pinch-begin:T'))).toBe(true);
      bb.handle();
    });
  });
}