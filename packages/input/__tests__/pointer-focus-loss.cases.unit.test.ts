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

// Split source block: M2 focus-loss cleanup.
{
  describe('focus-loss cleanup (AC-10)', () => {
    function makeSnap(
      opts: {
        gamepads?: readonly GamepadSlotSample[];
        pointers?: readonly import('../src/input-snapshot').PointerSample[];
        pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
        focused?: boolean;
      },
    ): InputSnapshot {
      const world = new World();
      const backend = fixtureBackend({
        gamepads: opts.gamepads,
        pointers: opts.pointers,
        pointerEvents: opts.pointerEvents,
        capabilities: { gamepad: true, pointer: true },
        focused: opts.focused ?? true,
      });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      return snap;
    }

    function pev(overrides: Partial<import('../src/input-snapshot').PointerPhaseEvent> = {}): import('../src/input-snapshot').PointerPhaseEvent {
      return {
        pointerId: overrides.pointerId ?? 1,
        phase: overrides.phase ?? 'cancel',
        x: overrides.x ?? 0,
        y: overrides.y ?? 0,
        pressure: overrides.pressure ?? 0,
        pointerType: overrides.pointerType ?? 'touch',
      };
    }

    it('after blur, active pointers cleared and cancel events queued', () => {
      const snap = makeSnap({
        pointers: [],
        pointerEvents: [pev({ pointerId: 1, phase: 'cancel' }), pev({ pointerId: 2, phase: 'cancel' })],
      });
      expect(snap.pointer(1).active).toBe(false);
      expect(snap.pointer(2).active).toBe(false);
      expect(snap.pointerEvents).toHaveLength(2);
      expect(snap.pointerEvents[0].phase).toBe('cancel');
      expect(snap.pointerEvents[1].phase).toBe('cancel');
    });

    it('visibilitychange(hidden) produces same cleanup as blur', () => {
      const snap = makeSnap({
        pointers: [],
        pointerEvents: [pev({ pointerId: 1, phase: 'cancel' })],
        focused: false,
      });
      expect(snap.pointer(1).active).toBe(false);
      expect(snap.pointerEvents).toHaveLength(1);
      expect(snap.pointerEvents[0].phase).toBe('cancel');
    });

    it('gamepad edge reset after blur: justPressed/justReleased clean', () => {
      const snap = makeSnap({
        gamepads: [
          buildGamepadSlot(0, { pressed: [0, 1], justPressed: new Set(), justReleased: new Set() }),
        ],
        pointers: [],
        pointerEvents: [],
      });
      const g = snap.gamepad(0);
      expect(g.connected).toBe(true);
      expect(g.justPressed(0)).toBe(false);
      expect(g.justReleased(0)).toBe(false);
    });

    it('after focus recovery, gamepad polling resumes normally (no phantom held)', () => {
      const snap = makeSnap({
        gamepads: [buildGamepadSlot(0, { pressed: [0] })],
        pointers: [{
          pointerId: 1, x: 100, y: 200, pressure: 0, pointerType: 'touch', active: true,
          delta: Object.freeze({ x: 0, y: 0 }),
        }],
        pointerEvents: [],
        focused: true,
      });
      expect(snap.gamepad(0).connected).toBe(true);
      expect(snap.gamepad(0).standardMapping).toBe(true);
      expect(snap.gamepad(0).button(0)).toBe(true);
      expect(snap.pointer(1).active).toBe(true);
    });
  });
}
