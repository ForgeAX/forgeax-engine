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

// Split source block: M3 virtual joystick floating mode.
{
  describe('virtual joystick floating mode (AC-11)', () => {
    const floatingConfig: VirtualJoystickConfig = {
      name: 'move',
      mode: 'floating',
      region: { x: 0, y: 0, width: 200, height: 200 },
      radius: 60,
      deadzone: 0.05,
    };

    function makePointerMap(entries: { id: number; x: number; y: number }[]): Map<number, { pointerId: number; x: number; y: number; active: boolean }> {
      const m = new Map<number, { pointerId: number; x: number; y: number; active: boolean }>();
      for (const e of entries) {
        m.set(e.id, { pointerId: e.id, x: e.x, y: e.y, active: true });
      }
      return m;
    }

    it('first touch in region sets origin; drag 30px right yields vec=(0.5, 0)', () => {
      const bindState = new Map<string, BindState>();
      // Simulate: pointerdown at (80, 80) in region → origin = (80, 80).
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      // Pointer dragged to (110, 80). vec = (110-80)/60 = 30/60 = 0.5.
      const pointerMap = makePointerMap([{ id: 1, x: 110, y: 80 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].name).toBe('move');
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('drag beyond 2R clamps to unit magnitude', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      // Pointer at (80+200, 80): raw vec = (200, 0) / 60 = (3.33, 0), clamped.
      const pointerMap = makePointerMap([{ id: 1, x: 280, y: 80 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].x).toBeCloseTo(1.0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('deadzone: micro-move below deadzone yields zero vector', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      // 2px from origin: 2/60 ≈ 0.033 < 0.05 deadzone → zero.
      const pointerMap = makePointerMap([{ id: 1, x: 82, y: 80 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('pointer up yields zero vector and unbinds', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      handleVirtualJoystickUnbind(bindState, 1);
      const pointerMap = makePointerMap([]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('next pointerdown creates new origin (re-origin)', () => {
      const bindState = new Map<string, BindState>();

      // First touch: bind at (80, 80). Unbind. Then re-bind at (150, 150).
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });
      handleVirtualJoystickUnbind(bindState, 1);

      // New pointerdown at (150, 150) → new origin.
      bindState.set('move', { pointerId: 2, originX: 150, originY: 150 });

      // Drag 30px right from new origin → vec = (30/60) = 0.5.
      const pointerMap = makePointerMap([{ id: 2, x: 180, y: 150 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });
  });
}
