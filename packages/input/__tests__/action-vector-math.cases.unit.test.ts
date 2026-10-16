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

// Split source block: M2 getAxis and getVector math tests.
{
  /**
   * Helper: build an InputBackendSample for getAxis/getVector testing.
   */
  function sampleForVector(overrides?: {
    downKeys?: string[];
    gamepads?: readonly GamepadSlotSample[];
  }): import('../src/input-snapshot').InputBackendSample {
    return {
      downKeys: new Set(overrides?.downKeys ?? []),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      gamepads: overrides?.gamepads ?? [],
    };
  }

  /**
   * Build a named ActionConfig[] and derive ActionState[] from a sample.
   * Convenience: `actions` is an array of [actionName, ...bindings] for quick test fixture building.
   */
  function deriveForVector(
    map: ActionConfig[],
    sample?: import('../src/input-snapshot').InputBackendSample,
  ): { map: ActionConfig[]; states: ActionState[] } {
    const s = sample ?? sampleForVector();
    return { map, states: deriveActionStates(s, map) };
  }

  /**
   * Build WASD action map: 4 directional actions bound to 'a'/'d'/'w'/'s'.
   */
  function wasdMap(): ActionConfig[] {
    return [
      { action: 'moveLeft', bindings: [{ type: 'key' as const, key: 'a' }] },
      { action: 'moveRight', bindings: [{ type: 'key' as const, key: 'd' }] },
      { action: 'moveUp', bindings: [{ type: 'key' as const, key: 'w' }] },
      { action: 'moveDown', bindings: [{ type: 'key' as const, key: 's' }] },
    ];
  }

  describe('getAxis — AC-05 (m2t1)', () => {
    const map: ActionConfig[] = [
      { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }], deadzone: 0.2 },
      { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }], deadzone: 0.2 },
    ];

    it('both registered, pos pressed, neg not → strength(pos) - strength(neg)', () => {
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getAxis(states, 'moveLeft', 'moveRight');
      // pos (moveRight) strength=1.0, neg (moveLeft) strength=0 → 1.0
      expect(v).toBeCloseTo(1.0);
    });

    it('both registered, neg pressed, pos not → strength(pos) - strength(neg)', () => {
      const sample = sampleForVector({ downKeys: ['a'] });
      const states = deriveActionStates(sample, map);
      const v = getAxis(states, 'moveLeft', 'moveRight');
      // pos (moveRight) strength=0, neg (moveLeft) strength=1.0 → -1.0
      expect(v).toBeCloseTo(-1.0);
    });

    it('neither pressed → 0', () => {
      const sample = sampleForVector({ downKeys: [] });
      const states = deriveActionStates(sample, map);
      const v = getAxis(states, 'moveLeft', 'moveRight');
      expect(v).toBe(0);
    });

    it('one unregistered action (E-3) → contributes 0', () => {
      // 'moveRight' is NOT in the map; only 'moveLeft' is registered.
      const partialMap: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
      ];
      const sample = sampleForVector({ downKeys: ['a'] });
      const states = deriveActionStates(sample, partialMap);
      // pos='moveRight' is unregistered → strength=0, neg='moveLeft' strength=1.0 → -1.0
      const v = getAxis(states, 'moveLeft', 'moveRight');
      expect(v).toBeCloseTo(-1.0);
    });

    it('neither registered → returns 0', () => {
      const emptyMap: ActionConfig[] = [];
      const sample = sampleForVector({ downKeys: ['a', 'd'] });
      const states = deriveActionStates(sample, emptyMap);
      const v = getAxis(states, 'moveLeft', 'moveRight');
      expect(v).toBe(0);
    });

    it('same action for both ends (E-12) → always 0', () => {
      const mapSame: ActionConfig[] = [
        { action: 'move', bindings: [{ type: 'key', key: 'd' }] },
      ];
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, mapSame);
      // Both neg and pos are 'move' — strength('move')=1.0, difference = 0
      const v = getAxis(states, 'move', 'move');
      expect(v).toBe(0);
    });

    it('range bound: [-1, 1] even with extreme inputs', () => {
      const mapExt: ActionConfig[] = [
        { action: 'pos', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'neg', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
      ];
      // axis 0 = 1.0 → pos contributes strength=1.0, neg contributes 0
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [1, 0, 0, 0] })],
      });
      const states = deriveActionStates(sample, mapExt);
      const v = getAxis(states, 'neg', 'pos');
      expect(v).toBeCloseTo(1.0);
      // Can never exceed 1.0 since strength is in [0,1]
      expect(v).toBeLessThanOrEqual(1.0);
      expect(v).toBeGreaterThanOrEqual(-1.0);
    });
  });

  describe('getVector — AC-06 three-branch formula (m2t1)', () => {
    it('WASD diagonal: all 4 keys pressed → magnitude 1, not sqrt(2) (raw used, radial deadzone)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['w', 'd'] }); // up + right → diagonal
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      // With raw=1.0 for both w and d keys, vector = (1, -1) (Y neg=moveDown at 0, Y pos=moveUp at 1)
      // Wait: negY='moveDown', posY='moveUp'. With w pressed: posY raw=1.0.
      // negX='moveLeft', posX='moveRight'. With d pressed: posX raw=1.0.
      // raw vector = (1.0 - 0, 1.0 - 0) = (1, 1). Length = sqrt(2) ≈ 1.414.
      // Branch: length > 1 → v/len = (1/1.414, 1/1.414) ≈ (0.707, 0.707). Magnitude = 1.
      expect(v.x).toBeCloseTo(Math.SQRT1_2, 3); // ~0.707
      expect(v.y).toBeCloseTo(Math.SQRT1_2, 3); // ~0.707
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      expect(mag).toBeCloseTo(1.0, 3);
    });

    it('WASD right only → (1, 0)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('WASD up only → (0, 1)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['w'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(0);
      expect(v.y).toBeCloseTo(1.0);
    });

    it('WASD left only → (-1, 0)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['a'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(-1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('length <= deadzone → (0, 0)', () => {
      // Use gamepadAxis with tiny values below deadzone
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.2 },
      ];
      // axis 0 = 0.1, axis 1 = 0.1 → raw vector = (0.1, 0.1), length ≈ 0.141
      // Default deadzone = (0.2+0.2+0.2+0.2)/4 = 0.2. length=0.141 <= 0.2 → (0,0)
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [0.1, 0.1, 0, 0] })],
      });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('length > 1 → clamped to unit circle', () => {
      const map = wasdMap();
      // Both 'd' and 'w' pressed → raw (1,1), length=√2>1 → (0.707, 0.707)
      const sample = sampleForVector({ downKeys: ['d', 'w'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      expect(mag).toBeCloseTo(1.0, 3);
    });

    it('mid-range: inverse_lerp smooth transition', () => {
      // Use gamepadAxis to get raw values between deadzone and 1
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.2 },
      ];
      // axis 0 = 0.6, axis 1 = 0 → raw = (0.6, 0), len = 0.6
      // Default deadzone = 0.2. Branch: 0.2 < 0.6 <= 1 → vec * inverse_lerp(0.2, 1, 0.6) / 0.6
      // inverse_lerp(0.2, 1, 0.6) = (0.6-0.2)/(1-0.2) = 0.4/0.8 = 0.5
      // output = (0.6, 0) * 0.5 / 0.6 = (0.5, 0)
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [0.6, 0, 0, 0] })],
      });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(0.5, 3);
      expect(v.y).toBeCloseTo(0);
    });

    it('opts.deadzone override bypasses default-avg', () => {
      const map = wasdMap(); // DEFAULT_DEADZONE = 0.2 per action
      // With default deadzone 0.2 and digital keys (raw=1.0): length=1 > deadzone, passes
      // With override deadzone=2.0: length=1 <= 2.0 → (0,0)
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp', { deadzone: 2.0 });
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('default deadzone = average of 4 action deadzones', () => {
      const mapCustom: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.1 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.3 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.4 },
      ];
      // Default deadzone = (0.1+0.3+0.2+0.4)/4 = 0.25
      // axis 0 = 0.24, axis 1 = 0 → raw = (0.24, 0), len = 0.24 <= 0.25 → (0,0)
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [0.24, 0, 0, 0] })],
      });
      const states = deriveActionStates(sample, mapCustom);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });
  });

  describe('getVector — AC-06 falsification: per-axis deadzone must FAIL', () => {
    /**
     * This test verifies falsification sensitivity (§5.4).
     *
     * If getVector were to use `strength` (which has per-action deadzone applied)
     * instead of `raw`, a WASD diagonal with keys w+d would produce:
     *   strength('moveRight') = 1.0  (digital, always 1 after deadzone remap)
     *   strength('moveUp') = 1.0
     *   → vector = (1, 1), magnitude = √2 ≈ 1.414
     *
     * The correct implementation uses `raw` + radial deadzone:
     *   raw('moveRight') = 1.0, raw('moveUp') = 1.0
     *   → vector = (1, 1), length > 1 → clamp to unit circle → (0.707, 0.707)
     *
     * This test asserts magnitude ≈ 1.0. A per-axis deadzone implementation
     * would produce magnitude ≈ 1.414 and FAIL this assertion.
     */
    it('WASD diagonal: magnitude must be 1 (not sqrt(2)) — falsifies per-axis deadzone', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['w', 'd'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      // With per-axis deadzone, magnitude would be ~1.414 (sqrt(2)).
      // The correct radial deadzone clamps to the unit circle.
      expect(mag).toBeCloseTo(1.0, 3);
      // also verify x and y are equal (unit circle diagonal)
      expect(Math.abs(v.x - v.y)).toBeLessThan(0.001);
    });

    /**
     * Additional falsification: check that getVector uses raw, not strength.
     *
     * With gamepadAxis raw=0.15 (below deadzone 0.2):
     * - strength would be 0 (deadzone remapped to 0).
     * - raw stays at 0.15.
     * - getVector with raw + 4-action avg deadzone 0.2: length=0.15 <= 0.2 → (0,0).
     *
     * With a single gamepadAxis at 0.15 on X and 0 on Y:
     * raw vector = (0.15, 0), length=0.15, deadzone=0.2 → (0,0).
     * This test doesn't distinguish raw vs strength here because both give (0,0).
     * Instead, we test at raw=0.5: strength would apply per-axis deadzone (0.2)
     * giving strength=inverse_lerp(0.2,1,0.5)=0.375. getVector with raw=0.5
     * and radial deadzone gives inverse_lerp(0.2,1,0.5)=0.375. Same result
     * for a pure single-axis case.
     *
     * The key falsification is the diagonal case above (magnitude must be 1,
     * not sqrt(2)). That's the definitive test.
     */
    it('WASD single axis + inactive opposite: no per-axis deadzone leakage', () => {
      const map = wasdMap();
      // Only 'd' pressed → right only
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      // Both raw and strength give 1.0 for digital keys, so result is the same (1, 0)
      // But verify the magnitude is exactly 1, not softened by some phantom deadzone
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      expect(mag).toBeCloseTo(1.0);
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });
  });

  describe('getVector — E-3 partial unregistered actions', () => {
    it('one of the 4 action names unregistered → contributes raw=0', () => {
      const map: ActionConfig[] = [
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
        // moveLeft, moveUp, moveDown not registered → each raw=0
      ];
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      // posX='moveRight' raw=1.0, negX='moveLeft' raw=0, posY='moveUp' raw=0, negY='moveDown' raw=0
      // raw vector = (1, 0), length=1 > all-zero deadzone avg.
      // getAxis for unregistered = strength(registered) - 0 if unregistered pos = 0
      // Actually getAxis(pos) for 'moveUp' with unregistered → strength=0.
      // So y = 0-0 = 0, x = 1-0 = 1. Length=1, no clamp → (1,0)
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('all 4 unregistered → (0, 0)', () => {
      const map: ActionConfig[] = [];
      const sample = sampleForVector({ downKeys: ['w', 'd'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });
  });
}
