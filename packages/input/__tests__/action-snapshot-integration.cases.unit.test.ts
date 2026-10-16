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
  // ─── from action-snapshot-integration.test.ts ───

  function sampleForActionInt(overrides?: {
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

  describe('action-snapshot-integration.test.ts', () => {
    describe('snap.action() end-to-end pipeline', () => {
      it('mapped action key press → snap.action(jump).isPressed()=true, justPressed()=true, strength=1', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(
          sample,
          actionStates,
        );
        expect(snap.action('jump').isPressed()).toBe(true);
        expect(snap.action('jump').justPressed()).toBe(true);
        expect(snap.action('jump').strength).toBe(1.0);
      });

      it('unregistered action → isPressed()=false, strength=0, never throws', () => {
        const map: import('../src/action-state').ActionConfig[] = [];
        const sample = sampleForActionInt({ downKeys: [] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        expect(snap.action('nonexistent').isPressed()).toBe(false);
        expect(snap.action('nonexistent').strength).toBe(0);
        expect(snap.action('nonexistent').justPressed()).toBe(false);
        expect(snap.action('nonexistent').justReleased()).toBe(false);
      });

      it('multiple mapped actions work independently', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
          { action: 'fire', bindings: [{ type: 'key', key: 'f' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        expect(snap.action('jump').isPressed()).toBe(true);
        expect(snap.action('fire').isPressed()).toBe(false);
      });
    });

    describe('snap.action() — E-9 pre-run empty snapshot', () => {
      it('createInputSnapshot → snap.action(any) returns empty signal', () => {
        const snap = createInputSnapshot();
        expect(snap.action('jump').isPressed()).toBe(false);
        expect(snap.action('jump').strength).toBe(0);
        expect(snap.action('jump').justPressed()).toBe(false);
        expect(snap.action('jump').justReleased()).toBe(false);
      });
    });

    describe('snap.action() — AC-11 same-frame freeze (action half)', () => {
      it('two snap.action() calls in same frame → identical return', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        const a = snap.action('jump');
        const b = snap.action('jump');
        expect(a.isPressed()).toBe(b.isPressed());
        expect(a.strength).toBe(b.strength);
      });
    });

    describe('snap.action() — AC-02 type inference', () => {
      it('isPressed() returns boolean without as assertion', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        const pressed: boolean = snap.action('jump').isPressed();
        expect(pressed).toBe(true);
      });

      it('strength returns number without as assertion', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        const s: number = snap.action('jump').strength;
        expect(s).toBe(1.0);
      });
    });
  });
}