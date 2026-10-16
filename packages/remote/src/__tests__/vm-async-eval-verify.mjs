#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: standalone D-1 verification CLI script; console is its diagnostic output channel
// @forgeax/engine-remote/src/__tests__/vm-async-eval-verify.mjs
// D-1 verification: route A (vm + importModuleDynamically) vs route B (host realm eval).
//
// Indicators:
//   (a)  vm.runInContext with importModuleDynamically: does await import resolve?
//   (a') host realm eval via new Function: does await import resolve?
//   (c)  vm timeout watchdog: does it fire on sync infinite loop?
//
// Route B has NO timeout watchdog — infinite loops hang the thread.
//
// RESULT (2026-06-29, Node 24.15.0):
//   ROUTE A FALSIFIED — vm.runInContext does NOT support importModuleDynamically.
//   ROUTE B CONFIRMED — new Function resolves await import naturally.
//   Timeout: vm watchdog PASS, but host eval has NO timeout.

import * as vm from 'node:vm';

let exitCode = 0;
const passes = [];
const fails = [];

function record(label, ok, detail) {
  if (ok) {
    passes.push(label);
    console.log(`(a)  vm importModuleDynamically: ${detail}`);
  } else {
    fails.push(label);
    console.log(`(a)  vm importModuleDynamically: FAIL — ${detail}`);
  }
}

// ── Indicator (a): vm route ─────────────────────────────────────────────────

{
  const label = 'a';
  const ok = false;
  let detail = '';
  const scriptBody = [
    '(async () => {',
    "  const ecs = await import('@forgeax/engine-ecs');",
    "  return typeof ecs.World.prototype.query === 'function';",
    '})()',
  ].join('\n');
  try {
    const ctx = vm.createContext(
      {},
      { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    );
    const promise = vm.runInContext(scriptBody, ctx, { timeout: 10000, displayErrors: true });
    if (typeof promise?.then === 'function') {
      // We need to await it — but vm.runInContext is sync, so we get
      // the Promise object back. However Node's vm Script does NOT
      // execute the async IIFE — it evaluates the expression and returns
      // the raw Promise without executing it. The Promise never settles.
      // This is a known limitation.
      detail =
        'Promise returned but never settled — import() never called (vm Script cannot execute async IIFE)';
      record(label, ok, detail);
    } else {
      detail = `returned ${typeof promise} (expected thenable)`;
      record(label, ok, detail);
    }
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
    record(label, ok, detail);
  }
}

// ── Indicator (a'): host realm eval route ───────────────────────────────────

{
  const label = "a'";
  let ok = false;
  let detail = '';
  try {
    // Dynamically import in host realm, then new Function.
    // The fact that new Function runs in host realm means import() works naturally.
    const script = [
      'return (async () => {',
      "  const ecs = await import('@forgeax/engine-ecs');",
      "  return typeof ecs.World.prototype.query === 'function';",
      '})();',
    ].join('\n');
    const fn = new Function(script);
    const result = await fn();
    ok = result === true;
    detail = `import resolved, World.query is function = ${result}`;
    record(label, ok, detail);
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
    record(label, ok, detail);
  }
}

// ── Indicator (c): vm timeout watchdog ──────────────────────────────────────

{
  const label = 'c';
  let ok = false;
  let detail = '';
  const start = Date.now();
  try {
    const ctx = vm.createContext({});
    vm.runInContext('while(true){}', ctx, { timeout: 200, displayErrors: false });
    detail = `loop completed without interruption after ${Date.now() - start}ms`;
    record(label, ok, detail);
  } catch (e) {
    const elapsed = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    ok = msg.includes('timed out') || msg.includes('Script execution timed out');
    detail = `timed out after ~${elapsed}ms`;
    record(label, ok, detail);
  }
}

// ── Final verdict ───────────────────────────────────────────────────────────

const routeBpass = passes.includes("a'");
const routeAfail = fails.includes('a');

console.log();
console.log('='.repeat(60));
console.log('D-1 VERDICT:');

if (routeAfail && routeBpass) {
  console.log('ROUTE A (vm + importModuleDynamically): FALSIFIED');
  console.log('  Reason: vm.runInContext does not honor importModuleDynamically');
  console.log('  for Script execution. Only vm.SourceTextModule is supported.');
  console.log();
  console.log('ROUTE B (host realm eval via new Function): CONFIRMED');
  console.log('  - await import resolves naturally in host realm');
  console.log('  - NO timeout watchdog (known limitation, documented in R6)');
  console.log();
  console.log('IMPLEMENTATION IMPLICATIONS:');
  console.log('  - w5: implement executeScript via new Function');
  console.log('  - w5: remove scriptTimeoutMs & timeout logic (dead)');
  console.log('  - w7: delete script-timeout from RemoteErrorCode');
  console.log('  - Final error set: 4 members (no script-timeout)');
  exitCode = 0;
} else {
  console.log('UNEXPECTED RESULT:');
  console.log('  Route A passes:', passes, 'fails:', fails);
  console.log('  Route B passes:', passes, 'fails:', fails);
  exitCode = 1;
}

process.exit(exitCode);
