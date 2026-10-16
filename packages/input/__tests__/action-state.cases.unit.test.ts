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
  // ─── from action-state.test.ts ───

  /**
   * Synthetic InputBackendSample for deriveActionStates testing.
   */
  function sampleForAction(overrides?: {
    downKeys?: string[];
    buttons?: [boolean, boolean, boolean];
    gamepads?: readonly GamepadSlotSample[];
  }): import('../src/input-snapshot').InputBackendSample {
    return {
      downKeys: new Set(overrides?.downKeys ?? []),
      upKeys: new Set(),
      buttons: overrides?.buttons ?? [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
      gamepads: overrides?.gamepads ?? [],
    };
  }

  function standardGamepadSlot(index: number, overrides?: {
    pressed?: number[];
    buttonValues?: [number, number][];
    axes?: [number, number, number, number];
  }): GamepadSlotSample {
    const bv = new Map<number, number>(overrides?.buttonValues ?? []);
    return {
      index,
      standardMapping: true,
      pressed: new Set(overrides?.pressed ?? []),
      justPressed: new Set(),
      justReleased: new Set(),
      buttonValues: bv,
      axes: overrides?.axes ?? [0, 0, 0, 0],
    };
  }

  /**
   * Extract strength from ActionState[] for a given action name.
   */
  function strengthOf(states: readonly ActionState[], name: string): number {
    const s = states.find((a) => a.action === name);
    return s?.strength ?? -999;
  }

  function pressedOf(states: readonly ActionState[], name: string): boolean {
    const s = states.find((a) => a.action === name);
    return s?.pressed ?? false;
  }

  function rawOf(states: readonly ActionState[], name: string): number {
    const s = states.find((a) => a.action === name);
    return s?.raw ?? -999;
  }

  function justPressedOf(states: readonly ActionState[], name: string): boolean {
    const s = states.find((a) => a.action === name);
    return s?.justPressed ?? false;
  }

  function justReleasedOf(states: readonly ActionState[], name: string): boolean {
    const s = states.find((a) => a.action === name);
    return s?.justReleased ?? false;
  }

  // Minimal InputMap type for tests (will expand when m1t2 ships the real type)
  type InputMapForTest = readonly ActionConfig[];

  describe('action-state.test.ts', () => {
    describe('deriveActionStates — AC-04 OR/MAX aggregation', () => {
      it('key 1.0 + gamepadButton held → strength = MAX = 1.0 (AC-04 literal)', () => {
        const map: InputMapForTest = [
          {
            action: 'jump',
            bindings: [
              { type: 'key', key: ' ' },
              { type: 'gamepadButton', button: 0 },
            ],
          },
        ];
        const sample = sampleForAction({
          downKeys: [' '],
          gamepads: [
            standardGamepadSlot(0, { pressed: [0], buttonValues: [[0, 1.0]] }),
          ],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(true);
        expect(strengthOf(states, 'jump')).toBeCloseTo(1.0);
      });

      it('key 1.0 + stick 0.3 → strength 1.0 (MAX, not sum)', () => {
        const map: InputMapForTest = [
          {
            action: 'moveRight',
            bindings: [
              { type: 'key', key: 'd' },
              { type: 'gamepadAxis', axis: 0, sign: 1 },
            ],
          },
        ];
        const sample = sampleForAction({
          downKeys: ['d'],
          gamepads: [
            standardGamepadSlot(0, { axes: [0.3, 0, 0, 0] }),
          ],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(true);
        // key contributes 1.0, stick contributes deadzone-remapped 0.3 → ~0.125
        // MAX should be 1.0
        expect(strengthOf(states, 'moveRight')).toBeCloseTo(1.0);
      });
    });

    describe('deriveActionStates — AC-02 strength/raw separation', () => {
      it('digital binding (key) → strength is 1.0, raw is 1.0 when pressed', () => {
        const map: InputMapForTest = [
          { action: 'fire', bindings: [{ type: 'key', key: 'f' }] },
        ];
        const sample = sampleForAction({ downKeys: ['f'] });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'fire')).toBe(true);
        expect(strengthOf(states, 'fire')).toBe(1.0);
        expect(rawOf(states, 'fire')).toBe(1.0);
      });

      it('digital binding (key) → strength is 0, raw is 0 when not pressed', () => {
        const map: InputMapForTest = [
          { action: 'fire', bindings: [{ type: 'key', key: 'f' }] },
        ];
        const sample = sampleForAction({ downKeys: [] });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'fire')).toBe(false);
        expect(strengthOf(states, 'fire')).toBe(0);
        expect(rawOf(states, 'fire')).toBe(0);
      });

      it('analog binding (gamepadAxis) → strength is deadzone-remapped, raw is |value|', () => {
        const map: InputMapForTest = [
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }] },
        ];
        // axis value 0.5 → raw = 0.5, deadzone=0.2 → strength = inverse_lerp(0.2, 1, 0.5) = (0.5-0.2)/(1-0.2) = 0.375
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0.5, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(true); // 0.5 >= 0.2 deadzone
        expect(rawOf(states, 'moveRight')).toBeCloseTo(0.5);
        expect(strengthOf(states, 'moveRight')).toBeCloseTo(0.375, 5);
      });

      it('gamepadAxis below deadzone → pressed=false, strength=0, raw=0.1', () => {
        const map: InputMapForTest = [
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }] },
        ];
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0.1, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(false);
        expect(rawOf(states, 'moveRight')).toBeCloseTo(0.1);
        expect(strengthOf(states, 'moveRight')).toBe(0);
      });

      it('per-action deadzone override', () => {
        const map: InputMapForTest = [
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.5 },
        ];
        // axis 0.4 → below custom deadzone 0.5
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0.4, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(false);
        expect(strengthOf(states, 'moveRight')).toBe(0);
      });

      it('mouseButton binding → digital on/off 1.0/0', () => {
        const map: InputMapForTest = [
          { action: 'click', bindings: [{ type: 'mouseButton', button: 0 }] },
        ];
        const sample = sampleForAction({ buttons: [true, false, false] });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'click')).toBe(true);
        expect(strengthOf(states, 'click')).toBe(1.0);
      });
    });

    describe('deriveActionStates — AC-09 empty signal for unmapped action', () => {
      it('unregistered action → isPressed=false, strength=0, no throw', () => {
        const map: InputMapForTest = [];
        const sample = sampleForAction({ downKeys: [' '] });
        const states = deriveActionStates(sample, map);
        expect(states.length).toBe(0);
      });

      it('some registered, some not — only registered actions appear', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        const states = deriveActionStates(sample, map);
        expect(states.length).toBe(1);
        expect(states[0]!.action).toBe('jump');
      });
    });

    describe('deriveActionStates — AC-03 justPressed/justReleased edge semantics', () => {
      it('justPressed fires on first frame of press, not on held', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        // prevActionStates: empty (no action was pressed)
        const prev: ActionState[] = [];
        const states = deriveActionStates(sample, map, prev);
        expect(justPressedOf(states, 'jump')).toBe(true);
        expect(justReleasedOf(states, 'jump')).toBe(false);
      });

      it('held does not re-fire justPressed', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        // prev has 'jump' already pressed
        const prev: ActionState[] = [
          { deadzone: 0.2,  action: 'jump', pressed: true, justPressed: true, justReleased: false, strength: 1.0, raw: 1.0 },
        ];
        const states = deriveActionStates(sample, map, prev);
        expect(pressedOf(states, 'jump')).toBe(true);
        expect(justPressedOf(states, 'jump')).toBe(false);
      });

      it('justReleased fires on first frame after release', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [] });
        // prev has 'jump' pressed
        const prev: ActionState[] = [
          { deadzone: 0.2,  action: 'jump', pressed: true, justPressed: false, justReleased: false, strength: 1.0, raw: 1.0 },
        ];
        const states = deriveActionStates(sample, map, prev);
        expect(pressedOf(states, 'jump')).toBe(false);
        expect(justReleasedOf(states, 'jump')).toBe(true);
      });

      it('justReleased does not fire on second frame of release', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [] });
        // prev was already released (pressed=false)
        const prev: ActionState[] = [
          { deadzone: 0.2,  action: 'jump', pressed: false, justPressed: false, justReleased: true, strength: 0, raw: 0 },
        ];
        const states = deriveActionStates(sample, map, prev);
        expect(justReleasedOf(states, 'jump')).toBe(false);
      });
    });

    describe('deriveActionStates — E-11 last-wins override', () => {
      it('duplicate action name → later config wins (last-wins)', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: 'a' }], deadzone: 0.1 },
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }], deadzone: 0.3 },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        // 'a' is NOT pressed, ' ' IS pressed. If later config wins, jump should fire.
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(true);
        // 'a' is not pressed, only ' ' binding (later) fires
      });

      it('duplicate action name — earlier config ignored when later resolves', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: 'a' }] },
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: ['a'] });
        // Both 'a' and ' ' — but last-wins means only ' ' binding matters, 'a' ignored
        const states = deriveActionStates(sample, map);
        // Only last binding counts → ' ' is NOT pressed → jump should be false
        expect(pressedOf(states, 'jump')).toBe(false);
      });
    });

    describe('deriveActionStates — E-1 disconnected slot contribution', () => {
      it('binding to disconnected gamepad slot → contributes false/0', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'gamepadButton', button: 0 }] },
        ];
        const sample = sampleForAction({ gamepads: [] }); // no gamepad slots
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(false);
        expect(strengthOf(states, 'jump')).toBe(0);
      });
    });

    describe('deriveActionStates — AC-11 same-frame freeze', () => {
      it('same input, same map → same result (pure function)', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        const a = deriveActionStates(sample, map);
        const b = deriveActionStates(sample, map);
        expect(a).toEqual(b);
      });
    });

    describe('deriveActionStates — gamepadAxis sign semantics', () => {
      it('sign omitted → contributes |value| (trigger semantics)', () => {
        const map: InputMapForTest = [
          { action: 'accelerate', bindings: [{ type: 'gamepadAxis', axis: 2 }] }, // right trigger
        ];
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0, 0, 0.7, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(rawOf(states, 'accelerate')).toBeCloseTo(0.7);
      });

      it('sign=1 → max(0, value), sign=-1 → max(0, -value)', () => {
        const map: InputMapForTest = [
          { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }] },
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }] },
        ];
        // axis 0 = -0.6 (stick pushed left). sign=1 → max(0,-0.6)=0. sign=-1 → max(0,0.6)=0.6
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [-0.6, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(rawOf(states, 'moveLeft')).toBeCloseTo(0.6);
        expect(rawOf(states, 'moveRight')).toBeCloseTo(0);
      });
    });

    describe('deriveActionStates — D-9 gamepad cross-slot aggregation', () => {
      it('gamepadButton aggregates across ALL connected standardMapping slots', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'gamepadButton', button: 0 }] },
        ];
        // slot 0: button 0 not pressed. slot 1: button 0 pressed.
        const sample = sampleForAction({
          gamepads: [
            standardGamepadSlot(0, { pressed: [], buttonValues: [] }),
            standardGamepadSlot(1, { pressed: [0], buttonValues: [[0, 1.0]] }),
          ],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(true);
      });
    });
  });
}