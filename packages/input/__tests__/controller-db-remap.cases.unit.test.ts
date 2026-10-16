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

// Split source block: M3 diffGamepadFrame acquisition remap tests.
{
  /**
   * Build a non-standard RawGamepadStub whose raw HID layout is arbitrary.
   * `raw` maps a physical button index -> value (pressed = value > 0).
   * `rawAxes` is the raw physical axes array.
   */
  function nonStandardStub(overrides: {
    index?: number;
    id?: string;
    raw?: [number, number][];
    rawAxes?: number[];
    buttonCount?: number;
  }): RawGamepadStub {
    const values = new Map<number, number>(overrides.raw ?? []);
    const count = overrides.buttonCount ?? 20;
    const buttons: { value: number; pressed: boolean }[] = [];
    for (let b = 0; b < count; b++) {
      const v = values.get(b) ?? 0;
      buttons.push({ value: v, pressed: v > 0 });
    }
    return {
      index: overrides.index ?? 0,
      id: overrides.id ?? 'usb gamepad (Vendor: 0810 Product: e501)',
      connected: true,
      mapping: 'no-standard-here',
      buttons,
      axes: overrides.rawAxes ?? [0, 0, 0, 0, 0, 0],
    };
  }

  // A remap table where the SDL logical 'a' maps to raw physical button 3
  // (NOT identity), 'b' to raw button 5, and 'leftx' to raw axis 4. This
  // deliberately-permuted table proves the remap consults the DB rather
  // than passing raw indices through unchanged.
  const permutedTokens: MappingTokens = {
    a: { kind: 'button', index: 3 },
    b: { kind: 'button', index: 5 },
    leftx: { kind: 'axis', index: 4 },
    lefttrigger: { kind: 'axis', index: 5 },
  };

  describe('diffGamepadFrame remap (m3t2, D-1 option A)', () => {
    it('non-standard + remapLookup hit: standardMapping=true, raw HID remapped to standard layout', () => {
      const prev = new Map<number, GamepadSlotSample>();
      // raw button 3 pressed -> standard 'a' (index 0); raw axis 4 = 0.7 -> standard leftx (axis 0).
      const cur = [nonStandardStub({ raw: [[3, 1]], rawAxes: [0, 0, 0, 0, 0.7, 0.4] })];
      const result = diffGamepadFrame(prev, cur, () => permutedTokens);
      expect(result).toHaveLength(1);
      const slot = result[0];
      expect(slot.standardMapping).toBe(true);
      // standard button 0 ('a') reflects raw button 3 -- proves table consulted.
      expect(slot.pressed.has(0)).toBe(true);
      // raw button 0 (unmapped) must NOT leak into standard index 0 identity.
      expect(slot.pressed.has(3)).toBe(false);
      // standard axis 0 (leftx) reflects raw axis 4.
      expect(slot.axes[0]).toBeCloseTo(0.7, 5);
      // trigger mapped to an axis -> standard buttonValue at index 6 (lefttrigger).
      expect(slot.buttonValues.get(6)).toBeCloseTo(0.4, 5);
    });

    it('AC-10 falsification: a wrong remap table does NOT surface the pressed button at standard 0', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      // Wrong table: 'a' maps to raw button 9 (which is NOT pressed).
      const wrongTokens: MappingTokens = { a: { kind: 'button', index: 9 } };
      const result = diffGamepadFrame(prev, cur, () => wrongTokens);
      // Sensitivity: standard button 0 must be false because raw 9 is unpressed.
      expect(result[0].pressed.has(0)).toBe(false);
    });

    it('edge transition: frame N (no lookup) empty -> frame N+1 (DB loaded) justPressed fires', () => {
      // Frame N: remapLookup returns null (DB not yet loaded).
      const prev1 = new Map<number, GamepadSlotSample>();
      const cur1 = [nonStandardStub({ raw: [[3, 1]] })];
      const r1 = diffGamepadFrame(prev1, cur1, () => null);
      expect(r1[0].standardMapping).toBe(false);
      expect(r1[0].pressed.size).toBe(0);

      // Frame N+1: DB loaded, remap active, button 3 still held raw.
      const prev2 = new Map<number, GamepadSlotSample>();
      prev2.set(0, r1[0]);
      const cur2 = [nonStandardStub({ raw: [[3, 1]] })];
      const r2 = diffGamepadFrame(prev2, cur2, () => permutedTokens);
      expect(r2[0].standardMapping).toBe(true);
      // First frame the remap becomes active -> justPressed edge fires at standard 0.
      expect(r2[0].pressed.has(0)).toBe(true);
      expect(r2[0].justPressed.has(0)).toBe(true);
    });

    it('non-standard + remapLookup miss (returns null): Feat1 empty signal, connected=true', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]], rawAxes: [0.5, 0, 0, 0] })];
      const result = diffGamepadFrame(prev, cur, () => null);
      expect(result[0].standardMapping).toBe(false);
      expect(result[0].pressed.size).toBe(0);
      expect(result[0].buttonValues.size).toBe(0);
      expect(result[0].axes).toEqual([0, 0, 0, 0]);
    });

    it('no remapLookup arg at all: non-standard stays empty (backward compat with Feat1)', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      const result = diffGamepadFrame(prev, cur);
      expect(result[0].standardMapping).toBe(false);
      expect(result[0].pressed.size).toBe(0);
    });

    it('standard-mapping gamepad is unaffected by remapLookup (never consulted)', () => {
      const prev = new Map<number, GamepadSlotSample>();
      let consulted = false;
      const std: RawGamepadStub = {
        index: 0,
        id: 'standard pad',
        connected: true,
        mapping: 'standard',
        buttons: Array.from({ length: 17 }, (_, b) => ({ value: b === 0 ? 1 : 0, pressed: b === 0 })),
        axes: [0.1, 0.2, 0.3, 0.4],
      };
      const result = diffGamepadFrame(prev, [std], () => {
        consulted = true;
        return permutedTokens;
      });
      expect(consulted).toBe(false);
      expect(result[0].standardMapping).toBe(true);
      expect(result[0].pressed.has(0)).toBe(true);
      expect(result[0].axes[0]).toBeCloseTo(0.1, 5);
    });
  });

  describe('AC-10 snapshot-level: binding-visible remap through snap.gamepad(i)', () => {
    it('non-standard DB-hit slot reads standard button(0) true via snapshot reader', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      const slots = diffGamepadFrame(prev, cur, () => permutedTokens);
      const snap = snapshotFromSample({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
        capabilities: { gamepad: true, pointer: false },
        gamepads: slots,
      });
      const g = snap.gamepad(0);
      expect(g.connected).toBe(true);
      expect(g.standardMapping).toBe(true);
      expect(g.button(0)).toBe(true);
    });

    it('non-standard DB-miss slot reports standardMapping=false + empty via snapshot reader', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      const slots = diffGamepadFrame(prev, cur, () => null);
      const snap = snapshotFromSample({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
        capabilities: { gamepad: true, pointer: false },
        gamepads: slots,
      });
      const g = snap.gamepad(0);
      expect(g.connected).toBe(true);
      expect(g.standardMapping).toBe(false);
      expect(g.button(0)).toBe(false);
    });
  });
}
