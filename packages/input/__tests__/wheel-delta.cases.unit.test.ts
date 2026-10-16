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
  // ─── from wheel-delta.test.ts ───

  function createWheelFakeBackend(): InputBackend & {
    setWheelDelta(value: number): void;
  } {
    let wheelDeltaPending = 0;
    return {
      sample() {
        const out = {
          downKeys: new Set<string>(),
          upKeys: new Set<string>(),
          buttons: [false, false, false] as readonly [boolean, boolean, boolean],
          movementX: 0,
          movementY: 0,
          wheelDelta: wheelDeltaPending,
          focused: true,
        };
        wheelDeltaPending = 0;
        return out;
      },
      detach() {},
      setWheelDelta(value: number) {
        wheelDeltaPending = value;
      },
    };
  }

  describe('wheel-delta.test.ts', () => {
    describe('InputSnapshot.mouse.wheelDelta (AC-08 + D-7 closed-family extension)', () => {
      it('reports zero before any wheel event observed (P3 empty signal)', () => {
        const empty = createInputSnapshot();
        expect(empty.mouse.wheelDelta).toBe(0);
      });

      it('frame-start scan writes wheelDelta into the snapshot Resource', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(1);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        expect(snap?.mouse.wheelDelta).toBe(1);
      });

      it('snapshot reads are stable within a single frame (frame-start freeze)', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(-2);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        const r1 = snap?.mouse.wheelDelta;
        const r2 = snap?.mouse.wheelDelta;
        expect(r1).toBe(-2);
        expect(r2).toBe(-2);
      });

      it('cross-frame reset: next frame with no wheel event reports zero', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(3);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(3);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(0);
      });

      it('positive and negative deltas pass through unchanged (sign-preserving)', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(7);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(7);
        backend.setWheelDelta(-9);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(
          -9,
        );
      });
    });
  });
}