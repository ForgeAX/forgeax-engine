// @forgeax/engine-remote/src/__tests__/execute.async.test.ts
// TDD green-phase tests for async executeScript (w5):
//   w1 — async read of world/renderer/assets state
//   w2 — async write without sandbox interception (route B, no inspector-write-denied)
//   w3 — _import('@forgeax/engine-ecs') + World.query discovery
//
// Route B (D-1): host realm eval via new Function with injected _import.
// Scripts that need dynamic import use the _import parameter:
//   const ecs = await _import('@forgeax/engine-ecs');
// Simple expressions return value directly.
// No wrapReadOnly, no timeout. inspector-write-denied and script-timeout
// error codes deleted per D-5, not in RemoteErrorCode union.

import { describe, expect, it } from 'vitest';
import { executeScript } from '../execute';

// ── Mock world ──────────────────────────────────────────────────────────────

function makeMockWorld() {
  const state: unknown[] = [];
  // Archetype shape retained for scripts that inspect the mock World internals:
  // - columns: Map<compId, Map<fieldName, { length: number }>>
  //   The Entity component (id=0) has field 'self' with Uint32Array length.
  function mkArchetype(id: number) {
    const selfField = new Map([['self', { length: 3 }]]);
    const columns = new Map([[0, selfField]]);
    return { id, componentIds: [0], columns };
  }
  return {
    _getGraph() {
      return {
        generation: 1,
        archetypes: [mkArchetype(0), mkArchetype(1)],
      };
    },
    inspect(): { entityCount: number } {
      return { entityCount: state.length + 5 };
    },
    push(item: unknown): unknown[] {
      state.push(item);
      return state;
    },
    getList(): unknown[] {
      return [...state];
    },
    getState() {
      return { entityCount: state.length + 5, pushedCount: state.length };
    },
  };
}

const mockRenderer = {
  isReady: true,
  dispose() {
    /* no-op */
  },
};
const mockAssets = { HANDLE_CUBE: 1, HANDLE_TRIANGLE: 2 };

function makeCtx() {
  return {
    world: makeMockWorld(),
    renderer: mockRenderer,
    assets: mockAssets,
  };
}

/** Wrap script in async IIFE with _import injection. */
function aw(script: string): string {
  return `(async () => {\n${script}\n})()`;
}

// ────────────────────────────────────────────────────────────────────────────
// w1: async read
// ────────────────────────────────────────────────────────────────────────────

describe('executeScript async - read (w1)', () => {
  it('reads world.inspect() entity count', async () => {
    const ctx = makeCtx();
    const result = await executeScript('world.inspect().entityCount', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(5);
    }
  });

  it('reads renderer.isReady from context', async () => {
    const ctx = makeCtx();
    const result = await executeScript('renderer.isReady', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  it('reads asset handle constants', async () => {
    const ctx = makeCtx();
    const result = await executeScript('assets.HANDLE_CUBE', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
  });

  it('returns script-syntax-error on malformed expression', async () => {
    const ctx = makeCtx();
    const result = await executeScript('world.inspect((', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('script-syntax-error');
    }
  });

  it('returns script-runtime-error on throw', async () => {
    const ctx = makeCtx();
    const result = await executeScript('throw new Error("boom")', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('script-runtime-error');
    }
  });

  it('NO script-timeout: error code deleted from RemoteErrorCode (route B, no timeout)', async () => {
    const ctx = makeCtx();
    const result = await executeScript('throw new Error("x")', ctx);
    if (!result.ok) {
      expect(result.error.code).not.toBe('script-timeout');
    }
  });

  it('await + setTimeout works via async IIFE wrapping', async () => {
    const ctx = makeCtx();
    const script = aw('await new Promise(r => setTimeout(r, 20)); return 42;');
    const result = await executeScript(script, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// w2: async write — no inspector-write-denied (sandbox dismantled)
// ────────────────────────────────────────────────────────────────────────────

describe('executeScript async - write (w2)', () => {
  it('world.push succeeds without inspector-write-denied', async () => {
    const ctx = makeCtx();
    const result = await executeScript('world.push(10)', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([10]);
    }
  });

  it('write-then-read: push modifies state, persists across evals', async () => {
    const ctx = makeCtx();

    // Contract (round 20260713-124956): the script is an async function body,
    // so a MULTI-statement script uses an explicit `return` for its value (a
    // lone trailing expression is auto-returned; a statement list is not). This
    // replaces the prior indirect-eval completion-value behavior — the trade
    // that buys legal top-level `return` + `await`, which the docs already show.
    const r1 = await executeScript('world.push(42); world.push(43); return world.getList()', ctx);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value).toEqual([42, 43]);
    }

    const r2 = await executeScript('world.getList()', ctx);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toEqual([42, 43]);
    }
  });

  it('error code is NOT inspector-write-denied on write', async () => {
    const ctx = makeCtx();
    const result = await executeScript('world.push({})', ctx);
    expect(result.ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// w3: _import in eval (route B — host realm, via async IIFE)
// ────────────────────────────────────────────────────────────────────────────

describe('executeScript async - _import (w3)', () => {
  it('uses the context import resolver when a host supplies one', async () => {
    const imported: string[] = [];
    const result = await executeScript(
      'const ecs = await _import("@forgeax/engine-ecs"); return ecs.name;',
      {
        ...makeCtx(),
        importModule: async (specifier: string) => {
          imported.push(specifier);
          return { name: 'browser-resolved-ecs' };
        },
      },
    );

    expect(result).toEqual({ ok: true, value: 'browser-resolved-ecs' });
    expect(imported).toEqual(['@forgeax/engine-ecs']);
  });

  it('_import(@forgeax/engine-ecs) resolves in eval', async () => {
    const ctx = makeCtx();
    const script = aw(
      [
        'const { World } = await _import("@forgeax/engine-ecs");',
        'return typeof World.prototype.query === "function";',
      ].join('\n'),
    );
    const result = await executeScript(script, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  it('World.query and Entity are discoverable in eval', async () => {
    const ctx = makeCtx();
    // Verify _import works and the final query surface is discoverable.
    const script = aw(
      [
        'const { World, Entity } = await _import("@forgeax/engine-ecs");',
        'return {',
        '  hasWorldQuery: typeof World.prototype.query === "function",',
        '  hasEntity: typeof Entity === "object",',
        '};',
      ].join('\n'),
    );
    const result = await executeScript(script, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as {
        hasWorldQuery: boolean;
        hasEntity: boolean;
      };
      expect(v.hasWorldQuery).toBe(true);
      expect(v.hasEntity).toBe(true);
    }
  });

  it('World.query accepts one descriptor', async () => {
    const script = aw(
      [
        'const { World } = await _import("@forgeax/engine-ecs");',
        'return {',
        '  isFunction: typeof World.prototype.query === "function",',
        '  arity: World.prototype.query.length,',
        '};',
      ].join('\n'),
    );
    const result = await executeScript(script, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { isFunction: boolean; arity: number };
      expect(v.isFunction).toBe(true);
      expect(v.arity).toBe(1);
    }
  });

  it('Entity component keeps its self field', async () => {
    // Verify Entity component is defined and has a 'self' field.
    // This confirms the component token exists in the imported module,
    // which remains useful to eval scripts for component access.
    const script = aw(
      [
        'const { Entity } = await _import("@forgeax/engine-ecs");',
        'return {',
        '  isObject: typeof Entity === "object",',
        '  hasDef: typeof Entity.defineComponent === "undefined" || true,',
        '  name: Entity.name,',
        '};',
      ].join('\n'),
    );
    const result = await executeScript(script, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { isObject: boolean; name: string };
      expect(v.isObject).toBe(true);
      expect(v.name).toBe('Entity');
    }
  });

  it('the final World query entry point is discoverable', async () => {
    const ctx = makeCtx();
    const script = aw(
      [
        'const ecs = await _import("@forgeax/engine-ecs");',
        'return typeof ecs.World.prototype.query === "function";',
      ].join('\n'),
    );
    const result = await executeScript(script, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Un-wrapped top-level return / await (solo round 20260713-124956):
// the README + AGENTS.md recipes show top-level `return` and `await` WITHOUT
// an async IIFE, but the old indirect-eval core (`return eval(script)`) threw
// script-syntax-error on both. These pin the AsyncFunction-body contract so a
// docs-following AI user's first, un-wrapped script works.
// ────────────────────────────────────────────────────────────────────────────

describe('executeScript - un-wrapped top-level return / await', () => {
  it('top-level `return <literal>` returns the value (no async IIFE)', async () => {
    const ctx = makeCtx();
    const result = await executeScript('return 42', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('top-level `await <promise>` resolves (no async IIFE)', async () => {
    const ctx = makeCtx();
    const result = await executeScript('await Promise.resolve(7)', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(7);
  });

  it('bare expression still auto-returns its value', async () => {
    const ctx = makeCtx();
    const result = await executeScript('renderer.isReady', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it('bare expression with a trailing semicolon still returns its value', async () => {
    const ctx = makeCtx();
    const result = await executeScript('renderer.isReady;', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it('multi-statement: top-level await _import then return (the documented recipe, un-wrapped)', async () => {
    const ctx = makeCtx();
    const script = [
      'const ecs = await _import("@forgeax/engine-ecs");',
      'return typeof ecs.World.prototype.query;',
    ].join('\n');
    const result = await executeScript(script, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('function');
  });

  it('the historical async-IIFE form still works (backward compatible)', async () => {
    const ctx = makeCtx();
    const result = await executeScript(aw('return 99;'), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(99);
  });

  it('genuine syntax error still surfaces script-syntax-error (both compile modes fail)', async () => {
    const ctx = makeCtx();
    const result = await executeScript('const = ;', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('script-syntax-error');
  });

  it('multi-statement WITHOUT return yields undefined (async-body contract, not eval completion value)', async () => {
    const ctx = makeCtx();
    // A statement list is not auto-returned; only a lone trailing expression is.
    // This is the intentional trade for legal top-level return/await.
    const result = await executeScript('const a = 1; a + 1', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});
