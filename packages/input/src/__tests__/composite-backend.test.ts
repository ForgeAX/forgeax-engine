// composite-backend.test.ts -- merge-semantics contract for the
// CompositeInputBackend decorator.
//
// WHY this backend exists: an AI (or a record/replay harness) needs to feed
// synthetic input into the SAME `INPUT_BACKEND_KEY` world resource a human's
// browser backend occupies -- WITHOUT evicting the human (PIE + human-as-final-
// authority: a human can take over at any instant). Replacing the resource
// would lock the human out; a decorator merges both sources so they coexist.
//
// The scan system calls `backend.sample()` exactly once per frame and RELIES on
// its side effects (up-edge / movement / wheel accumulators drain on read).
// So the composite must call `inner.sample()` exactly once and merge the
// injected state field-by-field, honoring each field's lifecycle:
//
//   downKeys   held across frames         -> UNION(inner, injected.held)
//   upKeys     lives exactly ONE frame    -> UNION, injected side drained here
//   buttons    held tuple                 -> OR per slot
//   movementX/Y, wheelDelta  accumulators -> SUM, injected side drained here
//   focused    gates up-edge suppression  -> inner.focused || injectedActive
//   pointerLocked                          -> inner (AI never fabricates a lock)
//
// yieldToHuman (default ON): a human-held key suppresses injected state only for
// that SAME key in that frame, so the AI never fights the human for that key while
// unrelated synthetic input can continue. This is the structural "human wins" gate.

import { describe, expect, it } from 'vitest';
// Import from the leaf modules, not the '../index' barrel: the barrel re-exports
// frame-start-scan-system, which value-imports @forgeax/engine-ecs and would drag
// an (unbuilt-dist) runtime dependency into this pure unit test. composite-backend
// and input-snapshot have no engine-ecs dependency.
import { makeCompositeBackend } from '../composite-backend';
import type { InputBackend, InputBackendSample } from '../input-snapshot';

/** Minimal programmable stand-in for the human/browser backend. */
function fakeInner(init?: Partial<InputBackendSample>): InputBackend & {
  set: (patch: Partial<InputBackendSample>) => void;
  sampleCalls: () => number;
} {
  let calls = 0;
  let state: InputBackendSample = {
    downKeys: new Set<string>(),
    upKeys: new Set<string>(),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
    ...init,
  };
  return {
    sample(): InputBackendSample {
      calls++;
      const out = { ...state, downKeys: new Set(state.downKeys), upKeys: new Set(state.upKeys) };
      // Mirror the real backend: accumulators drain on read.
      state = { ...state, upKeys: new Set(), movementX: 0, movementY: 0, wheelDelta: 0 };
      return out;
    },
    detach() {},
    set(patch) {
      state = { ...state, ...patch };
    },
    sampleCalls: () => calls,
  };
}

describe('CompositeInputBackend merge semantics', () => {
  it('calls inner.sample() exactly once per composite.sample() (respects side effects)', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.sample();
    c.sample();
    expect(inner.sampleCalls()).toBe(2);
  });

  it('downKeys is the UNION of human-held and AI-injected keys', () => {
    // yieldToHuman OFF so overlap coexists -- pure union semantics. (The default
    // yield behavior is covered separately in the yieldToHuman describe block.)
    const inner = fakeInner({ downKeys: new Set(['d']) });
    const c = makeCompositeBackend(inner, { yieldToHuman: false });
    c.press('w');
    const s = c.sample();
    expect(s.downKeys.has('w')).toBe(true); // AI
    expect(s.downKeys.has('d')).toBe(true); // human
  });

  it('injected key stays held across frames until released', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    expect(c.sample().downKeys.has('w')).toBe(true);
    expect(c.sample().downKeys.has('w')).toBe(true); // still held next frame
  });

  it('accepts logical keys and physical codes for both keyboard projections', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    let sample = c.sample();
    expect(sample.downKeys.has('w')).toBe(true);
    expect(sample.downCodes?.has('KeyW')).toBe(true);
    c.release('w');
    sample = c.sample();
    expect(sample.upKeys.has('w')).toBe(true);
    expect(sample.upCodes?.has('KeyW')).toBe(true);

    c.press('KeyW');
    sample = c.sample();
    expect(sample.downKeys.has('w')).toBe(true);
    expect(sample.downCodes?.has('KeyW')).toBe(true);
  });

  it('release produces an up-edge that lives exactly ONE frame', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    c.sample(); // held
    c.release('w');
    const s1 = c.sample();
    expect(s1.upKeys.has('w')).toBe(true); // edge appears once
    expect(s1.downKeys.has('w')).toBe(false); // no longer held
    const s2 = c.sample();
    expect(s2.upKeys.has('w')).toBe(false); // and is gone the next frame
  });

  it('merges human and AI up-edges in the same frame', () => {
    const inner = fakeInner({ upKeys: new Set(['d']) });
    const c = makeCompositeBackend(inner);
    c.press('w');
    c.sample();
    c.release('w');
    inner.set({ upKeys: new Set(['d']) });
    const s = c.sample();
    expect(s.upKeys.has('w')).toBe(true); // AI
    expect(s.upKeys.has('d')).toBe(true); // human
  });

  it('buttons are OR-merged per slot (AI never clears a human button)', () => {
    const inner = fakeInner({ buttons: [false, true, false] });
    const c = makeCompositeBackend(inner);
    c.setButton(0, true);
    const s = c.sample();
    expect(s.buttons).toEqual([true, true, false]);
  });

  it('movement + wheel accumulators are SUMMED and the injected side drains on read', () => {
    const inner = fakeInner({ movementX: 3, movementY: -2, wheelDelta: 1 });
    const c = makeCompositeBackend(inner);
    c.addMovement(10, 20);
    c.addWheel(2);
    const s1 = c.sample();
    expect(s1.movementX).toBe(13);
    expect(s1.movementY).toBe(18);
    expect(s1.wheelDelta).toBe(3);
    // Injected accumulator must reset (inner already drains itself).
    const s2 = c.sample();
    expect(s2.movementX).toBe(0);
    expect(s2.movementY).toBe(0);
    expect(s2.wheelDelta).toBe(0);
  });

  it('focused is forced true while AI injection is active (so scan does not suppress AI up-edges)', () => {
    const inner = fakeInner({ focused: false }); // headless / backgrounded tab
    const c = makeCompositeBackend(inner);
    c.press('w');
    expect(c.sample().focused).toBe(true);
  });

  it('focused falls back to inner when there is no active injection', () => {
    const inner = fakeInner({ focused: false });
    const c = makeCompositeBackend(inner);
    expect(c.sample().focused).toBe(false);
    inner.set({ focused: true });
    expect(c.sample().focused).toBe(true);
  });

  it('pointerLocked passes through from inner (AI cannot fabricate a lock)', () => {
    const inner = fakeInner({ pointerLocked: true });
    const c = makeCompositeBackend(inner);
    c.press('w');
    expect(c.sample().pointerLocked).toBe(true);
  });

  describe('yieldToHuman gate (human-as-final-authority) — PER-KEY', () => {
    it('the human wins only the SAME key; unrelated AI keys coexist', () => {
      const inner = fakeInner();
      const c = makeCompositeBackend(inner); // yieldToHuman defaults ON
      c.press('w');
      expect(c.sample().downKeys.has('w')).toBe(true); // AI drives while human idle

      // Human presses a DIFFERENT key (d): AI's w survives, human's d is added —
      // they coexist. This is the key difference from a global-yield gate.
      inner.set({ downKeys: new Set(['d']) });
      const s = c.sample();
      expect(s.downKeys.has('d')).toBe(true); // human's key
      expect(s.downKeys.has('w')).toBe(true); // AI's DIFFERENT key still lives

      inner.set({ downKeys: new Set() });
      expect(c.sample().downKeys.has('w')).toBe(true); // AI still held
    });

    it('a human press on the SAME key the AI holds suppresses the AI copy (no double-count)', () => {
      const inner = fakeInner();
      const c = makeCompositeBackend(inner);
      c.press('w');
      // Human grabs the SAME key. downKeys still has 'w' exactly once (Set), but the
      // AI copy is suppressed so releasing the AI key does not linger under the human.
      inner.set({ downKeys: new Set(['w']) });
      expect(c.sample().downKeys.has('w')).toBe(true); // present via the human

      // Human lets go while AI still holds w -> AI resumes ownership of w.
      inner.set({ downKeys: new Set() });
      expect(c.sample().downKeys.has('w')).toBe(true);
    });

    it('suppresses an injected up-edge while the human still holds that same key', () => {
      const inner = fakeInner();
      const c = makeCompositeBackend(inner);
      c.press('w');
      c.sample();

      // The human takes w, then the AI releases its now-yielded copy. The composite
      // must not tell the scan system that w went up while the human still holds it.
      inner.set({ downKeys: new Set(['w']) });
      c.release('w');
      const s = c.sample();
      expect(s.downKeys.has('w')).toBe(true);
      expect(s.upKeys.has('w')).toBe(false);

      // The injected edge was drained with the sample, so releasing the human key
      // later is represented only by the human backend's own edge.
      inner.set({ downKeys: new Set(), upKeys: new Set(['w']) });
      const afterHumanRelease = c.sample();
      expect(afterHumanRelease.downKeys.has('w')).toBe(false);
      expect(afterHumanRelease.upKeys.has('w')).toBe(true);
    });

    it('with yieldToHuman disabled, AI and human coexist even on the SAME key', () => {
      const inner = fakeInner({ downKeys: new Set(['w']) });
      const c = makeCompositeBackend(inner, { yieldToHuman: false });
      c.press('w');
      const s = c.sample();
      expect(s.downKeys.has('w')).toBe(true); // union collapses to one anyway
    });

    it('setYieldToHuman toggles the SAME-key gate at runtime', () => {
      const inner = fakeInner({ downKeys: new Set(['w']) }); // human holds w
      const c = makeCompositeBackend(inner);
      c.press('w'); // AI also holds w
      // With yield on, the AI copy of w is suppressed; the human still supplies w,
      // so to observe the gate we track a SECOND AI-only key and the up-edge behavior.
      c.press('a'); // AI-only key (human not pressing it)
      let s = c.sample();
      expect(s.downKeys.has('a')).toBe(true); // AI-only key always lives
      expect(s.downKeys.has('w')).toBe(true); // supplied by the human
      // Disable yield: nothing changes for a union of held keys (w still one entry).
      c.setYieldToHuman(false);
      s = c.sample();
      expect(s.downKeys.has('w')).toBe(true);
      expect(s.downKeys.has('a')).toBe(true);
    });
  });

  it('clearInjected drops all AI state (held keys become up-edges once)', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    c.press('a');
    c.sample();
    c.clearInjected();
    const s = c.sample();
    expect(s.downKeys.has('w')).toBe(false);
    expect(s.downKeys.has('a')).toBe(false);
    expect(s.upKeys.has('w')).toBe(true); // clean release edge
    expect(s.upKeys.has('a')).toBe(true);
  });

  it('clearInjected drops pending press/release latches without ghost edges', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    c.setButton(0, true);
    c.release('w');
    c.setButton(0, false);
    c.clearInjected();

    const sample = c.sample();
    expect(sample.downKeys.size).toBe(0);
    expect(sample.upKeys.size).toBe(0);
    expect(sample.pressedKeys).toBeUndefined();
    expect(sample.buttons).toEqual([false, false, false]);
    expect(sample.pressedButtons).toBeUndefined();
    expect(sample.releasedButtons).toBeUndefined();
  });

  it('revokeInjectedLease fences late injections until a new lease opens', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    c.press('w');
    expect(c.sample().downCodes?.has('KeyW')).toBe(true);
    c.revokeInjectedLease();
    c.press('a');
    expect(c.sample().downKeys.has('a')).toBe(false);
    c.beginInjectedLease();
    c.press('a');
    expect(c.sample().downCodes?.has('KeyA')).toBe(true);
  });

  it('keeps an old execution lease read-only after a later lease opens', () => {
    const inner = fakeInner();
    const c = makeCompositeBackend(inner);
    const oldLease = c.createInjectedLease();
    oldLease.press('KeyW');
    expect(c.sample().downCodes?.has('KeyW')).toBe(true);

    const currentLease = c.createInjectedLease();
    oldLease.revokeInjectedLease();
    oldLease.press('KeyA');
    oldLease.setButton(0, true);
    oldLease.addMovement(10, 20);
    oldLease.addWheel(3);
    expect(c.sample().downKeys.has('a')).toBe(false);
    expect(c.sample().buttons[0]).toBe(false);
    expect(c.sample().movementX).toBe(0);
    expect(c.sample().wheelDelta).toBe(0);

    currentLease.press('KeyD');
    const sample = c.sample();
    expect(sample.downKeys.has('d')).toBe(true);
    expect(sample.downKeys.has('a')).toBe(false);
  });

  it('forwards setPointerLockAllowed and detach to inner', () => {
    let allowed: boolean | undefined;
    let detached = false;
    const inner: InputBackend = {
      sample: () => ({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      }),
      setPointerLockAllowed: (a) => {
        allowed = a;
      },
      detach: () => {
        detached = true;
      },
    };
    const c = makeCompositeBackend(inner);
    c.setPointerLockAllowed?.(false);
    expect(allowed).toBe(false);
    c.detach();
    expect(detached).toBe(true);
  });

  it('preserves inner optional fields (pointerEvents/pointers) untouched', () => {
    const inner = fakeInner();
    inner.set({
      pointerEvents: [
        { pointerId: 1, phase: 'down', x: 5, y: 6, pressure: 1, pointerType: 'mouse' },
      ],
    });
    const c = makeCompositeBackend(inner);
    const s = c.sample();
    expect(s.pointerEvents?.[0]?.phase).toBe('down');
  });
  it.each([
    'owner',
    'lease',
  ] as const)('drains %s writes at the same frame and input boundaries', (kind) => {
    const inner = fakeInner({ focused: false });
    const backend = makeCompositeBackend(inner, { yieldToHuman: false });
    const writer = kind === 'owner' ? backend : backend.createInjectedLease();
    writer.press('KeyW');
    writer.press('Space');
    writer.setButton(2, true);
    writer.addMovement(2, -3);
    writer.addWheel(4);
    const first = backend.sample();
    expect(first.downKeys).toEqual(new Set(['w', ' ']));
    expect(first.downCodes).toEqual(new Set(['KeyW', 'Space']));
    expect(first.pressedKeys).toEqual(new Set(['w', ' ']));
    expect(first.pressedButtons).toEqual([false, false, true]);
    expect([first.movementX, first.movementY, first.wheelDelta]).toEqual([2, -3, 4]);
    expect(first.focused).toBe(true);
    const held = backend.sample();
    expect(held.pressedKeys).toBeUndefined();
    expect(held.pressedButtons).toBeUndefined();
    expect(held.buttons[2]).toBe(true);
    expect([held.movementX, held.movementY, held.wheelDelta]).toEqual([0, 0, 0]);
    writer.clearInjected();
    const cleared = backend.sample();
    expect(cleared.upKeys).toEqual(new Set(['w', ' ']));
    expect(cleared.upCodes).toEqual(new Set(['KeyW', 'Space']));
    expect(cleared.releasedButtons).toEqual([false, false, true]);
    expect(cleared.downKeys.size).toBe(0);
    expect(backend.sample().releasedButtons).toBeUndefined();
    backend.setInputAllowed?.(false);
    writer.press('KeyA');
    writer.setButton(0, true);
    writer.addMovement(7, 8);
    writer.addWheel(9);
    const denied = backend.sample();
    expect(denied.downKeys.size).toBe(0);
    expect(denied.buttons).toEqual([false, false, false]);
    expect([denied.movementX, denied.movementY, denied.wheelDelta]).toEqual([0, 0, 0]);
    expect(inner.sampleCalls()).toBe(5);
  });
});

describe('composite press-edge source ownership', () => {
  it('publishes injected physical press edges for one frame', () => {
    const backend = makeCompositeBackend(fakeInner());
    backend.press('KeyW');
    const first = backend.sample();
    expect(first.pressedKeys?.has('w')).toBe(true);
    expect(first.pressedCodes?.has('KeyW')).toBe(true);
    const second = backend.sample();
    expect(second.pressedCodes?.has('KeyW') ?? false).toBe(false);
    expect(second.downCodes?.has('KeyW')).toBe(true);
  });

  it('keeps a human press edge while suppressing an overlapping injected press', () => {
    const backend = makeCompositeBackend(
      fakeInner({
        downKeys: new Set(['w']),
        downCodes: new Set(['KeyW']),
        pressedKeys: new Set(['w']),
        pressedCodes: new Set(['KeyW']),
      }),
    );
    backend.press('KeyW');
    const sample = backend.sample();
    expect([...(sample.pressedKeys ?? [])]).toEqual(['w']);
    expect([...(sample.pressedCodes ?? [])]).toEqual(['KeyW']);
  });
});
