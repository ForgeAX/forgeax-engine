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

// Split source block: M3 virtual joystick multi-pointer isolation.
{
  describe('virtual joystick multi-pointer isolation (AC-12)', () => {
    const configA: VirtualJoystickConfig = {
      name: 'move',
      mode: 'fixed',
      region: { x: 0, y: 0, width: 100, height: 100 },
      radius: 50,
      deadzone: 0.1,
    };
    const configB: VirtualJoystickConfig = {
      name: 'aim',
      mode: 'fixed',
      region: { x: 200, y: 0, width: 100, height: 100 },
      radius: 50,
      deadzone: 0.1,
    };

    function makePointerMap(entries: { id: number; x: number; y: number }[]): Map<number, { pointerId: number; x: number; y: number; active: boolean }> {
      const m = new Map<number, { pointerId: number; x: number; y: number; active: boolean }>();
      for (const e of entries) {
        m.set(e.id, { pointerId: e.id, x: e.x, y: e.y, active: true });
      }
      return m;
    }

    it('finger A bound to joystick; finger B outside region does not affect joystick vector', () => {
      const bindState = new Map<string, BindState>();
      // Finger A (pointerId=1) bound to 'move' joystick, dragged to half-radius right.
      bindState.set('move', { pointerId: 1, originX: 50, originY: 50 });

      // Finger B (pointerId=2) at (400, 400) — outside any region.
      const pointerMap = makePointerMap([
        { id: 1, x: 75, y: 50 },
        { id: 2, x: 400, y: 400 },
      ]);
      const axes = deriveVirtualAxes([configA], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      // Vector should be (25/50, 0) = (0.5, 0), unaffected by finger B.
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('two joysticks each bound to a different finger; vectors are independent', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 50, originY: 50 });
      bindState.set('aim', { pointerId: 2, originX: 250, originY: 50 });

      // Both fingers at half-radius right of their respective origins.
      const pointerMap = makePointerMap([
        { id: 1, x: 75, y: 50 },
        { id: 2, x: 275, y: 50 },
      ]);
      const axes = deriveVirtualAxes([configA, configB], pointerMap, bindState);
      expect(axes).toHaveLength(2);
      expect(axes[0].name).toBe('move');
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[1].name).toBe('aim');
      expect(axes[1].x).toBeCloseTo(0.5);
    });

    it('finger A up: joystick A returns zero; joystick B unaffected', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 50, originY: 50 });
      bindState.set('aim', { pointerId: 2, originX: 250, originY: 50 });

      // Finger A up → unbind move.
      handleVirtualJoystickUnbind(bindState, 1);

      // Only finger B is active, at half-radius right.
      const pointerMap = makePointerMap([{ id: 2, x: 275, y: 50 }]);
      const axes = deriveVirtualAxes([configA, configB], pointerMap, bindState);
      expect(axes).toHaveLength(2);
      // Joystick A unbound → zero.
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
      // Joystick B unaffected.
      expect(axes[1].x).toBeCloseTo(0.5);
      expect(axes[1].y).toBeCloseTo(0);
    });

    it('unbound joystick with no active pointer returns zero vector', () => {
      const bindState = new Map<string, BindState>();
      // No binding at all.
      const pointerMap = makePointerMap([]);
      const axes = deriveVirtualAxes([configA, configB], pointerMap, bindState);
      expect(axes).toHaveLength(2);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[1].x).toBeCloseTo(0);
    });
  });
}
