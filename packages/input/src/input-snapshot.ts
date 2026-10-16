// input-snapshot.ts -- frozen frame-start input snapshot Resource for
// forgeax-engine. Multi-device surface (keyboard + mouse + gamepad + pointer +
// virtualAxis) — each cluster is a frozen reader on the per-frame Sample.
//
// charter awareness:
//   F1 single-entry indexability -- barrel exports all types; IDE autocomplete
//     reaches the full surface from one import
//   F2 minimal surface -- each device cluster exposes only its natural
//     readpoints; no phantom methods or modal parameters
//   P3 explicit failure -- no thrown errors from accessor methods; absent
//     keys / pre-start state / disconnected slots / unsupported devices
//     all report `false` / `0` / zero-vector (the empty signal IS the
//     signal). `mouse.button(i)` / `gamepad.button(b)` parameters are
//     literal unions so out-of-range indices are TS compile errors rather
//     than runtime bounds-clamps.
//   P4 consistent abstraction -- the snapshot hides the producer
//     (browser listener wiring + gamepad polling) entirely; consumers read
//     via the `InputSnapshot` Resource regardless of backend
//   P5 producer/consumer split -- the InputBackend protocol decouples
//     the producer from the snapshot; `frame-start-scan-system.ts` is the
//     bridge that calls `backend.sample()` and writes the Resource

import type { ActionState, GetVectorOptions } from './action-state';
import { getAxis, getVector } from './action-state';
import type { GestureEvent, GestureState } from './gesture-recognizer';
import { IDENTITY_GESTURE } from './gesture-recognizer';

// D-5 / AC-19: pointerType is narrowed from string to a 3-literal union.
// The W3C Pointer Events spec allows '' when the device type cannot be
// detected; coercion maps '' to 'mouse' at the producer, so the snapshot
// only ever sees one of these three canonical values.
export type PointerType = 'mouse' | 'pen' | 'touch';

/** Standard-layout gamepad button index (0-16 per W3C Gamepad spec). */
export type GamepadButtonIndex =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16;

/** Standard-layout gamepad axis index (0-3 per W3C Gamepad spec). */
import type {
  GamepadFeedback,
  GamepadFeedbackIntent,
  GamepadFeedbackResult,
  GamepadFeedbackTarget,
} from './gamepad-feedback';

export type GamepadAxisIndex = 0 | 1 | 2 | 3;

/** W3C MouseEvent.button index (0=primary, 1=auxiliary, 2=secondary). */
export type MouseButtonIndex = 0 | 1 | 2;

/** Per-slot gamepad frame data produced by `sample()`. */
export interface GamepadSlotSample {
  readonly feedbackTarget?: GamepadFeedbackTarget;
  readonly dualRumble?: boolean;
  readonly index: number;
  /**
   * True when the browser reports a standard mapping OR the SDL controller
   * DB has normalized a non-standard layout at the acquisition layer (M3
   * D-1 redefinition). The Feat1 meaning ("browser-reported standard
   * mapping only") is widened here: a non-standard pad whose GUID matches
   * gamecontrollerdb.txt is re-projected onto the standard layout and
   * reported as standardMapping=true, so bindings and direct reads see a
   * uniform standard button/axis space. A non-standard pad with no DB match
   * (or before the DB has loaded) keeps standardMapping=false + empty
   * readpoints (graceful degradation).
   */
  readonly standardMapping: boolean;
  readonly pressed: ReadonlySet<number>;
  readonly justPressed: ReadonlySet<number>;
  readonly justReleased: ReadonlySet<number>;
  readonly buttonValues: ReadonlyMap<number, number>;
  readonly axes: readonly [number, number, number, number];
}

/** Per-pointer live state (active contacts tracked by pointerId).
 *
 * D-5 / E-10: `pointerType` is a 3-literal union. `'mouse'` is the default
 * placeholder for inactive pointers — when `active=false`, `pointerType` is
 * always `'mouse'`. The semantic "no pointer" is carried by the `active`
 * field, never by a sentinel string value.
 */
export interface PointerSample {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
  readonly pointerType: PointerType;
  readonly active: boolean;
  readonly delta: { readonly x: number; readonly y: number };
}

/** Per-frame phase event (down/move/up/cancel queue, one-frame lifecycle). */
export interface PointerPhaseEvent {
  readonly pointerId: number;
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
  readonly pointerType: PointerType;
}

/** Per-frame virtual axis output (named joystick derived from pointer input). */
export interface VirtualAxisSample {
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/**
 * Configuration for an on-screen virtual joystick (M3). Consumed by
 * attachBrowserInputBackend and passed through to deriveVirtualAxes.
 *
 * Fixed mode: origin is config.anchor (or region center if anchor omitted).
 * Floating mode: origin is the first pointerdown position within the region.
 */
export interface VirtualJoystickConfig {
  readonly name: string;
  readonly mode: 'fixed' | 'floating';
  /** Canvas-pixel region where touches are eligible to bind this joystick. */
  readonly region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Fixed-mode origin anchor. Defaults to region center when omitted. */
  readonly anchor?: { readonly x: number; readonly y: number } | undefined;
  /** Max drag radius in canvas pixels. Vector is clamped then normalized to radius. */
  readonly radius: number;
  /** Normalized deadzone (0..1). |vec| < deadzone → zero vector output. */
  readonly deadzone: number;
}

/** Capability snapshot (frozen at backend attach time). */
export interface Capabilities {
  readonly gamepad: boolean;
  readonly pointer: boolean;
}

/**
 * Frozen value-shape view exposed to user systems via the `InputSnapshot`
 * Resource. The methods are pure reads; calling them does not mutate any
 * accumulator (charter P3 -- no observable side effects from the accessor
 * surface). A fresh `InputSnapshot` instance is constructed by the
 * frame-start scan system once per `world.update()` and replaces the
 * previous Resource value.
 */
export interface InputSnapshot {
  /** Keyboard view (held state plus frame edges). */
  readonly keyboard: {
    /**
     * `true` while `key` is currently held. `key` matches the value the
     * backend records (KeyboardEvent.key for the browser backend). When
     * the key is not in the held set, returns `false` -- never throws
     * (charter P3: empty signal is the signal).
     */
    down(key: string): boolean;
    /** `true` for the first frame in which `key` becomes held. */
    justPressed(key: string): boolean;
    /**
     * `true` for one frame after the key was released (the up-edge). The
     * edge collapses on the following `world.update()`. `key` not in the
     * up-edge set returns `false`.
     */
    up(key: string): boolean;
    /** Code-key equivalent of `down`, using KeyboardEvent.code identity. */
    downCode(code: string): boolean;
    /** Code-key equivalent of `justPressed`. */
    justPressedCode(code: string): boolean;
    /** Code-key equivalent of `up`. */
    upCode(code: string): boolean;
  };
  /** Mouse view (charter F2 minimal surface: position + movementDelta + button + wheelDelta). */
  readonly mouse: {
    /**
     * Latest canvas-pixel cursor position. This is available during hover;
     * it does not require a button press or pointer capture. The position is
     * frozen with the rest of the frame-start snapshot.
     */
    readonly position: { readonly x: number; readonly y: number } | undefined;
    /**
     * PointerLock-style accumulated movement since the previous frame.
     * Value is frozen at frame-start; reading it does not clear the
     * accumulator. The next `world.update()` produces a fresh delta
     * (zero if no movement events arrived).
     */
    readonly movementDelta: { readonly x: number; readonly y: number };
    /**
     * Merged pointer-lock state: true when either W3C pointer-lock
     * (pointerLockElement === this backend's canvas) OR the lockProvider
     * path has engaged. Consumers read this to decide whether to consume
     * movementDelta for look/camera rotation. Required field, alongside
     * movementDelta -- both facts sit at the same attribute path for
     * single-point indexing (charter F1).
     */
    readonly pointerLocked: boolean;
    /**
     * `true` while the W3C MouseEvent.button slot `i` is held. `i` is
     * narrowed to the literal `0 | 1 | 2` so out-of-range indices are
     * rejected at compile time (charter P3 explicit failure: TS literal
     * narrowing replaces a runtime bounds-clamp).
     *
     * - 0 -- primary button (left)
     * - 1 -- auxiliary button (middle)
     * - 2 -- secondary button (right)
     */
    button(i: MouseButtonIndex): boolean;
    /** `true` for the first frame in which button `i` becomes held. */
    justPressed(i: MouseButtonIndex): boolean;
    /** `true` for the frame in which button `i` is released. */
    justReleased(i: MouseButtonIndex): boolean;
    /**
     * Discrete wheel notches accumulated since the previous frame.
     * Plan-strategy D-5 sign-discrete: each `WheelEvent` contributes
     * `Math.sign(event.deltaY)` to the per-frame accumulator regardless
     * of `deltaMode` (PIXEL / LINE / PAGE all collapse). Sign convention
     * follows W3C `WheelEvent.deltaY`: positive = scroll down / away
     * from user, negative = scroll up / toward user.
     *
     * Value is frozen at frame-start; reading it does not clear the
     * accumulator. The next `world.update()` produces a fresh delta
     * (zero when no wheel events arrived).
     *
     * Trade-off (plan-strategy R-7): trackpad high-resolution wheel
     * events collapse to one notch per event, losing sub-notch fidelity.
     * AI users who need analog magnitude must opt in via a future
     * unitful surface (OOS-7 ScrollSnapshot is the deferred shape).
     */
    readonly wheelDelta: number;
  };
  /**
   * Per-slot gamepad reader. Returns a reader object for the gamepad at
   * slot `i` regardless of connection state: disconnected or out-of-range
   * slots report `connected=false`, all button/axis readpoints return
   * `false`/`0` (charter P3 empty signal). The slot index is intentionally
   * not narrowed — platform slot counts vary, and bounds handling is a
   * runtime concern.
   */
  gamepad(i: number): {
    readonly feedbackTarget: GamepadFeedbackTarget | undefined;
    readonly dualRumble: boolean;
    readonly connected: boolean;
    readonly standardMapping: boolean;
    button(b: GamepadButtonIndex): boolean;
    buttonValue(b: GamepadButtonIndex): number;
    justPressed(b: GamepadButtonIndex): boolean;
    justReleased(b: GamepadButtonIndex): boolean;
    axis(a: GamepadAxisIndex): number;
  };
  /**
   * Frozen capabilities snapshot, determined once at backend attach time.
   * Consumers use this to decide whether gamepad/pointer readpoints will
   * ever carry live data, without probing per-frame.
   */
  readonly capabilities: Capabilities;
  /**
   * Per-pointerId reader. Returns `{ active: true/false, x, y, pressure,
   * pointerType, delta }` for the given pointerId. Unknown pointerIds
   * return `{ active: false, ... }` without throwing.
   */
  pointer(
    id: number,
  ): PointerSample & { readonly delta: { readonly x: number; readonly y: number } };
  /**
   * Named virtual axis reader (joystick-derived). Returns `{ x, y }` for
   * the given joystick config name. Unknown names return the zero-vector
   * `{ x: 0, y: 0 }` without throwing.
   */
  virtualAxis(name: string): { readonly x: number; readonly y: number };
  /**
   * Per-frame phase event queue (down/move/up/cancel). One-frame
   * lifecycle; drained by `sample()` at frame end. Empty array when no
   * pointer events occurred this frame.
   */
  readonly pointerEvents: readonly PointerPhaseEvent[];
  /**
   * Continuous gesture values (pinch scale + rotation angle) for the
   * active dual-finger gesture. Returns the identity empty signal
   * (`pinchScale=1`, `rotationAngle=0`) when no gesture is active (AC-12);
   * an active gesture retains its value on idle frames (fingers held still
   * are not a gesture end). AC-11: reading the same frame's snapshot twice
   * returns the identical object.
   */
  readonly gesture: GestureState;
  /**
   * Per-frame gesture lifecycle + instantaneous event queue (begin / end /
   * cancel / swipe / long-press / double-tap). One-frame lifecycle, same
   * pattern as `pointerEvents` (charter P4). Empty array when no gesture
   * activity occurred this frame. Closed discriminant union (AC-13): a
   * consumer exhaustively switches on `kind` without a default branch.
   */
  readonly gestureEvents: readonly GestureEvent[];
  /**
   * Action mapping readpoint. Returns a frozen reader for the named action.
   * When `name` is registered in the InputMap, `isPressed()` / `justPressed()`
   * / `justReleased()` / `strength` reflect the derived state. Unregistered
   * action names return empty signal (false / 0 / false / false / 0) without
   * throwing (charter P3: empty signal is the signal). AC-11: calling
   * action() multiple times in the same frame returns identical values.
   */
  action(name: string): {
    readonly isPressed: () => boolean;
    readonly justPressed: () => boolean;
    readonly justReleased: () => boolean;
    readonly strength: number;
  };
  /**
   * Compose a 1D axis value from two opposing actions.
   *
   * Returns `strength(pos) - strength(neg)`, range [-1, 1].
   * Both registered: combines normally. One unregistered: contributes 0
   * (E-3). Same action for both ends: always 0 (E-12).
   *
   * @param neg - Action name for the negative direction (e.g. 'moveLeft').
   * @param pos - Action name for the positive direction (e.g. 'moveRight').
   */
  getAxis(neg: string, pos: string): number;
  /**
   * Compose a 2D vector from four directional actions with a single radial
   * deadzone (Godot input.cpp three-branch formula). Uses `raw` (not
   * `strength`) to avoid per-axis deadzone stacking into a square deadzone
   * (AC-06).
   *
   * @param negX - Action name for negative X (e.g. 'moveLeft').
   * @param posX - Action name for positive X (e.g. 'moveRight').
   * @param negY - Action name for negative Y (e.g. 'moveUp').
   * @param posY - Action name for positive Y (e.g. 'moveDown').
   * @param opts - Optional override (deadzone).
   */
  getVector(
    negX: string,
    posX: string,
    negY: string,
    posY: string,
    opts?: GetVectorOptions,
  ): { readonly x: number; readonly y: number };
}

/**
 * Backend protocol consumed by the frame-start scan system. The browser
 * implementation (`browser-backend.ts`) is the production producer;
 * tests inject fakes that emit synthetic samples.
 */
export interface InputBackend {
  readonly feedback?: GamepadFeedback;
  dispatchFeedback?(intents: readonly GamepadFeedbackIntent[]): void;
  /**
   * Produce one frame's worth of input data and reset the per-frame
   * accumulators (movement delta + edge sets). Held-key state and
   * held-button state survive across calls. Browser producers latch edge
   * transitions when events arrive, so a down+up sequence between two scans
   * remains observable instead of being lost to the held-state projection.
   *
   * Contract notes:
   * - `downKeys` is the held-key set as of the call (held across frames)
   * - `upKeys` is the release-edge set since the previous sample (cleared
   *   after the call so the edge appears in exactly one frame)
   * - `buttons` is the held-button slot tuple `[b0, b1, b2]`
   * - `movementX` / `movementY` are the accumulated PointerLock delta
   *   since the previous sample (cleared after the call)
   * - `focused` mirrors `document.hasFocus()` so the scan system can
   *   suppress spurious up-edges across alt-tab transitions
   */
  sample(): InputBackendSample;
  /**
   * Command-set game gate for pointer-lock. When set to `false`, the
   * backend will not request pointer-lock on click AND will immediately
   * release any currently active lock (W3C path: `exitPointerLock`;
   * provider path: `exitLock()`). When `true` (default), pointer-lock
   * can be requested through the normal gate logic.
   *
   * Optional -- backends without pointer-lock support omit this method.
   */
  setPointerLockAllowed?(allowed: boolean): void;
  /**
   * Gate physical/synthetic acquisition for a host lifecycle boundary. A
   * closed gate clears producer state and makes subsequent samples empty until
   * the gate is reopened; it is independent of pointer-lock policy.
   */
  setInputAllowed?(allowed: boolean): void;
  /**
   * Atomically discard acquired state without detaching listeners. A host calls
   * this when it revokes a control lease so held keys/buttons, contacts, frame
   * edges, deltas and pointer lock cannot bleed into a later consumer. Optional
   * keeps synthetic backends source-compatible.
   */
  clear?(): void;
  /** Detach DOM listeners; called when the engine shuts down. */
  detach(): void;
}

/** Snapshot value returned by `InputBackend.sample()` (POD). */
export interface InputBackendSample {
  readonly feedbackResults?: readonly GamepadFeedbackResult[];
  readonly feedbackLostResults?: number;
  readonly downKeys: ReadonlySet<string>;
  readonly upKeys: ReadonlySet<string>;
  /** Physical code identity (KeyboardEvent.code), when the producer has it. */
  readonly downCodes?: ReadonlySet<string>;
  /** One-frame physical code release edges, when the producer has them. */
  readonly upCodes?: ReadonlySet<string>;
  /** Logical key press edges latched since the previous frame-start scan. */
  readonly pressedKeys?: ReadonlySet<string>;
  /** Physical code press edges latched since the previous frame-start scan. */
  readonly pressedCodes?: ReadonlySet<string>;
  readonly buttons: readonly [boolean, boolean, boolean];
  /** Mouse button press edges latched since the previous frame-start scan. */
  readonly pressedButtons?: readonly [boolean, boolean, boolean];
  /** Mouse button release edges latched since the previous frame-start scan. */
  readonly releasedButtons?: readonly [boolean, boolean, boolean];
  readonly movementX: number;
  readonly movementY: number;
  /** Latest canvas-pixel mouse position; absent for non-pointer backends. */
  readonly mouseX?: number;
  readonly mouseY?: number;
  /**
   * Sign-discrete wheel notch accumulator since the previous sample
   * (plan-strategy D-5). Browser backend writes `Math.sign(deltaY)` per
   * `WheelEvent`; sample() drains the value and resets the producer
   * accumulator (mirrors movementX/Y semantics).
   */
  readonly wheelDelta: number;
  /** True for the first sample after blur/hidden state reset. */
  readonly focusReset?: boolean;
  readonly focused: boolean;
  /** M1+ gamepad per-slot frame data (optional — absent when backend lacks gamepad support). */
  readonly gamepads?: readonly GamepadSlotSample[];
  /** M1+ frozen capability snapshot (optional — absent for pre-M1 backends). */
  readonly capabilities?: Capabilities;
  /** M2+ active pointer contacts (optional — absent for keyboard-only backends). */
  readonly pointers?: readonly PointerSample[];
  /** M2+ per-frame phase event queue (optional — absent when no pointer events occurred). */
  readonly pointerEvents?: readonly PointerPhaseEvent[];
  /** M3+ virtual joystick axis outputs (optional — absent when no virtual joysticks configured). */
  readonly virtualAxes?: readonly VirtualAxisSample[];
  /** M5+ continuous gesture values (optional — absent when no gesture is active). */
  readonly gestures?: GestureState;
  /** M5+ per-frame gesture event queue (optional — absent when no gesture activity occurred). */
  readonly gestureEvents?: readonly GestureEvent[];
  /**
   * Merged pointer-lock state: true when either W3C pointer-lock is active
   * (pointerLockElement === this backend's canvas) OR the lockProvider path
   * has engaged (requestLock() was called and not yet released). Required
   * field -- always present, defaults to false when no lock is active.
   */
  readonly pointerLocked: boolean;
}

/** Build the neutral backend sample used before or outside an active consumer. */
export function createEmptyInputBackendSample(): InputBackendSample {
  return {
    downKeys: new Set<string>(),
    upKeys: new Set<string>(),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
  };
}

/**
 * Build an `InputSnapshot` from a backend sample. The returned object is
 * frozen on construction: `down/up/button` are bound to the closed-over
 * sets, and `movementDelta` is a frozen literal. Subsequent backend
 * activity does not bleed into the snapshot.
 */
function buildGamepadReader(
  slot: GamepadSlotSample | undefined,
): ReturnType<InputSnapshot['gamepad']> {
  const standard = slot?.standardMapping === true;
  return Object.freeze({
    feedbackTarget: slot?.feedbackTarget,
    dualRumble: slot?.dualRumble ?? false,
    connected: slot !== undefined,
    standardMapping: standard,
    button(b: GamepadButtonIndex): boolean {
      return standard && slot.pressed.has(b);
    },
    buttonValue(b: GamepadButtonIndex): number {
      return standard ? (slot.buttonValues.get(b) ?? 0) : 0;
    },
    justPressed(b: GamepadButtonIndex): boolean {
      return standard && slot.justPressed.has(b);
    },
    justReleased(b: GamepadButtonIndex): boolean {
      return standard && slot.justReleased.has(b);
    },
    axis(a: GamepadAxisIndex): number {
      return standard ? slot.axes[a] : 0;
    },
  });
}

/**
 * Build an `InputSnapshot` from a backend sample.
 *
 * @param sample - One frame's raw input backend sample (POD).
 * @param actionStates - Optional per-frame derived action states from
 *   deriveActionStates(). When provided, snap.action(name) returns mapped
 *   values; when absent or empty, all action readpoints return empty signal
 *   (charter P3: false/0, never throws). AC-11: actionStates is frozen into
 *   the snapshot so same-frame re-reads return identical values.
 */
export function snapshotFromSample(
  sample: InputBackendSample,
  actionStates?: readonly ActionState[],
  previousSnapshot?: InputSnapshot,
): InputSnapshot {
  // structuralCopy: copying into local sets isolates the snapshot from
  // any later backend mutation (the browser backend reuses its internal
  // Set across frames). architecture-principles #2 derive: a Snapshot is
  // a derived view of the producer's state at one instant.
  const heldKeys = new Set<string>(sample.downKeys);
  const upEdges = new Set<string>(sample.upKeys);
  // Do not capture previousSnapshot in a callback: V8 can share that
  // context with the returned readers and retain the entire frame history.
  const justPressedKeys = new Set<string>(sample.pressedKeys);
  if (sample.pressedKeys === undefined) {
    for (const key of heldKeys) {
      if (!previousSnapshot?.keyboard.down(key)) justPressedKeys.add(key);
    }
  }
  const heldCodes = new Set<string>(sample.downCodes ?? []);
  const upCodeEdges = new Set<string>(sample.upCodes ?? []);
  const justPressedCodes = new Set<string>(sample.pressedCodes);
  if (sample.pressedCodes === undefined) {
    for (const code of heldCodes) {
      if (!previousSnapshot?.keyboard.downCode(code)) justPressedCodes.add(code);
    }
  }
  const buttons: readonly [boolean, boolean, boolean] = [
    sample.buttons[0],
    sample.buttons[1],
    sample.buttons[2],
  ];
  const justPressedButtons: readonly [boolean, boolean, boolean] =
    sample.pressedButtons === undefined
      ? [
          buttons[0] && (previousSnapshot === undefined || !previousSnapshot.mouse.button(0)),
          buttons[1] && (previousSnapshot === undefined || !previousSnapshot.mouse.button(1)),
          buttons[2] && (previousSnapshot === undefined || !previousSnapshot.mouse.button(2)),
        ]
      : [sample.pressedButtons[0], sample.pressedButtons[1], sample.pressedButtons[2]];
  const justReleasedButtons: readonly [boolean, boolean, boolean] =
    sample.releasedButtons === undefined
      ? [
          sample.focusReset !== true && previousSnapshot?.mouse.button(0) === true && !buttons[0],
          sample.focusReset !== true && previousSnapshot?.mouse.button(1) === true && !buttons[1],
          sample.focusReset !== true && previousSnapshot?.mouse.button(2) === true && !buttons[2],
        ]
      : [sample.releasedButtons[0], sample.releasedButtons[1], sample.releasedButtons[2]];
  const movementDelta = Object.freeze({ x: sample.movementX, y: sample.movementY });
  const mousePosition =
    sample.mouseX === undefined || sample.mouseY === undefined
      ? undefined
      : Object.freeze({ x: sample.mouseX, y: sample.mouseY });
  const wheelDelta = sample.wheelDelta;

  // D-9: use `??` empty-signal defaults for all new optional fields.
  const gamepadSlots: readonly GamepadSlotSample[] = sample.gamepads ?? [];
  const caps: Capabilities =
    sample.capabilities ?? Object.freeze({ gamepad: false, pointer: false });
  const pointerEvts: readonly PointerPhaseEvent[] = sample.pointerEvents ?? [];
  // D-4 / AC-12: no active gesture -> identity empty signal; gesture events
  // default to an empty one-frame queue (mirrors pointerEvents).
  const gesture: GestureState = sample.gestures ?? IDENTITY_GESTURE;
  const gestureEvts: readonly GestureEvent[] = sample.gestureEvents ?? [];
  // virtualAxes: consumed by M3 virtualAxis reader; stored as local for
  // the snapshot closure below.
  const _virtualAxes: readonly VirtualAxisSample[] = sample.virtualAxes ?? [];

  const virtualAxesMap = new Map<string, VirtualAxisSample>();
  for (const va of _virtualAxes) {
    virtualAxesMap.set(va.name, va);
  }

  // Build index→slot map so gamepad(i) looks up by slot.index, not array position.
  // The browser getGamepads() returns null-padded arrays where position IS the
  // index, but the diffGamepadFrame output is a sparse list keyed by .index.
  const gamepadSlotMap = new Map<number, GamepadSlotSample>();
  for (const slot of gamepadSlots) {
    gamepadSlotMap.set(slot.index, {
      ...slot,
      ...(slot.feedbackTarget ? { feedbackTarget: Object.freeze({ ...slot.feedbackTarget }) } : {}),
    });
  }

  // Build action lookup map for snap.action(name) readpoint.
  const actionMap = new Map<string, ActionState>();
  if (actionStates) {
    for (const a of actionStates) {
      actionMap.set(a.action, a);
    }
  }

  function emptyActionReader(): ReturnType<InputSnapshot['action']> {
    return Object.freeze({
      isPressed: () => false,
      justPressed: () => false,
      justReleased: () => false,
      strength: 0,
    });
  }

  const snapshot: InputSnapshot = {
    keyboard: {
      down(key) {
        return heldKeys.has(key);
      },
      justPressed(key) {
        return justPressedKeys.has(key);
      },
      up(key) {
        return upEdges.has(key);
      },
      downCode(code) {
        return heldCodes.has(code);
      },
      justPressedCode(code) {
        return justPressedCodes.has(code);
      },
      upCode(code) {
        return upCodeEdges.has(code);
      },
    },
    mouse: {
      position: mousePosition,
      movementDelta,
      pointerLocked: sample.pointerLocked,
      button(i) {
        // i is narrowed to 0 | 1 | 2 by the type system; the runtime
        // index is therefore guaranteed to land in `buttons` (charter P3
        // -- no defensive fallback necessary because the type narrows the
        // input domain to the legal slots).
        return buttons[i] === true;
      },
      justPressed(i) {
        return justPressedButtons[i] === true;
      },
      justReleased(i) {
        return justReleasedButtons[i] === true;
      },
      wheelDelta,
    },
    gamepad(i) {
      const slot = gamepadSlotMap.get(i);
      return buildGamepadReader(slot);
    },
    capabilities: caps,
    pointer(id) {
      const entry = (sample.pointers ?? []).find((p) => p.pointerId === id);
      if (!entry) {
        return Object.freeze({
          active: false,
          pointerId: -1,
          x: 0,
          y: 0,
          pressure: 0,
          pointerType: 'mouse' as PointerType,
          delta: Object.freeze({ x: 0, y: 0 }),
        });
      }
      return Object.freeze({
        ...entry,
        delta: Object.freeze({ x: entry.delta.x, y: entry.delta.y }),
      });
    },
    virtualAxis(name) {
      const va = virtualAxesMap.get(name);
      if (!va) return Object.freeze({ x: 0, y: 0 });
      return Object.freeze({ x: va.x, y: va.y });
    },
    action(name) {
      const s = actionMap.get(name);
      if (!s) return emptyActionReader();
      return Object.freeze({
        isPressed: () => s.pressed,
        justPressed: () => s.justPressed,
        justReleased: () => s.justReleased,
        strength: s.strength,
      });
    },
    getAxis(neg, pos) {
      if (!actionStates) return 0;
      return getAxis(actionStates, neg, pos);
    },
    getVector(negX, posX, negY, posY, opts) {
      if (!actionStates) return { x: 0, y: 0 };
      return getVector(actionStates, negX, posX, negY, posY, opts);
    },
    pointerEvents: pointerEvts,
    gesture,
    gestureEvents: gestureEvts,
  };
  (snapshot as unknown as Record<string, unknown>)._actionStates = actionStates;
  return Object.freeze(snapshot);
}

/**
 * @internal Read previously derived action states from a snapshot for edge diff.
 * Used by the frame-start scan system (D-6: prev snapshot = edge baseline).
 */
export function readActionStatesForEdgeDiff(
  snap: InputSnapshot,
): readonly ActionState[] | undefined {
  return (snap as unknown as { _actionStates?: readonly ActionState[] })._actionStates;
}

/**
 * Construct an empty snapshot for the pre-start window
 * (`engine.run()` has not yet attached a backend). Returns the full
 * multi-device shape as `snapshotFromSample`, with every accessor
 * returning `false` / `0` / zero-vector. AI users can put this into the
 * Resource store to satisfy `world.getResource('InputSnapshot')` calls
 * in fixtures or unit tests (charter P3: empty signal is the signal).
 * The underlying 7-field POD sample contract is unchanged (D-9).
 */
export function createInputSnapshot(): InputSnapshot {
  return snapshotFromSample(createEmptyInputBackendSample());
}

/** Stable Resource key for `world.insertResource` / `world.getResource`. */
export const INPUT_SNAPSHOT_RESOURCE_KEY = 'InputSnapshot';
