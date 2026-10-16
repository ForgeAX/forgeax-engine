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
  // ─── from input-snapshot.test.ts ───

  function createFakeBackend(): InputBackend & {
    pressKey(key: string): void;
    releaseKey(key: string): void;
    pressButton(i: 0 | 1 | 2): void;
    releaseButton(i: 0 | 1 | 2): void;
    addMovement(x: number, y: number): void;
    setFocus(focused: boolean): void;
  } {
    const downKeys = new Set<string>();
    const upKeys = new Set<string>();
    const buttons = [false, false, false] as [boolean, boolean, boolean];
    let mvx = 0;
    let mvy = 0;
    let focused = true;
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
      } {
        const snap = {
          downKeys: new Set(downKeys),
          upKeys: new Set(upKeys),
          buttons: [buttons[0], buttons[1], buttons[2]] as readonly [boolean, boolean, boolean],
          movementX: mvx,
          movementY: mvy,
          wheelDelta: 0,
          focused,
          pointerLocked: false,
        };
        mvx = 0;
        mvy = 0;
        upKeys.clear();
        return snap;
      },
      detach() {},
      pressKey(key: string): void {
        downKeys.add(key);
        upKeys.delete(key);
      },
      releaseKey(key: string): void {
        downKeys.delete(key);
        upKeys.add(key);
      },
      pressButton(i: 0 | 1 | 2): void {
        buttons[i] = true;
      },
      releaseButton(i: 0 | 1 | 2): void {
        buttons[i] = false;
      },
      addMovement(x: number, y: number): void {
        mvx += x;
        mvy += y;
      },
      setFocus(f: boolean): void {
        focused = f;
        if (!f) {
          upKeys.clear();
        }
      },
    };
  }

  describe('input-snapshot.test.ts', () => {
    describe('InputSnapshot 4-method surface (AC-07)', () => {
      it('keyboard.down returns true while key is held, false otherwise', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressKey('w');
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.keyboard.down('w')).toBe(true);
        expect(snap.keyboard.down('a')).toBe(false);

        backend.releaseKey('w');
        world.update(1 / 60).unwrap();
        const snap2 = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap2.keyboard.down('w')).toBe(false);
      });

      it('keyboard.up reflects the up-edge in the frame after the release', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressKey('space');
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(false);

        backend.releaseKey('space');
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(true);

        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(false);
      });

      it('mouse.movementDelta is frozen at frame-start and cleared next frame', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.addMovement(15, -7);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.mouse.movementDelta).toEqual({ x: 15, y: -7 });

        world.update(1 / 60).unwrap();
        const snap2 = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap2.mouse.movementDelta).toEqual({ x: 0, y: 0 });
      });

      it('mouse.button(0|1|2) returns the held state for each W3C button slot', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressButton(0);
        backend.pressButton(2);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.mouse.button(0)).toBe(true);
        expect(snap.mouse.button(1)).toBe(false);
        expect(snap.mouse.button(2)).toBe(true);
      });

      it('snapshot is exposed as a Resource via insertResource("InputSnapshot")', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        world.update(1 / 60).unwrap();
        expect(world.hasResource('InputSnapshot')).toBe(true);
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(typeof snap.keyboard.down).toBe('function');
        expect(typeof snap.keyboard.up).toBe('function');
        expect(typeof snap.mouse.button).toBe('function');
        expect(snap.mouse.movementDelta).toEqual({ x: 0, y: 0 });
      });

      it('createInputSnapshot() returns an empty snapshot without throwing (engine.run() pre-start)', () => {
        const empty = createInputSnapshot();
        expect(empty.keyboard.down('w')).toBe(false);
        expect(empty.keyboard.up('w')).toBe(false);
        expect(empty.mouse.button(0)).toBe(false);
        expect(empty.mouse.button(1)).toBe(false);
        expect(empty.mouse.button(2)).toBe(false);
        expect(empty.mouse.movementDelta).toEqual({ x: 0, y: 0 });
      });

      it('document.hasFocus()-equivalent: keyboard down state is preserved when unfocused', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressKey('w');
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);

        backend.setFocus(false);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);

        backend.setFocus(true);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);
      });

      it('attachBrowserInputBackend returns a detach handle (charter P3 explicit lifecycle)', () => {
        const fakeCanvas = {
          addEventListener() {},
          removeEventListener() {},
          requestPointerLock() {},
        } as unknown as HTMLCanvasElement;
        const detach = attachBrowserInputBackend(fakeCanvas);
        expect(typeof detach).toBe('function');
        detach();
      });
    });
  });
}