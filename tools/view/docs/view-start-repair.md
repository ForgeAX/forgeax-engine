# View Start Repair Plan

## Status

The immediate `Search` import regression is fixed on `main`
(`fix(material): import missing Search icon in MaterialPanel`). This document
remains as the runbook for the failure class: a frontend render exception that
blocks the shell ready predicate.

## Scope

This repair belongs in `forgeax-view`.

Do not change the `Forgeax-engine` startup chain to work around this failure.
The CLI command discovery path works after the project uses an Engine version
that supports `--command-contract`, and the resident owner cleans itself up after
the failed start. The observed failure is in the View frontend ready path.

## Observed Failure

The end-to-end flow reaches `view start`, launches the owner, and loads the View
page. The page then throws during frontend rendering:

```text
ReferenceError: Search is not defined
> MaterialPanel ... forgeax-view ... chunk-HAFRQFDP.mjs:106:30
```

After that render failure, the owner waits for the shell ready predicate until:

```text
page.waitForFunction: Timeout 120000ms exceeded.
```

The public CLI result is:

```json
{
  "ok": false,
  "command": "view start",
  "error": {
    "code": "executor-threw",
    "hint": "View startup failed; inspect .../owner.log"
  }
}
```

`view status --json` then reports:

```json
{
  "ok": true,
  "value": {
    "active": []
  }
}
```

`view stop --json` returns `ok:true` with `stopped:false` because no active owner
remains after the failed start.

## Expected Flow

From the workspace root, create and initialize a temporary game project:

```bash
pnpm exec forgeax project new --root ./codex-view-test --template empty
pnpm exec forgeax project init --root ./codex-view-test
```

Install and register View from the game project:

```bash
cd ./codex-view-test
pnpm add @forgeax/view
pnpm exec forgeax project plugin install --id forgeax.view --module @forgeax/view/commands --realm build --command-contract @forgeax/view/commands
cd ..
```

The command tree must expose the View commands:

```bash
pnpm exec forgeax help --tree --json
```

Expected command paths:

```text
view start
view status
view stop
```

Start the resident owner:

```bash
pnpm exec forgeax view start --root ./codex-view-test --software --json
```

Expected result:

```json
{
  "ok": true,
  "value": {
    "phase": "ready",
    "pid": 12345,
    "url": "http://127.0.0.1:..."
  }
}
```

Then inspect and stop it:

```bash
pnpm exec forgeax view status --root ./codex-view-test --json
pnpm exec forgeax view stop --root ./codex-view-test --json
pnpm exec forgeax view status --root ./codex-view-test --json
```

Expected results:

- `status` while running returns `ok:true` and `value.active` has exactly one
  entry for the project.
- The active entry `url` has no query string and exposes no bearer token or
  connection material.
- `stop` returns `ok:true` and `value.stopped:true`.
- Final `status` returns `ok:true` and `value.active: []`.

## Fix Direction

Find the `MaterialPanel` implementation and resolve every icon/component it
uses through explicit imports or existing local component exports. The known
missing binding was `Search`.

### What catches this class of bug — and what does not

A missing import binding is a **runtime-only** failure for this toolchain:

- `pnpm run build` does **not** catch it: Vite/Rolldown does not type-check,
  and an unbound identifier is not an unresolved module specifier.
- `pnpm test` does **not** catch it: no test renders the plugin panels.
- `pnpm check:components` did **not** catch it: type-checking historically
  covered only `@forgeax/view-components`, which is how the regression reached
  `main`.

The reliable gates are:

1. `pnpm check:packages` — `tsc --noEmit` across every package with TypeScript
   sources. An unbound identifier is a static error (`TS2304`/`TS2552`). This
   now runs in CI; keep it green and extend it when new packages gain `.ts` /
   `.tsx` sources.
2. The end-to-end flow above — the final acceptance gate.

Do not treat a green build/test as proof of repair for this failure class.

### Keep the ready predicate fail-closed

A panel crash must still prevent the shell from reporting ready. Weakening the
ready predicate (for example, swallowing panel errors behind an error boundary
that reports ready anyway) would make `view start` succeed with a degraded UI
and would blind the end-to-end gate to future regressions of the same class.

The acceptable hardening is to fail **faster and clearer**, not softer: while
waiting for the ready predicate, the owner should also watch for page
exceptions (`pageerror` / console errors) and abort immediately with the real
frontend error instead of waiting out the full 120s timeout. The gate stays
fail-closed; only the diagnosis latency changes.

### Regression coverage is part of the fix

Per repository convention, every bug fix must land with CI coverage that would
have caught it. For this class, the coverage is the workspace-wide type check
above plus, where practical, a unit test that imports the touched panel module
so missing bindings fail in `pnpm test` as well.

Recommended checks while implementing:

```bash
rg -n "function MaterialPanel|const MaterialPanel|<Search|Search\b" src packages
pnpm check:packages
pnpm run build
pnpm test
```

After fixing, rerun the end-to-end View flow above. Treat the repair as complete
only when `view start`, `view status`, and `view stop` all return `ok:true` and
the final status is empty.

## Non-goals

- Do not add `link:` overrides to the game project or either repository.
- Do not change `forgeax dev start --view`; that option is not part of the
  current supported flow.
- Do not bypass or weaken the View frontend ready predicate — neither in Engine
  startup, DevKit owner logic, nor by letting the shell report ready while a
  panel crashed.
- Do not expose workspace endpoint tokens, bearer tokens, debugger URLs, or any
  other connection material in `view status`.
