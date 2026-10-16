// @forgeax/engine-input -- CompositeInputBackend (synthetic-input decorator).
//
// PROBLEM. The scan system reads ONE `InputBackend` from `INPUT_BACKEND_KEY`
// each frame. An AI / record-replay harness needs to feed synthetic input into
// that same slot WITHOUT evicting the human's browser backend -- because a human
// may take over at any instant (PIE two-world model + charter §8 human-as-final-
// authority). Overwriting the resource locks the human out; wrapping it does not.
//
// SOLUTION. `makeCompositeBackend(inner)` returns an `InputBackend` that HOLDS
// the human backend as `inner` and layers a programmatic injection surface
// (`press` / `release` / `setButton` / `addMovement` / `addWheel`) on top. The
// scan system stays variant-agnostic: it still calls `sample()` on one backend
// (Depend-on-Abstractions -- the consumer never learns a composite exists).
//
// SIDE-EFFECT CONTRACT. `inner.sample()` DRAINS its per-frame accumulators
// (up-edges, movement delta, wheel notches) on read, so the composite calls it
// EXACTLY ONCE per `sample()` and drains its OWN injected accumulators in the
// same pass. Field-by-field merge honoring each field's lifecycle:
//
//   downKeys   held across frames    -> UNION(inner, injected.held)
//   upKeys     lives one frame        -> UNION; injected up-edge set drained here
//   buttons    held tuple             -> OR per slot
//   movementX/Y, wheelDelta            -> SUM; injected side reset to 0 here
//   focused    gates up-edge suppress -> inner.focused || injectionActive
//   pointerLocked                      -> inner (AI must not fabricate a lock)
//   optional (pointers/gamepads/...)   -> pass through from inner untouched
//
// YIELD-TO-HUMAN (default on). A human-held key on `inner` suppresses only the
// injected state for that SAME key in that frame. Other AI keys continue, so a
// human can take a key without silencing unrelated synthetic input. This is the
// structural realization of "human wins" without a global takeover policy.

import { ButtonLatch, KeyLatch } from './digital-input';
import type { InputBackend, InputBackendSample } from './input-snapshot';

function mergeKeyState(
  base: ReadonlySet<string> | undefined,
  injected: ReadonlySet<string>,
  humanOwns: (key: string) => boolean,
): Set<string> {
  const merged = new Set(base);
  for (const key of injected) if (!humanOwns(key)) merged.add(key);
  return merged;
}

/** Options controlling the composite merge policy. */
export interface CompositeBackendOptions {
  /**
   * When `true` (default), a key held on the inner (human) backend suppresses
   * injected state only for that same key in that frame. Set `false` for
   * record/replay or AI-solo scenarios where both sources should coexist even
   * on key overlap.
   */
  readonly yieldToHuman?: boolean;
}

/**
 * A composite backend: an `InputBackend` (drop-in for `INPUT_BACKEND_KEY`) plus
 * a programmatic injection surface. All injection is additive over the wrapped
 * human backend.
 */
export interface CompositeInputBackend extends InputBackend {
  /** Hold `key` down (mirrors a keydown). Idempotent. */
  press(key: string): void;
  /** Release `key` (mirrors a keyup); emits a one-frame up-edge on next sample. */
  release(key: string): void;
  /** Set an injected mouse-button slot (0/1/2) held-state. */
  setButton(slot: 0 | 1 | 2, down: boolean): void;
  /** Accumulate injected pointer-lock movement delta (drained on next sample). */
  addMovement(dx: number, dy: number): void;
  /** Accumulate injected wheel notches (drained on next sample). */
  addWheel(notches: number): void;
  /**
   * Drop all injected state and pending frame edges; currently-held keys/buttons
   * emit one clean release edge so a previously observed hold is closed.
   */
  clearInjected(): void;
  /** Open a fresh synthetic-input lease after a previous revoke boundary. */
  beginInjectedLease(): void;
  /** Revoke the current lease and fence later injections until reopened. */
  revokeInjectedLease(): void;
  /**
   * Create the one execution-scoped injection view. Creating a lease
   * invalidates every previously-created view; an invalid view remains a
   * no-op even after a later lease is opened.
   */
  createInjectedLease(): CompositeInputLease;
  /** Toggle the yield-to-human gate at runtime. */
  setYieldToHuman(yield_: boolean): void;
}

/**
 * Synthetic input exposed to one eval/execution. It deliberately has no
 * `beginInjectedLease` method: a script can release its own lease, but it
 * cannot reopen an old reference after the host has moved to another job.
 */
export interface CompositeInputLease extends InputBackend {
  press(key: string): void;
  release(key: string): void;
  setButton(slot: 0 | 1 | 2, down: boolean): void;
  addMovement(dx: number, dy: number): void;
  addWheel(notches: number): void;
  clearInjected(): void;
  revokeInjectedLease(): void;
}

// The public injection surface accepts either the logical KeyboardEvent.key
// (`w`, ` `, `ArrowUp`) or the physical KeyboardEvent.code (`KeyW`, `Space`).
// Keep both projections populated so code-first control drives games that read
// either keyboard.down(...) or keyboard.downCode(...).
const CODE_TO_KEY: Readonly<Record<string, string>> = {
  Space: ' ',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

function keyForCode(code: string): string | undefined {
  if (CODE_TO_KEY[code] !== undefined) return CODE_TO_KEY[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  if (/^Arrow(?:Up|Down|Left|Right)$/.test(code)) return code;
  if (/^(?:Escape|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Insert)$/.test(code))
    return code;
  return undefined;
}

function codeForKey(key: string): string | undefined {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === ' ') return 'Space';
  if (
    /^(?:Arrow(?:Up|Down|Left|Right)|Escape|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Insert)$/.test(
      key,
    )
  )
    return key;
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return key;
  const entry = Object.entries(CODE_TO_KEY).find(([, value]) => value === key);
  return entry?.[0];
}

function normalizeKey(value: string): { readonly key: string; readonly code: string | undefined } {
  const logical = keyForCode(value);
  return logical === undefined
    ? { key: value, code: codeForKey(value) }
    : { key: logical, code: value };
}

export function makeCompositeBackend(
  inner: InputBackend,
  options?: CompositeBackendOptions,
): CompositeInputBackend {
  let yieldToHuman = options?.yieldToHuman ?? true;
  let inputAllowed = true;
  let leaseRevoked = false;
  let leaseGeneration = 0;

  // Injected held-state (survives across frames).
  const keys = new KeyLatch();
  const codes = new KeyLatch();
  const mouseButtons = new ButtonLatch();
  const { held: heldKeys, pressed: pressedKeys, released: upEdges } = keys;
  const { held: heldCodes, pressed: pressedCodes, released: upCodeEdges } = codes;
  const { held: buttons, pressed: pressedButtons, released: releasedButtons } = mouseButtons;
  let mvx = 0;
  let mvy = 0;
  let wheel = 0;

  function drainInjectedFrame(): void {
    keys.clearFrame();
    codes.clearFrame();
    mouseButtons.clearFrame();
    mvx = 0;
    mvy = 0;
    wheel = 0;
  }

  function injectionActive(): boolean {
    return (
      heldKeys.size > 0 ||
      heldCodes.size > 0 ||
      upEdges.size > 0 ||
      upCodeEdges.size > 0 ||
      pressedKeys.size > 0 ||
      pressedCodes.size > 0 ||
      buttons.some((b) => b) ||
      pressedButtons.some((b) => b) ||
      releasedButtons.some((b) => b)
    );
  }

  function humanOwnsKey(base: InputBackendSample, key: string, code: string | undefined): boolean {
    return (
      yieldToHuman &&
      (base.downKeys.has(key) || (code !== undefined && base.downCodes?.has(code) === true))
    );
  }

  function humanOwnsCode(base: InputBackendSample, code: string): boolean {
    const key = keyForCode(code);
    return (
      yieldToHuman &&
      (base.downCodes?.has(code) === true || (key !== undefined && base.downKeys.has(key)))
    );
  }

  function sample(): InputBackendSample {
    // Call inner EXACTLY once -- it drains its own accumulators here.
    const base = inner.sample();
    if (!inputAllowed) {
      clearInjected();
      return {
        ...base,
        downKeys: new Set(),
        upKeys: new Set(),
        downCodes: new Set(),
        upCodes: new Set(),
        pressedKeys: new Set(),
        pressedCodes: new Set(),
        buttons: [false, false, false],
        pressedButtons: [false, false, false],
        releasedButtons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        pointerLocked: false,
      };
    }

    // yield-to-human is PER-KEY: an injected key is suppressed only when the human
    // is holding the SAME key this frame. This is the minimal realization of
    // charter §8 (the human always wins a key they touch) WITHOUT the collateral of
    // a global gate — a human strafing D does not silence an AI holding W, so the
    // two genuinely coexist (that is the whole point of a composite; a caller who
    // wants "human takes over everything" can clearInjected() at the policy layer).
    // downKeys: union of human-held and injected-held, minus injected keys the human
    // is also pressing. A yielded injected release is likewise a no-op: emitting its
    // up-edge would incorrectly release the human-held key in the scan system.
    const ownsKey = (key: string) => humanOwnsKey(base, key, codeForKey(key));
    const ownsCode = (code: string) => humanOwnsCode(base, code);
    const downKeys = mergeKeyState(base.downKeys, heldKeys, ownsKey);
    const downCodes =
      base.downCodes === undefined && heldCodes.size === 0
        ? undefined
        : mergeKeyState(base.downCodes, heldCodes, ownsCode);
    const mergedUp = mergeKeyState(base.upKeys, upEdges, ownsKey);
    const mergedUpCodes =
      base.upCodes === undefined && upCodeEdges.size === 0
        ? undefined
        : mergeKeyState(base.upCodes, upCodeEdges, ownsCode);
    const mergedPressed =
      base.pressedKeys === undefined && pressedKeys.size === 0
        ? undefined
        : mergeKeyState(base.pressedKeys, pressedKeys, ownsKey);
    const mergedPressedCodes =
      base.pressedCodes === undefined && pressedCodes.size === 0
        ? undefined
        : mergeKeyState(base.pressedCodes, pressedCodes, ownsCode);

    // buttons: OR per slot.
    const mergedButtons: readonly [boolean, boolean, boolean] = [
      base.buttons[0] || buttons[0],
      base.buttons[1] || buttons[1],
      base.buttons[2] || buttons[2],
    ];
    const mergedPressedButtons =
      base.pressedButtons === undefined && !pressedButtons.some(Boolean)
        ? undefined
        : ([
            (base.pressedButtons?.[0] ?? false) || pressedButtons[0],
            (base.pressedButtons?.[1] ?? false) || pressedButtons[1],
            (base.pressedButtons?.[2] ?? false) || pressedButtons[2],
          ] as const);
    const mergedReleasedButtons =
      base.releasedButtons === undefined && !releasedButtons.some(Boolean)
        ? undefined
        : ([
            (base.releasedButtons?.[0] ?? false) || releasedButtons[0],
            (base.releasedButtons?.[1] ?? false) || releasedButtons[1],
            (base.releasedButtons?.[2] ?? false) || releasedButtons[2],
          ] as const);

    // focused: keep true while WE are injecting, so the scan system does not
    // treat a headless/backgrounded tab (inner.focused === false) as a reason
    // to suppress our up-edges. Otherwise mirror inner.
    const focused = base.focused || injectionActive();

    const out: InputBackendSample = {
      ...base, // carry inner optional fields (pointers/gamepads/gestures/...) untouched
      downKeys,
      upKeys: mergedUp,
      ...(downCodes === undefined ? {} : { downCodes }),
      ...(mergedUpCodes === undefined ? {} : { upCodes: mergedUpCodes }),
      ...(mergedPressed === undefined ? {} : { pressedKeys: mergedPressed }),
      ...(mergedPressedCodes === undefined ? {} : { pressedCodes: mergedPressedCodes }),
      buttons: mergedButtons,
      ...(mergedPressedButtons === undefined ? {} : { pressedButtons: mergedPressedButtons }),
      ...(mergedReleasedButtons === undefined ? {} : { releasedButtons: mergedReleasedButtons }),
      movementX: base.movementX + mvx,
      movementY: base.movementY + mvy,
      wheelDelta: base.wheelDelta + wheel,
      focused,
      pointerLocked: base.pointerLocked, // AI never fabricates a lock
    };

    drainInjectedFrame();

    return out;
  }

  // Only surface setPointerLockAllowed when the inner backend supports it, so
  // the optional method is truly absent (not `undefined`) under
  // exactOptionalPropertyTypes -- and forwards to the human backend when present.
  const lockGate: Pick<InputBackend, 'setPointerLockAllowed'> = inner.setPointerLockAllowed
    ? { setPointerLockAllowed: (allowed: boolean) => inner.setPointerLockAllowed?.(allowed) }
    : {};
  const inputGate: Pick<InputBackend, 'setInputAllowed'> = {
    setInputAllowed: (allowed: boolean) => {
      inputAllowed = allowed;
      inner.setInputAllowed?.(allowed);
      // Closing and reopening are both lease boundaries. Clear after either
      // transition so synthetic edges cannot cross a startup/input fence.
      clearInjected();
    },
  };

  const clearInjected = (): void => {
    // Clearing is a lease boundary: discard every pending frame edge first,
    // then emit only the releases required to close state that was held
    // across the boundary. This prevents a press/release queued before a
    // revoke from becoming a ghost edge for the next consumer.
    drainInjectedFrame();
    keys.releaseAll();
    codes.releaseAll();
    mouseButtons.releaseAll();
  };

  const beginInjectedLease = (): void => {
    // A new boundary must invalidate old references. Merely flipping a global
    // boolean would let an async script keep writing after a later job opens.
    leaseGeneration += 1;
    leaseRevoked = false;
    clearInjected();
  };
  const revokeInjectedLease = (): void => {
    leaseGeneration += 1;
    leaseRevoked = true;
    clearInjected();
  };

  // Both owner and execution views write the same injected state. Only the
  // admission predicate differs: execution views also capture a generation.
  const injectionWriter = (
    active: () => boolean,
  ): Pick<CompositeInputLease, 'press' | 'release' | 'setButton' | 'addMovement' | 'addWheel'> => ({
    press(key) {
      if (!active()) return;
      const normalized = normalizeKey(key);
      keys.press(normalized.key);
      if (normalized.code !== undefined) codes.press(normalized.code);
    },
    release(key) {
      if (!active()) return;
      const normalized = normalizeKey(key);
      if (heldKeys.has(normalized.key)) keys.release(normalized.key);
      if (normalized.code !== undefined && heldCodes.has(normalized.code))
        codes.release(normalized.code);
    },
    setButton(slot, down) {
      if (!active()) return;
      mouseButtons.set(slot, down);
    },
    addMovement(dx, dy) {
      if (!active()) return;
      mvx += dx;
      mvy += dy;
    },
    addWheel(notches) {
      if (!active()) return;
      wheel += notches;
    },
  });

  const createInjectedLease = (): CompositeInputLease => {
    beginInjectedLease();
    const generation = leaseGeneration;
    const active = (): boolean => inputAllowed && !leaseRevoked && generation === leaseGeneration;
    return {
      sample,
      detach: () => {},
      ...injectionWriter(active),
      clearInjected() {
        if (active()) clearInjected();
      },
      revokeInjectedLease() {
        if (active()) revokeInjectedLease();
      },
    };
  };

  return {
    ...(inner.feedback ? { feedback: inner.feedback } : {}),
    ...(inner.dispatchFeedback ? { dispatchFeedback: inner.dispatchFeedback.bind(inner) } : {}),
    sample,
    ...lockGate,
    ...inputGate,
    // Teardown belongs to the human backend -- revoke the synthetic lease
    // first, then forward the physical listener teardown.  `clear()` is also
    // exposed so an owner can revoke input without detaching the browser.
    clear: () => {
      clearInjected();
      inner.clear?.();
    },
    detach: () => {
      clearInjected();
      inner.detach();
    },

    ...injectionWriter(() => inputAllowed && !leaseRevoked),
    clearInjected,
    beginInjectedLease,
    revokeInjectedLease,
    createInjectedLease,
    setYieldToHuman(yield_) {
      yieldToHuman = yield_;
    },
  };
}
