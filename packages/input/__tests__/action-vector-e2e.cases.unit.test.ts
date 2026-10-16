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

// Split source block: M2 getAxis and getVector end-to-end tests.
{
  /**
   * Build a snapshot with action states and input map wired through.
   */
  function makeVectorSnap(
    map: ActionConfig[],
    overrides?: {
      downKeys?: string[];
      gamepads?: readonly GamepadSlotSample[];
    },
  ): InputSnapshot {
    const sample: import('../src/input-snapshot').InputBackendSample = {
      downKeys: new Set(overrides?.downKeys ?? []),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
      gamepads: overrides?.gamepads ?? [],
    };
    const actionStates = deriveActionStates(sample, map);
    return snapshotFromSample(sample, actionStates);
  }

  describe('snap.getVector() end-to-end (m2t3)', () => {
    it('WASD keyboard → getVector via snapshot returns correct directional output', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
        { action: 'moveDown', bindings: [{ type: 'key', key: 's' }] },
        { action: 'moveUp', bindings: [{ type: 'key', key: 'w' }] },
      ];
      // w+d pressed → diagonal up-right
      const snap = makeVectorSnap(map, { downKeys: ['w', 'd'] });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(Math.SQRT1_2, 3);
      expect(v.y).toBeCloseTo(Math.SQRT1_2, 3);
    });

    it('getVector with gamepadAxis keys → snapshot readpoint works', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.2 },
      ];
      // Stick fully right → axis 0 = 1.0
      const snap = makeVectorSnap(map, {
        gamepads: [buildGamepadSlot(0, { axes: [1, 0, 0, 0] })],
      });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('getVector with deadzone override opts via snapshot', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
        { action: 'moveDown', bindings: [{ type: 'key', key: 's' }] },
        { action: 'moveUp', bindings: [{ type: 'key', key: 'w' }] },
      ];
      // With deadzone override 2.0 and digital keys raw=1.0: length=1 <= 2.0 → (0,0)
      const snap = makeVectorSnap(map, { downKeys: ['d'] });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp', { deadzone: 2.0 });
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('getVector with unregistered actions → (0, 0)', () => {
      const map: ActionConfig[] = [];
      const snap = makeVectorSnap(map, { downKeys: ['w', 'd'] });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('getVector without inputMap → returns (0, 0) (empty signal)', () => {
      const snap = createInputSnapshot();
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });
  });

  describe('snap.getAxis() end-to-end (m2t3)', () => {
    it('getAxis via snapshot: keyboard press → correct axis value', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
      ];
      const snap = makeVectorSnap(map, { downKeys: ['d'] });
      expect(snap.getAxis('moveLeft', 'moveRight')).toBeCloseTo(1.0);
    });

    it('getAxis via snapshot: unregistered → returns 0', () => {
      const map: ActionConfig[] = [];
      const snap = makeVectorSnap(map, { downKeys: ['a'] });
      expect(snap.getAxis('moveLeft', 'moveRight')).toBe(0);
    });

    it('getAxis via snapshot: E-12 same action for both ends → 0', () => {
      const map: ActionConfig[] = [
        { action: 'move', bindings: [{ type: 'key', key: 'd' }] },
      ];
      const snap = makeVectorSnap(map, { downKeys: ['d'] });
      expect(snap.getAxis('move', 'move')).toBe(0);
    });
  });

  describe('AC-07 cross-device uniform lever (m2t3)', () => {
    /**
     * AC-07: Same action name bound to 'key' AND 'gamepadButton' →
     * getVector produces identical results for keyboard vs gamepad input.
     * The consumer code has zero knowledge of which device produced the input.
     */
    const crossDeviceWASD: ActionConfig[] = [
      {
        action: 'moveLeft',
        bindings: [
          { type: 'key', key: 'a' },
          { type: 'gamepadButton', button: 14 }, // d-pad left
        ],
      },
      {
        action: 'moveRight',
        bindings: [
          { type: 'key', key: 'd' },
          { type: 'gamepadButton', button: 15 }, // d-pad right
        ],
      },
      {
        action: 'moveDown',
        bindings: [
          { type: 'key', key: 's' },
          { type: 'gamepadButton', button: 13 }, // d-pad down
        ],
      },
      {
        action: 'moveUp',
        bindings: [
          { type: 'key', key: 'w' },
          { type: 'gamepadButton', button: 12 }, // d-pad up
        ],
      },
    ];

    it('keyboard w+d → same getVector output as gamepad dpad-up+dpad-right', () => {
      // Keyboard: w + d pressed
      const keySnap = makeVectorSnap(crossDeviceWASD, { downKeys: ['w', 'd'] });
      const keyVec = keySnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      // Gamepad: d-pad up (button 12) + d-pad right (button 15) pressed
      const gamepadSnap = makeVectorSnap(crossDeviceWASD, {
        gamepads: [buildGamepadSlot(0, { pressed: [12, 15], buttonValues: [[12, 1.0], [15, 1.0]] })],
      });
      const gamepadVec = gamepadSnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      // AC-07: identical action semantic → zero consumer-code delta.
      expect(keyVec.x).toBeCloseTo(gamepadVec.x, 3);
      expect(keyVec.y).toBeCloseTo(gamepadVec.y, 3);
      const keyMag = Math.sqrt(keyVec.x * keyVec.x + keyVec.y * keyVec.y);
      const gpadMag = Math.sqrt(gamepadVec.x * gamepadVec.x + gamepadVec.y * gamepadVec.y);
      expect(keyMag).toBeCloseTo(gpadMag, 3);
    });

    it('keyboard right only → same as gamepad right only', () => {
      const keySnap = makeVectorSnap(crossDeviceWASD, { downKeys: ['d'] });
      const keyVec = keySnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      const gamepadSnap = makeVectorSnap(crossDeviceWASD, {
        gamepads: [buildGamepadSlot(0, { pressed: [15], buttonValues: [[15, 1.0]] })],
      });
      const gamepadVec = gamepadSnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      expect(keyVec.x).toBeCloseTo(gamepadVec.x, 3);
      expect(keyVec.y).toBeCloseTo(gamepadVec.y, 3);
      expect(keyVec.x).toBeCloseTo(1.0);
    });

    it('no input → keyboard and gamepad both return (0, 0)', () => {
      const emptyKeySnap = makeVectorSnap(crossDeviceWASD, { downKeys: [] });
      const keyVec = emptyKeySnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(keyVec.x).toBe(0);
      expect(keyVec.y).toBe(0);

      const emptyGpadSnap = makeVectorSnap(crossDeviceWASD, {
        gamepads: [buildGamepadSlot(0, { pressed: [] })],
      });
      const gpadVec = emptyGpadSnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(gpadVec.x).toBe(0);
      expect(gpadVec.y).toBe(0);
    });
  });
}
