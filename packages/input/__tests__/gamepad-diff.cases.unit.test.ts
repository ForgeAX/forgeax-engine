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

// Split source block: F1 direct diffGamepadFrame unit tests.
{
  /**
   * Build a RawGamepadStub from pressed button indices, button values,
   * and axes arrays. Defaults to standard mapping, connected=true.
   */
  function rawStub(overrides?: {
    index?: number;
    id?: string;
    pressed?: number[];
    buttonValues?: [number, number][];
    axes?: number[];
    mapping?: string;
  }): RawGamepadStub {
    const idx = overrides?.index ?? 0;
    const pressedSet = new Set(overrides?.pressed ?? []);
    const btnValues = new Map<number, number>(overrides?.buttonValues ?? []);
    const buttons: { value: number; pressed: boolean }[] = [];
    for (let b = 0; b < 17; b++) {
      buttons.push({ value: btnValues.get(b) ?? 0, pressed: pressedSet.has(b) });
    }
    return {
      index: idx,
      id: overrides?.id ?? 'standard pad',
      connected: true,
      mapping: overrides?.mapping ?? 'standard',
      buttons,
      axes: overrides?.axes ?? [0, 0, 0, 0],
    };
  }

  /**
   * Build a GamepadSlotSample from the same simplified shape as rawStub,
   * for use as prev-frame state in diffGamepadFrame.
   */
  function prevSlot(overrides?: {
    index?: number;
    pressed?: number[];
    buttonValues?: [number, number][];
    axes?: [number, number, number, number];
    justPressed?: number[];
    justReleased?: number[];
  }): GamepadSlotSample {
    const idx = overrides?.index ?? 0;
    const btnValues = new Map<number, number>(overrides?.buttonValues ?? []);
    return {
      index: idx,
      standardMapping: true,
      pressed: new Set(overrides?.pressed ?? []),
      justPressed: new Set(overrides?.justPressed ?? []),
      justReleased: new Set(overrides?.justReleased ?? []),
      buttonValues: btnValues,
      axes: overrides?.axes ?? [0, 0, 0, 0],
    };
  }

  describe('diffGamepadFrame producer-layer tests (F-1)', () => {
    it('justPressed = cur\\prev: new press appears as edge', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [] }));
      const cur = [rawStub({ pressed: [0] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(0);
      expect(result[0].pressed.has(0)).toBe(true);
      expect(result[0].justPressed.has(0)).toBe(true);
      expect(result[0].justReleased.has(0)).toBe(false);
    });

    it('justReleased = prev\\cur: release appears as edge', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [0] }));
      const cur = [rawStub({ pressed: [] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].pressed.has(0)).toBe(false);
      expect(result[0].justPressed.has(0)).toBe(false);
      expect(result[0].justReleased.has(0)).toBe(true);
    });

    it('consecutive held frames do not re-emit justPressed edge', () => {
      // Frame 1: no buttons pressed.
      const prev1 = new Map<number, GamepadSlotSample>();
      prev1.set(0, prevSlot({ pressed: [] }));
      const cur1 = [rawStub({ pressed: [0] })];
      const r1 = diffGamepadFrame(prev1, cur1);
      expect(r1[0].justPressed.has(0)).toBe(true); // edge emitted

      // Frame 2: button 0 still held — no edge.
      const prev2 = new Map<number, GamepadSlotSample>();
      prev2.set(0, r1[0]);
      const cur2 = [rawStub({ pressed: [0] })];
      const r2 = diffGamepadFrame(prev2, cur2);
      expect(r2[0].pressed.has(0)).toBe(true); // still held
      expect(r2[0].justPressed.has(0)).toBe(false); // edge gone
      expect(r2[0].justReleased.has(0)).toBe(false);
    });

    it('consecutive held frames do not re-emit justReleased edge', () => {
      // Frame 1: button 0 held.
      const prev1 = new Map<number, GamepadSlotSample>();
      prev1.set(0, prevSlot({ pressed: [0] }));
      const cur1 = [rawStub({ pressed: [] })];
      const r1 = diffGamepadFrame(prev1, cur1);
      expect(r1[0].justReleased.has(0)).toBe(true); // edge emitted

      // Frame 2: still not pressed — no edge.
      const prev2 = new Map<number, GamepadSlotSample>();
      prev2.set(0, r1[0]);
      const cur2 = [rawStub({ pressed: [] })];
      const r2 = diffGamepadFrame(prev2, cur2);
      expect(r2[0].pressed.has(0)).toBe(false);
      expect(r2[0].justReleased.has(0)).toBe(false);
    });

    it('disconnected slot: slot in prev but not cur emits no entry', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [0, 2] }));
      // cur: empty array — gamepad unplugged; the absent slot reads as disconnected.
      expect(diffGamepadFrame(prev, [])).toHaveLength(0);
    });

    it('null-padded array: missing indices are skipped, present ones processed', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [] }));
      prev.set(1, prevSlot({ index: 1, pressed: [3] }));
      // Only slot 1 present this frame (slot 0 disconnected).
      const cur = [rawStub({ index: 1, pressed: [3] })];

      const result = diffGamepadFrame(prev, cur);
      // Only the connected slot 1 is emitted; slot 0 is absent.
      expect(result).toHaveLength(1);
      const [slot1] = result;
      expect(slot1.index).toBe(1);
      expect(slot1.standardMapping).toBe(true);
      expect(slot1.pressed.has(3)).toBe(true);
      // No spurious edge — button 3 was already held in prev.
      expect(slot1.justPressed.has(3)).toBe(false);
    });

    it('non-standard mapping: connected=true, standardMapping=false, all readpoints empty', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [rawStub({ mapping: 'xinput-unknown', pressed: [0, 1], axes: [0.5, 0, 0, 0] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(0);
      expect(result[0].standardMapping).toBe(false);
      expect(result[0].pressed.size).toBe(0);
      expect(result[0].justPressed.size).toBe(0);
      expect(result[0].justReleased.size).toBe(0);
      expect(result[0].buttonValues.size).toBe(0);
      expect(result[0].axes).toEqual([0, 0, 0, 0]);
    });

    it('button value tracking: analog triggers pass through raw values', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [], buttonValues: [[6, 0], [7, 0]] }));
      const cur = [rawStub({ buttonValues: [[6, 0.75], [7, 0.3]] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].buttonValues.get(6)).toBe(0.75);
      expect(result[0].buttonValues.get(7)).toBe(0.3);
    });

    it('axes pass through raw values from cur frame', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ axes: [0, 0, 0, 0] }));
      const cur = [rawStub({ axes: [0.5, -0.5, 1, 0.3] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].axes[0]).toBe(0.5);
      expect(result[0].axes[1]).toBe(-0.5);
      expect(result[0].axes[2]).toBe(1);
      expect(result[0].axes[3]).toBe(0.3);
    });

    it('multiple buttons press/release in single frame: independent edges', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [0, 3] }));
      // Frame: button 0 released, button 1 newly pressed, button 3 still held.
      const cur = [rawStub({ pressed: [1, 3] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].pressed.has(0)).toBe(false);
      expect(result[0].pressed.has(1)).toBe(true);
      expect(result[0].pressed.has(3)).toBe(true);
      expect(result[0].justPressed.has(0)).toBe(false);
      expect(result[0].justPressed.has(1)).toBe(true);
      expect(result[0].justPressed.has(3)).toBe(false);
      expect(result[0].justReleased.has(0)).toBe(true);
      expect(result[0].justReleased.has(1)).toBe(false);
      expect(result[0].justReleased.has(3)).toBe(false);
    });

    it('prev frame is empty (first frame): all cur pressed appear as justPressed', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [rawStub({ pressed: [0, 1, 9] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].justPressed.has(0)).toBe(true);
      expect(result[0].justPressed.has(1)).toBe(true);
      expect(result[0].justPressed.has(9)).toBe(true);
      expect(result[0].justReleased.size).toBe(0);
    });
  });
}
