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

// Split source block: M3 virtual joystick fixed mode.
{
  describe('virtual joystick fixed mode (AC-11)', () => {
    const fixedConfig: VirtualJoystickConfig = {
      name: 'move',
      mode: 'fixed',
      region: { x: 0, y: 0, width: 200, height: 200 },
      anchor: { x: 100, y: 100 },
      radius: 50,
      deadzone: 0.1,
    };

    function makePointerMap(entries: { id: number; x: number; y: number }[]): Map<number, { readonly x: number; readonly y: number }> {
      const m = new Map<number, { readonly x: number; readonly y: number }>();
      for (const e of entries) {
        m.set(e.id, { x: e.x, y: e.y });
      }
      return m;
    }

    it('fixed mode uses anchor as origin: drag half-radius right yields vec=(0.5, 0)', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // Pointer at anchor + 25px right = (125, 100). vec = (125-100)/50 = 0.5.
      const pointerMap = makePointerMap([{ id: 1, x: 125, y: 100 }]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].name).toBe('move');
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('drag beyond 2R clamps to unit magnitude', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // Pointer at (100+200, 100): raw vec = (200, 0) / 50 = (4, 0), clamped to 1.
      const pointerMap = makePointerMap([{ id: 1, x: 300, y: 100 }]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].x).toBeCloseTo(1.0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('deadzone: micro-move within deadzone threshold yields zero vector', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // 3px from anchor: 3/50 = 0.06 < 0.1 deadzone → zero vector.
      const pointerMap = makePointerMap([{ id: 1, x: 103, y: 100 }]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('pointer up yields zero vector and unbinds', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // Unbind, then derive: unbound joystick gives zero vector.
      handleVirtualJoystickUnbind(bindState, 1);

      const pointerMap = makePointerMap([]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });
  });
}
