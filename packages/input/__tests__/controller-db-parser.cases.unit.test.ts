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

// Split source block: M3 controller database parser tests.
{
  const VENDOR_DB_PATH = fileURLToPath(
    new URL('../vendor/gamecontrollerdb.txt', import.meta.url),
  );

  // A synthetic multi-entry snippet exercising: comments, blank lines, the
  // platform suffix, analog + button + hat + half-axis tokens.
  const SYNTHETIC_DB = [
    '# Game Controller DB (synthetic test fixture)',
    '',
    '# Windows',
    '030000005e0400008e02000000000000,Xbox 360 Controller,a:b0,b:b1,x:b2,y:b3,leftx:a0,lefty:a1,dpup:h0.1,platform:Windows,',
    '# Mac OS X',
    '030000005e0400008e02000000000000,Xbox 360 Controller,a:b0,b:b1,leftx:a0,platform:Mac OS X,',
    '030000004c050000c405000000000000,PS4 Controller,a:b1,b:b2,lefttrigger:a3,dpleft:+a4,platform:Windows,',
  ].join('\n');

  describe('parseControllerDb (m3t1)', () => {
    it('parses GUID keys with mapping token objects (button / axis / hat)', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const guid = '030000005e0400008e02000000000000';
      const entries = db[guid];
      expect(entries).toBeDefined();
      // Two platform variants for the Xbox 360 GUID.
      expect(entries).toHaveLength(2);
      const win = entries?.find((e) => e.platform === 'Windows');
      expect(win).toBeDefined();
      expect(win?.tokens.a).toEqual({ kind: 'button', index: 0 });
      expect(win?.tokens.b).toEqual({ kind: 'button', index: 1 });
      expect(win?.tokens.leftx).toEqual({ kind: 'axis', index: 0 });
      expect(win?.tokens.lefty).toEqual({ kind: 'axis', index: 1 });
      expect(win?.tokens.dpup).toEqual({ kind: 'hat', index: 0, mask: 1 });
    });

    it('parses half-axis tokens (+aN / -aN) with sign', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const ps4 = db['030000004c050000c405000000000000']?.[0];
      expect(ps4?.tokens.dpleft).toEqual({ kind: 'axis', index: 4, half: '+' });
      expect(ps4?.tokens.lefttrigger).toEqual({ kind: 'axis', index: 3 });
    });

    it('skips comment (#) and blank lines', () => {
      const db = parseControllerDb('# comment\n\n   \n');
      expect(Object.keys(db)).toHaveLength(0);
    });

    it('parses the real vendored gamecontrollerdb.txt with >= 2000 GUID entries', () => {
      const txt = readFileSync(VENDOR_DB_PATH, 'utf8');
      const db = parseControllerDb(txt);
      expect(Object.keys(db).length).toBeGreaterThanOrEqual(2000);
      // Spot-check a well-known entry (Xbox 360, VID 045e PID 028e).
      const xbox = db['030000005e0400008e02000000000000'];
      expect(xbox).toBeDefined();
      expect(xbox?.[0]?.tokens.a).toEqual({ kind: 'button', index: 0 });
    });
  });

  describe('buildGuidFromVidPid (m3t1, D-13 strategy 2)', () => {
    it('builds a 32-char SDL GUID with bus=03, CRC=0, version=0, driver=0', () => {
      // VID=0x045e PID=0x028e (Xbox 360) -> matches the real DB GUID.
      const guid = buildGuidFromVidPid(0x045e, 0x028e);
      expect(guid).toBe('030000005e0400008e02000000000000');
      expect(guid).toHaveLength(32);
    });

    it('builds Xbox One S BT GUID (VID=0x045e PID=0x02ea)', () => {
      const guid = buildGuidFromVidPid(0x045e, 0x02ea);
      expect(guid).toBe('030000005e040000ea02000000000000');
    });

    it('encodes VID/PID little-endian within their 16-bit fields', () => {
      // PS4 DualShock 4: VID=0x054c PID=0x05c4.
      expect(buildGuidFromVidPid(0x054c, 0x05c4)).toBe('030000004c050000c405000000000000');
    });
  });

  describe('extractGuidFromGamepadId (m3t1, cross-browser F3)', () => {
    it('Chrome format: "... (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"', () => {
      const id = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
      expect(extractGuidFromGamepadId(id)).toBe('030000004c050000cc09000000000000');
    });

    it('Firefox format: "046d-c216-Logitech Dual Action"', () => {
      expect(extractGuidFromGamepadId('046d-c216-Logitech Dual Action')).toBe(
        buildGuidFromVidPid(0x046d, 0xc216),
      );
    });

    it('Firefox format tolerates a dropped leading zero on the VID (46d-c216-...)', () => {
      expect(extractGuidFromGamepadId('46d-c216-Logicool Dual Action')).toBe(
        buildGuidFromVidPid(0x046d, 0xc216),
      );
    });

    it('Safari / name-only string returns undefined (VID/PID unextractable)', () => {
      expect(extractGuidFromGamepadId('Wireless Controller')).toBeUndefined();
    });

    it('XInput string (Chrome) returns undefined (no VID/PID present)', () => {
      expect(
        extractGuidFromGamepadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)'),
      ).toBeUndefined();
    });

    it('XInput string (Firefox literal "xinput") returns undefined', () => {
      expect(extractGuidFromGamepadId('xinput')).toBeUndefined();
    });
  });

  describe('platformFromUserAgent (m3t1, D-13)', () => {
    it('detects Windows / Mac OS X / Linux / Android / iOS', () => {
      expect(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
      expect(platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
        'Mac OS X',
      );
      expect(platformFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux');
      expect(platformFromUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7)')).toBe('Android');
      expect(platformFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)')).toBe(
        'iOS',
      );
    });

    it('returns undefined for an unrecognised user agent', () => {
      expect(platformFromUserAgent('SomeRandomBot/1.0')).toBeUndefined();
    });
  });

  describe('selectBestMappingEntry (m3t1, platform section preference)', () => {
    it('prefers the platform-matching entry when present', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const guid = '030000005e0400008e02000000000000';
      const mac = selectBestMappingEntry(db, guid, 'Mac OS X');
      expect(mac?.platform).toBe('Mac OS X');
    });

    it('falls back to any entry when the platform does not match', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const guid = '030000005e0400008e02000000000000';
      const linux = selectBestMappingEntry(db, guid, 'Linux');
      expect(linux).toBeDefined();
      // Falls back to the first available (Windows or Mac OS X entry).
      expect(['Windows', 'Mac OS X']).toContain(linux?.platform);
    });

    it('returns undefined when the GUID is not in the DB', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      expect(selectBestMappingEntry(db, 'ffffffffffffffffffffffffffffffff', 'Windows')).toBeUndefined();
    });
  });
}
