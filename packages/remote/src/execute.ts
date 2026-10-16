// @forgeax/engine-remote/src/execute — async host-realm eval.
//
// D-1 route B (2026-06-29): vm.runInContext does not honor
// importModuleDynamically for Script execution. Host realm compilation via
// the AsyncFunction constructor resolves `await import` naturally, as long
// as the import function from the calling module scope is injected.
//
// CONTRACT (the one an AI user holds): the script IS the body of an async
// function with `world` / `renderer` / `assets` / `rhiCapture` / `simulation` / `plugins` / `_import`
// in scope. So all of these Just Work, un-wrapped:
//   - a bare expression:            `renderer.backend`            -> auto-returned
//   - top-level await:              `await _import('engine-module')`
//   - top-level return:             `return world.inspect().entityCount`
//   - multi-statement + return:     `const m = await _import(...); return m.x`
// (the historical `(async () => { ... })()` IIFE form still works too — its
// returned Promise is awaited.)
//
// Implementation (mirrors a REPL, two construction-time-checked attempts):
//   1. expression mode: compile `return (<script>)` — auto-returns a lone
//      expression (incl. an await-expression), preserving last-expression value.
//   2. on SyntaxError from (1)'s CONSTRUCTION: statement mode — compile
//      `<script>` as the async body directly, legalizing top-level return +
//      await + arbitrary statements.
// Only a construction-time SyntaxError advances attempt 1 -> 2, so user code is
// compiled once and executed at most once (no double side effects). We never use
// `eval`: indirect eval ran the body as a global program, which is precisely
// what banned top-level return/await and produced the doc-vs-reality gap.
//
// try/catch maps errors:
//   SyntaxError (both attempts fail to compile) -> 'script-syntax-error'
//   RemoteError (re-thrown)                      -> verbatim
//   anything else                                -> 'script-runtime-error'
//
// The sandbox is dismantled — eval is full-access, no wrapReadOnly.
// Timeout is removed (route B has no interrupt mechanism; see R6).

import { RemoteError } from './errors';

// AsyncFunction constructor (not a global binding). An async body is what
// legalizes top-level `await` AND top-level `return` simultaneously.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as FunctionConstructor;

/** Live eval roots; the introspect document and server options derive from this list. */
export type ExecuteContext = {
  readonly world: unknown;
  readonly renderer: unknown;
  readonly assets: unknown;
  /** Host-owned RHI capture capability; undefined when FORGEAX_ENGINE_RHI_DEBUG !== '1'. */
  readonly rhiCapture?: unknown;
  /** Host-owned simulation operations and realm Context; Remote owns neither. */
  readonly simulation?: unknown;
  /** Explicit CPU profiler capability; omitted unless the host opts in. */
  readonly profiler?: unknown;
  /** Structural report provider; remote never imports the App owner. */
  readonly execution?: unknown;
  /** Read-only projection of the live plugin Entry/Fiber tree. */
  readonly plugins?: unknown;
  /** Resolve modules in the owning Host realm, using the existing eval seam. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
};

export type ExecuteResult = { ok: true; value: unknown } | { ok: false; error: RemoteError };

// Capture import at module load time. This is the host realm's dynamic
// import() — when injected into new Function, it resolves module
// specifiers relative to the module that called executeScript. The remote
// package stays package-neutral: a host may inject a capability projection
// through ExecuteContext.importModule, but the transport does not own any
// engine package vocabulary.
const _import = async (specifier: string): Promise<unknown> => import(/* @vite-ignore */ specifier);

// Compile the script as an async function body. Tries expression mode first
// (auto-return a lone expression), falling back to statement mode on a
// construction-time SyntaxError. Returns the compiled fn, or throws the
// statement-mode SyntaxError if BOTH modes fail to parse.
function compile(script: string): FunctionConstructor['prototype'] {
  const params = [
    'world',
    'renderer',
    'assets',
    'rhiCapture',
    'simulation',
    'profiler',
    'execution',
    'plugins',
    '_import',
  ] as const;
  try {
    // Expression mode: `return (<expr>)` auto-returns a lone expression
    // (including an await-expression), preserving last-expression-value.
    // Trailing semicolons/whitespace are trimmed so `renderer.backend;`
    // still returns its value (the old indirect-eval completion-value
    // behavior) instead of parsing as a statement that returns undefined.
    const expr = script.replace(/[\s;]+$/, '');
    return new AsyncFunction(...params, `return (${expr}\n)`);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    // Statement mode: the script IS the async body — legalizes top-level
    // return + await + arbitrary statements. If this also fails to parse,
    // its SyntaxError is the authoritative one to surface.
    return new AsyncFunction(...params, script);
  }
}

/**
 * Evaluate a JavaScript script against the host engine context.
 *
 * Route B (D-1): host-realm compilation via the AsyncFunction constructor with
 * injected _import. The script is the body of an async function; a lone
 * expression is auto-returned, and top-level `await` / `return` are legal.
 *   - _import is available as a parameter for dynamic ESM imports.
 *   - rhiCapture is available as a 4th eval-scope root for the RHI capture
 *     capability (plan-strategy D-4).
 *   - No sandbox — full access reads and writes.
 *   - No timeout — host realm eval cannot be interrupted (see R6).
 */
export async function executeScript(script: string, ctx: ExecuteContext): Promise<ExecuteResult> {
  try {
    const fn = compile(script);
    // AsyncFunction always returns a Promise; await resolves the value and
    // surfaces any runtime throw into this catch.
    const value: unknown = await fn(
      ctx.world,
      ctx.renderer,
      ctx.assets,
      ctx.rhiCapture,
      ctx.simulation,
      ctx.profiler,
      ctx.execution,
      ctx.plugins,
      ctx.importModule ?? _import,
    );

    return { ok: true, value };
  } catch (e) {
    // 1. RemoteError re-thrown from within the script surfaces verbatim.
    if (e instanceof RemoteError) {
      return { ok: false, error: e };
    }

    // 2. SyntaxError: both compile() attempts failed to parse the script.
    if (e instanceof SyntaxError) {
      const msg = e.message;
      return {
        ok: false,
        error: new RemoteError({
          code: 'script-syntax-error',
          expected: 'script body is valid JavaScript',
          hint: `check syntax near: ${msg}; fix and resubmit`,
        }),
      };
    }

    // 3. Runtime error (throws during function execution).
    const rawMessage = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: new RemoteError({
        code: 'script-runtime-error',
        expected: 'script executes without throwing',
        hint: `inspect error; verify symbol availability; eval has full access to world/renderer/assets (errMessage: ${rawMessage})`,
      }),
    };
  }
}
